import * as THREE from 'three';
import type { ExactShadowIndex } from './ExactShadowGeometry';
import type { DistanceDetailPack } from './DistanceDetailGeometry';
import { StreamResourceCache } from './StreamResources';
import { MainThreadWorkBudget } from './MainThreadWorkBudget';
import { markImmutableStreamSource, markStaticStreamSource, releaseImmutableStreamSource } from './ImmutableStreamSources';
import { markStreamFrustumOnlySource } from './StreamRenderPolicy';
import type { StreamBounds, StreamChunkData, StreamChunkDefinition, StreamManifest, StreamResourceCacheInterface, WorldResidencyChange, WorldStreamingView } from './WorldStreamTypes';

interface ChunkState {
  definition:StreamChunkDefinition;status:'loading'|'resident';controller:AbortController;
  group:THREE.Group;meshes:THREE.Mesh[];registered:number;geometryIds:number[];materialIds:number[];released:boolean;
}
export interface SpatialWorldStreamOptions {
  distanceDetail?:DistanceDetailPack;
  shadowIndices?:readonly ExactShadowIndex[];
  /** Route unchanged ordinary batches through the same spatial shadow journal. */
  instanceSingletons?:boolean;
  readJSON:(url:string,signal?:AbortSignal)=>Promise<unknown>;
  readBinary:(url:string,signal?:AbortSignal)=>Promise<ArrayBuffer>;
  onChange:(change:WorldResidencyChange)=>void;
  prepareChunk?:(group:THREE.Group,signal:AbortSignal)=>Promise<void>;
  resourceCache?:StreamResourceCacheInterface;
  commitBudgetMs?:number;
  concurrentChunks?:number;
}
const cancelled=()=>new DOMException('Landscape request was cancelled.','AbortError');
const isCancellation=(error:unknown)=>error instanceof Error&&error.name==='AbortError';
export function distanceToStreamBounds(bounds:StreamBounds,point:{x:number;y:number;z:number}):number {
  const dx=Math.max(bounds[0]-point.x,0,point.x-bounds[3]),dy=Math.max(bounds[1]-point.y,0,point.y-bounds[4]),dz=Math.max(bounds[2]-point.z,0,point.z-bounds[5]);
  return Math.hypot(dx,dy,dz);
}
/** Conservative horizontal footprint swept from every caster down to the lowest
 * authored receiver. This includes upstream casters outside the beauty range. */
export function shadowFootprintDistance(bounds:StreamBounds,point:{x:number;z:number},receiverFloor:number):number {
  const travel=Math.max(0,bounds[4]-receiverFloor)/.58;
  const minX=bounds[0],maxX=bounds[3]+travel*.48,minZ=bounds[2],maxZ=bounds[5]+travel*.65;
  return Math.hypot(Math.max(minX-point.x,0,point.x-maxX),Math.max(minZ-point.z,0,point.z-maxZ));
}

/** Small shared fetch queue bounds simultaneous temporary binary allocations. */
export class StreamFetchQueue {
  private running=0;
  private readonly waiting:{run:()=>void;signal?:AbortSignal;reject:(reason:unknown)=>void;abort:()=>void}[]=[];
  constructor(private readonly maximum=4){}
  run<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    if(signal?.aborted)return Promise.reject(cancelled());
    return new Promise<T>((resolve,reject)=>{
      const entry={signal,reject,abort:()=>{},run:()=>{
        signal?.removeEventListener('abort',entry.abort);this.running++;
        if(signal?.aborted){this.running--;reject(cancelled());this.pump();return;}
        Promise.resolve().then(operation).then(resolve,reject).finally(()=>{this.running--;this.pump();});
      }};
      entry.abort=()=>{const index=this.waiting.indexOf(entry);if(index>=0){this.waiting.splice(index,1);reject(cancelled());}};
      this.waiting.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});this.pump();
    });
  }
  private pump():void{while(this.running<this.maximum&&this.waiting.length)this.waiting.shift()!.run();}
}

/**
 * Exact source cells have real resource residency. Far eviction removes meshes,
 * unregisters their render proxies, then releases shared GPU/CPU resources.
 * Preloaded groups cannot draw before their material/culling registration hook.
 */
export class SpatialWorldStream {
  private readonly resources:StreamResourceCacheInterface;
  private readonly states=new Map<string,ChunkState>();
  private readonly failed=new Map<string,Error>();
  private active=new Set<string>();
  private required=new Set<string>();
  private readonly readinessBounds=new THREE.Box3();
  private preload=new Set<string>();
  private priorities=new Map<string,number>();
  private readonly pinned=new Set<string>();
  private preparationStarted=false;
  private preparationRequest:{promise:Promise<void>;resolve:()=>void;reject:(error:Error)=>void}|null=null;
  private running=0;
  private disposed=false;
  private requestPromise:Promise<void>|null=null;
  private resolveRequest:(()=>void)|null=null;
  private rejectRequest:((error:Error)=>void)|null=null;
  private requests=0;
  private loads=0;
  private evictions=0;
  private residentSourceObjects=0;
  private residentTriangles=0;
  private residentPlacements=0;
  private residentBatches=0;
  private peakResidentGeometryBytes=0;
  private lastView:WorldStreamingView|null=null;
  private readonly receiverFloor:number;
  private readonly commitBudget:MainThreadWorkBudget;
  private registrationSlices=0;
  private peakRegistrationSliceMs=0;

  constructor(readonly manifest:StreamManifest,private readonly root:THREE.Group,private readonly options:SpatialWorldStreamOptions){
    if(manifest.version!==1||!manifest.complete||manifest.cellSize!==160)throw new Error('The spatial landscape pack is incomplete.');
    this.commitBudget=new MainThreadWorkBudget(options.commitBudgetMs??3);
    this.resources=options.resourceCache??new StreamResourceCache(manifest,{readBinary:options.readBinary,shadowIndices:options.shadowIndices,distanceDetail:options.distanceDetail,preparationBudget:this.commitBudget});
    this.receiverFloor=Math.min(...manifest.chunks.map(chunk=>chunk.bounds[1]));
  }
  get isViewReady():boolean{return !this.disposed&&this.active.size>0&&[...this.required].every(id=>this.states.get(id)?.status==='resident');}
  whenReady():Promise<void>{
    if(this.disposed)return Promise.reject(cancelled());
    const failure=[...this.required].map(id=>this.failed.get(id)).find(Boolean);if(failure)return Promise.reject(failure);
    if(this.isViewReady)return Promise.resolve();
    if(!this.requestPromise){
      this.requestPromise=new Promise<void>((resolve,reject)=>{this.resolveRequest=resolve;this.rejectRequest=reject;});
      // Loading can begin before the caller requests the barrier. Its eventual
      // rejection is still returned by whenReady(), without an unhandled event.
      void this.requestPromise.catch(()=>{});
    }
    return this.requestPromise;
  }
  /** Pin fully constructed/prepared cells; normal camera readiness stays separate.
   * Replacing the target cancels the previous barrier. A zero fraction unpins.
   * Globals take priority; a nonzero target always includes every global cell. */
  prepareFraction(fraction:number,center?:{x:number;y:number;z:number}):Promise<void>{
    if(this.disposed)return Promise.reject(cancelled());
    if(!Number.isFinite(fraction)||fraction<0||fraction>1)return Promise.reject(new Error('Landscape preparation fraction must be between zero and one.'));
    const origin=center??this.lastView?.position;
    if(!origin||![origin.x,origin.y,origin.z].every(Number.isFinite))return Promise.reject(new Error('Landscape preparation requires a finite center or an existing streaming view.'));
    const ranked=this.manifest.chunks.map(chunk=>({chunk,distance:distanceToStreamBounds(chunk.bounds,origin)}))
      .sort((a,b)=>Number(b.chunk.global)-Number(a.chunk.global)||a.distance-b.distance||(a.chunk.id<b.chunk.id?-1:a.chunk.id>b.chunk.id?1:0));
    const count=fraction===0?0:Math.max(Math.ceil(this.manifest.chunks.length*fraction),this.manifest.chunks.filter(chunk=>chunk.global).length);
    const selected=ranked.slice(0,count).map(entry=>entry.chunk.id);
    const unchanged=selected.length===this.pinned.size&&selected.every(id=>this.pinned.has(id));
    if(unchanged&&this.preparationRequest)return this.preparationRequest.promise;
    this.preparationRequest?.reject(cancelled());
    this.preparationRequest=null;this.pinned.clear();for(const id of selected)this.pinned.add(id);
    this.preparationStarted=true;
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    this.preparationRequest={promise,resolve,reject};void promise.catch(()=>{});
    if(this.lastView)this.update(this.lastView);
    else{
      this.preload=new Set(selected);this.priorities=new Map(selected.map((id,index)=>[id,index]));
      for(const state of [...this.states.values()])if(!this.pinned.has(state.definition.id))this.unload(state);
      this.settleReadiness();this.pump();
    }
    return promise;
  }
  update(view:WorldStreamingView):void{
    if(this.disposed)return;
    if(![view.position.x,view.position.y,view.position.z,view.altitude].every(Number.isFinite))throw new Error('Invalid landscape streaming view.');
    const base=Math.max(30,view.baseDistance??300),altitude=Math.max(0,view.altitude),visible=view.viewDistance??Math.hypot(base,altitude);
    if(!Number.isFinite(visible)||visible<=0)throw new Error('Invalid landscape viewing distance.');
    const preloadRadius=visible+300,releaseRadius=visible+500;
    const velocity=view.velocity??{x:0,y:0,z:0},speed=Math.hypot(velocity.x,velocity.y,velocity.z);
    const forward=view.forward??{x:0,y:0,z:0},forwardLength=Math.hypot(forward.x,forward.y,forward.z);
    // A teleport is not a velocity prediction. Keep the current request local
    // and let the explicit readiness barrier guard its first visible frame.
    const useVelocity=Number.isFinite(speed)&&speed>1&&speed<300;
    const lead=useVelocity?{x:velocity.x*4,y:velocity.y*4,z:velocity.z*4}:forwardLength>0?{x:forward.x/forwardLength*base*.7,y:forward.y/forwardLength*base*.7,z:forward.z/forwardLength*base*.7}:{x:0,y:0,z:0};
    const predicted={x:view.position.x+lead.x,y:view.position.y+lead.y,z:view.position.z+lead.z};
    const active=new Set<string>(),required=new Set<string>(),preload=new Set<string>(),retention=new Set<string>(),priorities=new Map<string,number>();
    const readinessMargin=Math.max(40,visible*.05);
    for(const chunk of this.manifest.chunks){
      const current=Math.min(distanceToStreamBounds(chunk.bounds,view.position),shadowFootprintDistance(chunk.bounds,view.position,this.receiverFloor));
      const future=Math.min(distanceToStreamBounds(chunk.bounds,predicted),shadowFootprintDistance(chunk.bounds,predicted,this.receiverFloor));
      if(chunk.global||current<=visible){
        active.add(chunk.id);
        if(chunk.global||!view.frustum)required.add(chunk.id);
        else{
          // This changes only the first-visible-frame barrier, never residency
          // or rendering. Enclose the original cell and every sun ray down to
          // the world's lowest receiver, including off-screen shadow casters.
          // The generous border covers shadow filtering and cascade/bias guards.
          const bounds=chunk.bounds,travel=Math.max(0,bounds[4]-this.receiverFloor)/.58;
          this.readinessBounds.min.set(bounds[0]-readinessMargin,Math.min(bounds[1],this.receiverFloor)-readinessMargin,bounds[2]-readinessMargin);
          this.readinessBounds.max.set(bounds[3]+travel*.48+readinessMargin,bounds[4]+readinessMargin,bounds[5]+travel*.65+readinessMargin);
          if(view.frustum.intersectsBox(this.readinessBounds))required.add(chunk.id);
        }
      }
      if(chunk.global||this.pinned.has(chunk.id)||Math.min(current,future)<=preloadRadius)preload.add(chunk.id);
      if(chunk.global||this.pinned.has(chunk.id)||Math.min(current,future)<=releaseRadius)retention.add(chunk.id);
      priorities.set(chunk.id,(chunk.global?-3e9:required.has(chunk.id)?-2e9:active.has(chunk.id)?-1e9:this.pinned.has(chunk.id)?-5e8:0)+Math.min(current,future));
    }
    this.lastView={...view,position:{...view.position}};this.active=active;this.required=required;this.preload=preload;this.priorities=priorities;this.requests++;
    for(const state of [...this.states.values()]){
      if(!retention.has(state.definition.id)){this.unload(state);continue;}
    }
    this.settleReadiness();this.pump();
  }
  private pump():void{
    if(this.disposed)return;
    const pending=this.manifest.chunks.filter(chunk=>this.preload.has(chunk.id)&&!this.states.has(chunk.id)&&!this.failed.has(chunk.id)).sort((a,b)=>this.priorities.get(a.id)!-this.priorities.get(b.id)!);
    while(this.running<(this.options.concurrentChunks??2)&&pending.length){
      const definition=pending.shift()!,group=new THREE.Group();group.name=`${definition.biomeId} · streamed ${definition.id}`;group.visible=false;group.matrixAutoUpdate=false;group.userData={biomeId:definition.biomeId,streamChunkId:definition.id};
      const state:ChunkState={definition,status:'loading',controller:new AbortController(),group,meshes:[],registered:0,geometryIds:[],materialIds:[],released:false};this.states.set(definition.id,state);this.running++;
      void this.loadChunk(state).catch(error=>{
        // A pinned request cannot be evicted by camera motion. An independent
        // loader/preparation AbortError must reject its barrier, not retry forever.
        if(!this.disposed&&(!isCancellation(error)||this.pinned.has(definition.id)&&!state.controller.signal.aborted)){
          this.failed.set(definition.id,error instanceof Error?error:new Error(String(error)));
        }
        this.unload(state);
      }).finally(()=>{this.running--;this.settleReadiness();this.pump();});
    }
  }
  private async loadChunk(state:ChunkState):Promise<void>{
    const {definition,controller}=state,signal=controller.signal;
    const check=()=>{if(this.disposed||signal.aborted||this.states.get(definition.id)!==state)throw cancelled();};
    const data=await this.options.readJSON(definition.url,signal) as StreamChunkData;check();
    if(data.version!==1||data.id!==definition.id||data.batches.length!==definition.batches)throw new Error(`Invalid landscape cell ${definition.id}`);
    const geometries=new Map<number,THREE.BufferGeometry>(),materials=new Map<number,THREE.Material>();
    const resources:Promise<void>[]=[];
    for(const id of definition.geometryIds){state.geometryIds.push(id);resources.push(this.resources.acquireGeometry(id).then(value=>{geometries.set(id,value);}));}
    for(const id of definition.materialIds){state.materialIds.push(id);resources.push(this.resources.acquireMaterial(id).then(value=>{materials.set(id,value);}));}
    const [matrices]=await Promise.all([this.options.readBinary(data.matrices.url,signal),Promise.all(resources)]);check();
    if(matrices.byteLength!==data.matrices.bytes)throw new Error(`Incomplete instance transforms in ${definition.id}`);
    let triangles=0,sourceObjects=0,constructed=0;
    for(const batch of data.batches){
      let waiting;while((waiting=this.commitBudget.checkpoint())){await waiting;check();}
      const started=performance.now();
      check();const geometry=geometries.get(batch.geometryId),material=materials.get(batch.materialId);if(!geometry||!material)throw new Error('Landscape cell references an unacquired resource.');
      let mesh:THREE.Mesh;
      if(batch.isInstancedMesh){
        const instanced=new THREE.InstancedMesh(geometry,material,0);
        instanced.instanceMatrix=new THREE.InstancedBufferAttribute(new Float32Array(matrices,batch.matrixOffset,batch.count*16),16);
        instanced.count=batch.count;instanced.instanceMatrix.needsUpdate=true;
        instanced.boundingBox=new THREE.Box3(new THREE.Vector3().fromArray(batch.localBounds),new THREE.Vector3().fromArray(batch.localBounds,3));
        instanced.boundingSphere=new THREE.Sphere(new THREE.Vector3(...batch.boundingSphere.center),batch.boundingSphere.radius);mesh=instanced;
      }else{
        if(batch.count!==1)throw new Error('Ordinary streamed meshes must have one placement.');
        if(this.options.instanceSingletons){
          // The native ordinary path applies only modelMatrix. Its synthetic
          // instance stays identity: the transfer's unused matrix slot must not
          // introduce another transform or alter the original vertex data.
          const instanced=new THREE.InstancedMesh(geometry,material,1);
          instanced.instanceMatrix.needsUpdate=true;
          instanced.boundingBox=new THREE.Box3(new THREE.Vector3().fromArray(batch.localBounds),new THREE.Vector3().fromArray(batch.localBounds,3));
          instanced.boundingSphere=new THREE.Sphere(new THREE.Vector3(...batch.boundingSphere.center),batch.boundingSphere.radius);
          mesh=instanced;
        }else mesh=new THREE.Mesh(geometry,material);
      }
      mesh.name=batch.name;mesh.matrix.fromArray(batch.modelMatrix);mesh.matrixAutoUpdate=false;mesh.castShadow=batch.castShadow;mesh.receiveShadow=batch.receiveShadow;
      mesh.renderOrder=batch.renderOrder;mesh.layers.mask=batch.layers;mesh.frustumCulled=true;
      mesh.userData={...batch.userData,streamBatchId:batch.id,streamChunkId:definition.id};
      if(mesh instanceof THREE.InstancedMesh){
        markImmutableStreamSource(mesh);
        if(!batch.isInstancedMesh)markStreamFrustumOnlySource(mesh);
      }
      state.group.add(mesh);
      if(mesh instanceof THREE.InstancedMesh)markStaticStreamSource(mesh,state.group);
      state.meshes.push(mesh);sourceObjects+=batch.sourceObjects;
      triangles+=(geometry.index?.count??geometry.getAttribute('position').count)/3*batch.count;
      this.commitBudget.charge(performance.now()-started);
      // Rotate ready chunk continuations before this one can consume another
      // frame's shared budget. This is one yield per group, never per vertex.
      if((++constructed&7)===0){await Promise.resolve();check();}
    }
    if(triangles!==definition.triangles||sourceObjects!==definition.sourceObjects)throw new Error(`Landscape transfer count changed in ${definition.id}`);
    check();this.root.add(state.group);state.group.updateMatrixWorld(true);
    // Proxy creation and its BVH construction were previously one unbounded
    // cell-sized task, after the yielding mesh-construction loop. Register small
    // slices under the same budget, keeping the whole parent hidden throughout.
    // Cancellation removes only the sources actually offered to the owner.
    for(let offset=0;offset<state.meshes.length;offset+=8){
      let waiting;while((waiting=this.commitBudget.checkpoint())){await waiting;check();}
      check();const end=Math.min(offset+8,state.meshes.length),started=performance.now();
      state.registered=end;
      this.options.onChange({added:state.meshes.slice(offset,end),removed:[],materials:offset===0?[...materials.values()]:[]});
      const elapsed=performance.now()-started;this.commitBudget.charge(elapsed);
      this.registrationSlices++;this.peakRegistrationSliceMs=Math.max(this.peakRegistrationSliceMs,elapsed);check();
      if(end<state.meshes.length){await Promise.resolve();check();}
    }
    // Compile new material/layout variants while this whole cell is hidden.
    // Its resource leases stay alive until preparation completes or is aborted.
    if(this.options.prepareChunk){await this.options.prepareChunk(state.group,signal);check();}
    // Loaded upstream geometry remains available to the shadow passes. Beauty
    // camera clipping and the exact instance range handle its visual distance.
    state.status='resident';state.group.visible=true;this.loads++;
    this.residentSourceObjects+=definition.sourceObjects;this.residentTriangles+=definition.triangles;this.residentPlacements+=definition.placements;this.residentBatches+=definition.batches;
    this.peakResidentGeometryBytes=Math.max(this.peakResidentGeometryBytes,this.resources.stats.geometryBytes);
    this.options.onChange({added:[],removed:[],materials:[],visibilityChanged:true});
  }
  private unload(state:ChunkState):void{
    if(state.released)return;state.released=true;state.controller.abort();
    for(const mesh of state.meshes)if(mesh instanceof THREE.InstancedMesh)releaseImmutableStreamSource(mesh);
    if(this.states.get(state.definition.id)===state)this.states.delete(state.definition.id);
    if(state.group.parent){
      this.options.onChange({added:[],removed:state.meshes.slice(0,state.registered),materials:[]});state.group.removeFromParent();
    }
    if(state.status==='resident'){
      this.evictions++;this.residentSourceObjects-=state.definition.sourceObjects;this.residentTriangles-=state.definition.triangles;
      this.residentPlacements-=state.definition.placements;this.residentBatches-=state.definition.batches;
    }
    for(const mesh of state.meshes)if(mesh instanceof THREE.InstancedMesh)mesh.dispose();
    state.group.clear();state.meshes.length=0;
    for(const id of state.geometryIds)this.resources.releaseGeometry(id);
    for(const id of state.materialIds)this.resources.releaseMaterial(id);
    state.geometryIds.length=0;state.materialIds.length=0;
  }
  private settleReadiness():void{
    // The caller deliberately holds rendering while visible geometry is not
    // ready. Use more of that otherwise-idle frame to finish the barrier, then
    // immediately restore the normal small budget before rendering resumes.
    // An explicit test/embedding budget remains authoritative.
    const error=[...this.required].map(id=>this.failed.get(id)).find(Boolean);
    if(error){this.rejectRequest?.(error);this.resetReadiness();}
    else if(this.isViewReady){this.resolveRequest?.();this.resetReadiness();}
    if(this.preparationRequest){
      let complete=true,failure:Error|undefined;
      for(const id of this.pinned){
        failure??=this.failed.get(id);
        if(this.states.get(id)?.status!=='resident')complete=false;
      }
      if(failure){this.preparationRequest.reject(failure);this.preparationRequest=null;}
      else if(complete){this.preparationRequest.resolve();this.preparationRequest=null;}
    }
    this.commitBudget.setLimit(this.options.commitBudgetMs??(this.isViewReady&&!this.preparationRequest?3:12));
  }
  private resetReadiness():void{this.requestPromise=null;this.resolveRequest=null;this.rejectRequest=null;}
  get stats(){
    const resources=this.resources.stats;let activeChunks=0,activeTriangles=0,visiblePending=0,activePending=0,residentChunks=0,preparedResidentChunks=0;
    const biomeIds=new Set<string>();
    for(const state of this.states.values())if(state.status==='resident'){residentChunks++;biomeIds.add(state.definition.biomeId);if(this.active.has(state.definition.id)){activeChunks++;activeTriangles+=state.definition.triangles;}}
    for(const id of this.active)if(this.states.get(id)?.status!=='resident')activePending++;
    for(const id of this.required)if(this.states.get(id)?.status!=='resident')visiblePending++;
    for(const id of this.pinned)if(this.states.get(id)?.status==='resident')preparedResidentChunks++;
    return{enabled:true,ready:this.isViewReady,visiblePending,activePending,requiredChunks:this.required.size,residentChunks,activeChunks,preloadChunks:this.preload.size,loadingChunks:this.running,totalChunks:this.manifest.chunks.length,
      residentSourceObjects:this.residentSourceObjects,residentTriangles:this.residentTriangles,residentPlacements:this.residentPlacements,residentBatches:this.residentBatches,
      activeTriangles,authoredSourceObjects:this.manifest.sourceObjects,authoredTriangles:this.manifest.triangles,loadedBiomeIds:[...biomeIds],
      ...resources,peakResidentGeometryBytes:this.peakResidentGeometryBytes,loads:this.loads,evictions:this.evictions,requests:this.requests,
      registrationSlices:this.registrationSlices,peakRegistrationSliceMs:this.peakRegistrationSliceMs,
      preparationBudgetMs:this.commitBudget.limit,
      preparedTargetChunks:this.pinned.size,preparedResidentChunks,pinnedChunks:this.pinned.size,
      preparationComplete:this.preparationStarted&&!this.disposed&&preparedResidentChunks===this.pinned.size,
      baseDistance:this.lastView?.baseDistance??300,viewDistance:this.lastView?.viewDistance??300,preloadLeadSeconds:4,
      errors:[...this.failed].map(([id,error])=>({id,message:error.message})),geometryReduced:false,actualResourceEviction:true,upstreamShadowCoverage:true};
  }
  dispose():void{
    if(this.disposed)return;this.disposed=true;
    for(const state of [...this.states.values()])this.unload(state);
    this.resources.dispose();this.rejectRequest?.(cancelled());this.resetReadiness();
    this.preparationRequest?.reject(cancelled());this.preparationRequest=null;
  }
}
