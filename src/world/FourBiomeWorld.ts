import * as THREE from 'three';
import { loadExactShadowIndexPack } from './ExactShadowGeometry';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { detachImportedScene } from './detachImportedScene';
import { mergeCoinstancedBatches, type SourceInstance, type StaticBatch } from './mergeCoinstancedBatches';
import { freezeStaticLocalMatrices } from './freezeStaticLocalMatrices';
import { SpatialWorldStream, StreamFetchQueue } from './SpatialWorldStream';
import { WorldPreloadCache } from './WorldPreloadCache';
import { worldViewPolicy } from '../core/WorldViewPolicy';
import { loadDistanceDetailPack } from './DistanceDetailGeometry';
import { fetchWorldAsset } from './fetchWorldAsset';
import type { StreamChunkData, StreamManifest, WorldResidencyChange, WorldStreamingView } from './WorldStreamTypes';
export type { WorldResidencyChange, WorldStreamingView } from './WorldStreamTypes';

export interface WorldBounds { minX:number;maxX:number;minZ:number;maxZ:number }
export interface BiomeDefinition {
  id:string;label:string;region:string;bounds:WorldBounds;center:{x:number;z:number};url:string;landmark:string;
  review:{camera:[number,number,number];target:[number,number,number];aircraft:[number,number,number]};
  source:{objects:number;triangles:number};
}
export interface WorldManifest {
  version:1;name:string;bounds:WorldBounds;waterLevel:number;
  terrain:{url:string;columns:number;rows:number;cellSize:number;minX:number;minZ:number};
  biomes:BiomeDefinition[];
}
export interface TerrainData {
  columns:number;rows:number;cellSize:number;minX:number;minZ:number;heights:number[];diagonal:'a-d-b';
}
interface BiomeTransfer { id:string;sourceObjects:number;sourceTriangles:number;renderedTriangles:number;renderBatches:number }

const SPATIAL_CELL_SIZE=160;
const INITIAL_STREAM_DISTANCE=300;
const inside=(bounds:WorldBounds,x:number,z:number):boolean=>x>=bounds.minX&&x<=bounds.maxX&&z>=bounds.minZ&&z<=bounds.maxZ;
const triangles=(geometry:THREE.BufferGeometry):number=>(geometry.index?.count??geometry.getAttribute('position').count)/3;
const abortError=():DOMException=>new DOMException('Environment loading was cancelled.','AbortError');

/** Four authored Blender regions. Spatial batching shares data without dropping source detail. */
export class FourBiomeWorld {
  readonly root=new THREE.Group();
  readonly biomeDefinitions:readonly BiomeDefinition[];
  private readonly heights:Float32Array;
  private readonly geometries=new Set<THREE.BufferGeometry>();
  private readonly materials=new Set<THREE.Material>();
  private readonly textures=new Set<THREE.Texture>();
  private readonly loaded=new Map<string,THREE.Group>();
  private readonly transfers:BiomeTransfer[]=[];
  private readonly position=new THREE.Vector2();
  private ready=false;
  private disposed=false;
  private loadTimeMs=0;
  private releasedSourceGeometries=0;
  private streaming:SpatialWorldStream|null=null;
  private preloadCache:WorldPreloadCache|null=null;
  private preloadFailure:string|undefined;
  private preloadTimeMs=0;
  private readonly lifetime=new AbortController();
  renderRevision=0;
  onResidencyChange:((change:WorldResidencyChange)=>void)|undefined;
  prepareChunkForRender:((group:THREE.Group,signal:AbortSignal)=>Promise<void>)|undefined;

  constructor(readonly manifest:WorldManifest,readonly terrain:TerrainData){
    if(manifest.version!==1||manifest.biomes.length!==4||new Set(manifest.biomes.map(b=>b.id)).size!==4)
      throw new Error('The world manifest must define four distinct biomes.');
    if(terrain.diagonal!=='a-d-b'||!Number.isInteger(terrain.columns)||!Number.isInteger(terrain.rows)||terrain.columns<2||terrain.rows<2||!(terrain.cellSize>0)||
      terrain.heights.length!==terrain.columns*terrain.rows||terrain.heights.some(value=>!Number.isFinite(value)))
      throw new Error('The environment ground data is incomplete.');
    for(const field of ['columns','rows','cellSize','minX','minZ'] as const)
      if(terrain[field]!==manifest.terrain[field])throw new Error(`The ground data does not match the world manifest (${field}).`);
    if(!Number.isFinite(manifest.waterLevel)||!Number.isFinite(terrain.minX)||!Number.isFinite(terrain.minZ))
      throw new Error('The environment elevation data is invalid.');
    this.biomeDefinitions=manifest.biomes;
    this.heights=Float32Array.from(terrain.heights);
    this.root.name=manifest.name;
    this.root.userData.worldVersion=manifest.version;
  }

  static async load(onProgress:(message:string)=>void=()=>{},signal?:AbortSignal):Promise<FourBiomeWorld>{
    const started=performance.now();
    const urlFor=(path:string):string=>new URL(path.replace(/^\//,''),document.baseURI).href;
    const read=async(path:string):Promise<Response>=>{
      const response=await fetchWorldAsset(urlFor(path),{signal});
      if(!response.ok)throw new Error(`Environment file unavailable (${response.status}): ${path.split('/').pop()}`);
      return response;
    };
    onProgress('PREPARING FOUR HORIZONS');
    const manifest=await (await read('/environments/world-manifest.json')).json() as WorldManifest;
    const terrain=await (await read(manifest.terrain.url)).json() as TerrainData;
    if(signal?.aborted)throw abortError();
    const world=new FourBiomeWorld(manifest,terrain);
    try{
      const packText=await (await read('/environments/stream/manifest.json')).text();
      const pack=JSON.parse(packText) as StreamManifest;
      const distanceDetail=new URLSearchParams(location.search).get('detail')==='full'?undefined:await loadDistanceDetailPack(packText,read);
      const acceleration=await loadExactShadowIndexPack(urlFor('/environments/shadow-indices/manifest.json'),packText,signal);
      if(signal?.aborted)throw abortError();
      const queue=new StreamFetchQueue(4);
      const streamedRead=async(path:string,requestSignal?:AbortSignal):Promise<Response>=>{
        const signals=[world.lifetime.signal,...(signal?[signal]:[]),...(requestSignal?[requestSignal]:[])];
        const response=await fetchWorldAsset(urlFor(path),{signal:AbortSignal.any(signals)});
        if(!response.ok)throw new Error(`Landscape resource unavailable (${response.status}): ${path.split('/').pop()}`);
        return response;
      };
      const readJSON=(path:string,requestSignal?:AbortSignal)=>queue.run(async()=>await(await streamedRead(path,requestSignal)).json(),requestSignal);
      const readBinary=(path:string,requestSignal?:AbortSignal)=>queue.run(async()=>await(await streamedRead(path,requestSignal)).arrayBuffer(),requestSignal);
      // Fractional residency acquires its selected cells directly. Do not also
      // retain the entire raw map cache while those cells own decoded buffers.
      const query=new URLSearchParams(location.search),residentPercent=worldViewPolicy(location.search).residentPercent;
      const residentPreparation=Number.isFinite(residentPercent)&&residentPercent>0&&residentPercent<=100;
      // The independent raw-file preload remains available for the older trial.
      if(query.get('preload')==='1'&&!residentPreparation){
        const preloadStarted=performance.now();
        const cache=new WorldPreloadCache({readJSON,readBinary,signal:AbortSignal.any([world.lifetime.signal,...(signal?[signal]:[])]),concurrency:4});
        world.preloadCache=cache;
        try{
          for(const chunk of pack.chunks)cache.addJSON(chunk.url);
          await cache.preload(stats=>onProgress(`PREPARING THE MAP · ${Math.floor(stats.completed/stats.total*100)}%`));
          for(const chunk of pack.chunks){
            const data=await cache.readJSON(chunk.url) as StreamChunkData;
            if(data.version!==1||data.id!==chunk.id||data.batches.length!==chunk.batches||data.matrices.bytes!==chunk.matrixBytes)
              throw new Error(`Invalid preload cell ${chunk.id}`);
            cache.addBinary(data.matrices.url,data.matrices.bytes,data.matrices.sha256);
          }
          for(const geometry of pack.geometries)cache.addBinary(geometry.url,geometry.bytes,geometry.sha256);
          for(const index of acceleration?.geometries??[])cache.addBinary(index.url,index.bytes,index.sha256);
          for(const image of pack.images)cache.addBinary(image.url,image.bytes,image.sha256);
          await cache.preload(stats=>onProgress(`LOADING THE LANDSCAPE · ${Math.floor(stats.completed/stats.total*100)}%`));
        }catch(error){
          cache.dispose();world.preloadCache=null;
          if(signal?.aborted||world.lifetime.signal.aborted)throw error;
          // A failed optional full-map preload can still use the normal loader;
          // preserve its existing per-cell error handling and shadow fallback.
          world.preloadFailure=error instanceof Error?error.message:String(error);
          console.warn('Full-map RAM preload unavailable; using normal landscape streaming.',error);
        }
        world.preloadTimeMs=performance.now()-preloadStarted;
      }
      world.streaming=new SpatialWorldStream(pack,world.root,{
        distanceDetail,
        shadowIndices:acceleration?.geometries,
        instanceSingletons:new URLSearchParams(location.search).get('cacheShadows')!=='0',
        readJSON:(path,requestSignal)=>world.preloadCache?.readJSON(path,requestSignal)??readJSON(path,requestSignal),
        readBinary:(path,requestSignal)=>world.preloadCache?.readBinary(path,requestSignal)??readBinary(path,requestSignal),
        // Keep the four-fetch queue busy while a fast flight crosses cell
        // boundaries. Geometry construction still yields on its small main
        // thread budget, so this only hides network/decode latency.
        concurrentChunks:4,
        prepareChunk:(group,requestSignal)=>world.prepareChunkForRender?.(group,requestSignal)??Promise.resolve(),
        onChange:change=>{
          // Hidden preparation slices do not change any visible receiver. Only
          // rebuild static shadow coverage when a complete cell appears/leaves.
          if(change.visibilityChanged||change.added.some(mesh=>mesh.parent?.visible)||change.removed.some(mesh=>mesh.parent?.visible))world.renderRevision++;
          world.onResidencyChange?.(change);if(!world.ready)onProgress('PREPARING THE NEARBY LANDSCAPE');
        },
      });
      world.streaming.update({position:{x:23,y:6,z:12},forward:{x:0,y:0,z:-1},altitude:6,baseDistance:INITIAL_STREAM_DISTANCE,viewDistance:Math.hypot(INITIAL_STREAM_DISTANCE,6)});
      await world.streaming.whenReady();
      world.ready=true;world.loadTimeMs=performance.now()-started;
      onProgress('PREPARING YOUR AIRCRAFT');
      return world;
    }catch(error){world.dispose();throw error;}
  }

  /** Retain source matrices and semantic names while batching only compatible static meshes. */
  attachScene(id:string,scene:THREE.Group):void{
    if(this.disposed)throw new Error('Cannot attach an environment to a disposed world.');
    const biome=this.biomeDefinitions.find(entry=>entry.id===id);
    if(!biome)throw new Error(`Unknown biome: ${id}`);
    if(this.loaded.has(id))throw new Error(`The biome is already loaded: ${id}`);
    scene.updateMatrixWorld(true);
    const batches=new Map<string,StaticBatch>();
    const biomeRoot=new THREE.Group();biomeRoot.name=biome.label;biomeRoot.userData.biomeId=id;
    const center=new THREE.Vector3();
    let sourceObjects=0,sourceTriangles=0;
    const routeMaterials=new Map<string,THREE.Material>();
    scene.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return;
      // Authored road layers separate coplanar crossings in Blender. Preserve
      // those same layers in the finite depth buffer at flight-view distances.
      if(object.userData.ground_route===true){
        const layer=Number(object.userData.route_layer)||0;
        const routeMaterial=(source:THREE.Material):THREE.Material=>{
          this.materials.add(source);
          const key=`${source.uuid}/${layer}`;
          let material=routeMaterials.get(key);
          if(!material){material=source.clone();material.name=`${source.name} / ground route ${layer}`;material.polygonOffset=true;material.polygonOffsetFactor=-1;material.polygonOffsetUnits=-2-layer*4;routeMaterials.set(key,material);}
          return material;
        };
        object.material=Array.isArray(object.material)?object.material.map(routeMaterial):routeMaterial(object.material);
      }
      this.geometries.add(object.geometry);
      const materialList=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materialList){
        this.materials.add(material);
        for(const value of Object.values(material))if(value instanceof THREE.Texture)this.textures.add(value);
      }
    });
    scene.traverseVisible(object=>{
      if(!(object instanceof THREE.Mesh))return;
      if(object instanceof THREE.SkinnedMesh||object.morphTargetInfluences?.length)
        throw new Error(`${biome.label}: ${object.name} requires an animated mesh binding.`);
      if(object instanceof THREE.InstancedMesh)throw new Error(`${biome.label}: nested exported instances require explicit transfer.`);
      const geometry=object.geometry;
      const positions=geometry.getAttribute('position');
      if(!positions)throw new Error(`${biome.label}: ${object.name} has no visible geometry.`);
      if(!geometry.boundingSphere)geometry.computeBoundingSphere();
      center.copy(geometry.boundingSphere!.center).applyMatrix4(object.matrixWorld);
      const cell=`${Math.floor(center.x/SPATIAL_CELL_SIZE)},${Math.floor(center.z/SPATIAL_CELL_SIZE)}`;
      const materialList=Array.isArray(object.material)?object.material:[object.material];
      const materialKey=materialList.map(material=>material.uuid).join(',');
      // Negative scales cannot be represented faithfully by THREE.InstancedMesh.
      const reflected=object.matrixWorld.determinant()<0;
      const key=`${geometry.uuid}|${materialKey}|${cell}|${object.renderOrder}|${object.layers.mask}${reflected?'|'+object.uuid:''}`;
      let batch=batches.get(key);
      if(!batch){batch={geometry,material:object.material,instances:[],cell,renderOrder:object.renderOrder,layers:object.layers.mask};batches.set(key,batch);}
      batch.instances.push({name:object.name,matrix:object.matrixWorld.clone(),metadata:{...object.userData}});
      sourceObjects++;sourceTriangles+=triangles(geometry);
    });
    const sourceMetadata=(instances:SourceInstance[])=>instances.map((instance,index)=>({name:instance.name,...instance.metadata,instanceIndex:index}));
    const configure=(mesh:THREE.Mesh,batch:StaticBatch):void=>{
      mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=true;
      mesh.renderOrder=batch.renderOrder;mesh.layers.mask=batch.layers;biomeRoot.add(mesh);
    };
    const addBatch=(batch:StaticBatch):void=>{
      const {instances,geometry,material}=batch;
      let mesh:THREE.Mesh;
      if(instances.length===1){
        mesh=new THREE.Mesh(geometry,material);mesh.matrix.copy(instances[0].matrix);mesh.matrixAutoUpdate=false;
      }else{
        const instancesMesh=new THREE.InstancedMesh(geometry,material,instances.length);
        instances.forEach((instance,index)=>instancesMesh.setMatrixAt(index,instance.matrix));
        instancesMesh.instanceMatrix.needsUpdate=true;instancesMesh.computeBoundingBox();instancesMesh.computeBoundingSphere();mesh=instancesMesh;
      }
      mesh.name=instances.length===1?instances[0].name:`${biome.label} · ${batch.cell} · ${instances[0].name}`;
      mesh.userData={biomeId:id,spatialCell:batch.cell,sourceObjects:sourceMetadata(instances)};
      if(batch.components){
        let sourceObjectOffset=0;
        mesh.userData.coinstancedStaticComponents=true;
        mesh.userData.sourceObjects=batch.components.flatMap(component=>sourceMetadata(component.instances));
        mesh.userData.sourceGeometryRanges=batch.components.map(component=>{
          const range={...component.range,sourceObjectOffset,sourceObjectCount:component.instances.length};
          sourceObjectOffset+=component.instances.length;return range;
        });
      }
      configure(mesh,batch);
    };
    const singletonGroups=new Map<string,StaticBatch[]>();
    const coinstanced=mergeCoinstancedBatches(batches.values());
    for(const geometry of coinstanced.geometries)this.geometries.add(geometry);
    for(const batch of coinstanced.batches){
      const geometry=batch.geometry;
      const terrainMesh=batch.instances.some(instance=>instance.name.includes('continuous-terrain'));
      const canMerge=batch.instances.length===1&&!terrainMesh&&!Array.isArray(batch.material)&&geometry.groups.length===0&&
        geometry.drawRange.start===0&&geometry.drawRange.count===Infinity&&batch.instances[0].matrix.determinant()>0;
      if(!canMerge){addBatch(batch);continue;}
      // Attribute names, precision and normalization must all match. Nothing is stripped or quantized.
      const layout=Object.keys(geometry.attributes).sort().map(name=>{
        const attribute=geometry.getAttribute(name);
        return `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`;
      }).join('|');
      const key=`${(batch.material as THREE.Material).uuid}|${batch.cell}|${layout}|${!!geometry.index}|${batch.renderOrder}|${batch.layers}`;
      const compatible=singletonGroups.get(key)??[];compatible.push(batch);singletonGroups.set(key,compatible);
    }
    for(const compatible of singletonGroups.values()){
      if(compatible.length===1){addBatch(compatible[0]);continue;}
      const parts=compatible.map(batch=>batch.geometry.clone().applyMatrix4(batch.instances[0].matrix));
      const merged=mergeGeometries(parts,false);
      for(const part of parts)part.dispose();
      if(!merged){for(const batch of compatible)addBatch(batch);continue;}
      merged.computeBoundingBox();merged.computeBoundingSphere();this.geometries.add(merged);
      const first=compatible[0],mesh=new THREE.Mesh(merged,first.material);
      let triangleOffset=0;
      const sourceObjects=compatible.map(batch=>{
        const instance=batch.instances[0],triangleCount=triangles(batch.geometry);
        const metadata={name:instance.name,...instance.metadata,sourceMatrix:instance.matrix.toArray(),triangleOffset,triangleCount};
        triangleOffset+=triangleCount;return metadata;
      });
      mesh.name=`${biome.label} · ${first.cell} · merged ${(first.material as THREE.Material).name}`;
      mesh.userData={biomeId:id,spatialCell:first.cell,sourceObjects,mergedStaticComponents:true};
      mesh.matrixAutoUpdate=false;configure(mesh,first);
    }
    let renderedTriangles=0;
    biomeRoot.traverse(object=>{if(object instanceof THREE.Mesh)renderedTriangles+=triangles(object.geometry)*(object instanceof THREE.InstancedMesh?object.count:1);});
    // Imported scenery has fixed local transforms. The world root retains
    // automatic placement updates and ordinary parent/world propagation.
    freezeStaticLocalMatrices(biomeRoot);biomeRoot.updateMatrix();biomeRoot.matrixAutoUpdate=false;
    this.root.add(biomeRoot);this.loaded.set(id,biomeRoot);
    // Merging transfers every source vertex into a new owned buffer. Keeping the
    // replaced source buffers as well doubles that portion of CPU memory.
    const retained=new Set<THREE.BufferGeometry>();
    this.root.traverse(object=>{if(object instanceof THREE.Mesh)retained.add(object.geometry);});
    for(const geometry of this.geometries)if(!retained.has(geometry)){
      geometry.dispose();this.geometries.delete(geometry);this.releasedSourceGeometries++;
    }
    this.transfers.push({id,sourceObjects,sourceTriangles,renderedTriangles,renderBatches:biomeRoot.children.length});
    detachImportedScene(scene);
    this.root.updateMatrixWorld(true);this.ready=this.loaded.size===this.biomeDefinitions.length;this.renderRevision++;
  }

  update(x:number,z:number):void{
    if(this.disposed||!Number.isFinite(x)||!Number.isFinite(z))return;
    this.position.set(x,z);
  }

  /** Pilot metadata is independent from the actual camera's streaming focus. */
  updateStreaming(view:WorldStreamingView):void{this.streaming?.update(view);}
  get isViewReady():boolean{return this.streaming?.isViewReady??this.ready;}
  whenReady():Promise<void>{return this.streaming?.whenReady()??Promise.resolve();}
  /** Keep a chosen portion fully constructed while normal visibility remains local. */
  prepareFraction(fraction:number,center:{x:number;y:number;z:number}):Promise<void>{
    return this.streaming?.prepareFraction(fraction,center)??Promise.resolve();
  }
  get streamingStats(){return {...(this.streaming?.stats??{enabled:false,ready:this.ready,visiblePending:0}),preload:this.preloadStats};}
  private get preloadStats(){return {enabled:!!this.preloadCache,durationMs:this.preloadTimeMs,failure:this.preloadFailure,...this.preloadCache?.stats};}

  /** The exported ground and collision share Float32 vertices and the a-b-d / d-b-c diagonal. */
  sampleGroundHeight(x:number,z:number):number{
    if(Math.abs(x)<=12&&Math.abs(z)<=180)return 0;
    const t=this.terrain,fx=(x-t.minX)/t.cellSize,fz=(z-t.minZ)/t.cellSize;
    if(fx<0||fz<0||fx>t.columns-1||fz>t.rows-1)return this.manifest.waterLevel;
    const ix=Math.min(t.columns-2,Math.floor(fx)),iz=Math.min(t.rows-2,Math.floor(fz));
    const tx=fx-ix,tz=fz-iz,i=iz*t.columns+ix;
    const a=this.heights[i],d=this.heights[i+1],b=this.heights[i+t.columns];
    if(tx+tz<=1)return a+(d-a)*tx+(b-a)*tz;
    const c=this.heights[i+t.columns+1];return c+(b-c)*(1-tx)+(d-c)*(1-tz);
  }

  getBiomeAt(x:number,z:number):BiomeDefinition{
    const contained=this.biomeDefinitions.find(biome=>inside(biome.bounds,x,z));
    if(contained)return contained;
    let nearest=this.biomeDefinitions[0],distance=Infinity;
    for(const biome of this.biomeDefinitions){
      const bounds=biome.bounds;
      const dx=x-Math.max(bounds.minX,Math.min(bounds.maxX,x)),dz=z-Math.max(bounds.minZ,Math.min(bounds.maxZ,z));
      if(dx*dx+dz*dz<distance){distance=dx*dx+dz*dz;nearest=biome;}
    }
    return nearest;
  }

  findBiome(id:string):{x:number;z:number;biome:BiomeDefinition}{
    const biome=this.biomeDefinitions.find(entry=>entry.id===id);
    if(!biome)throw new Error(`Unknown biome: ${id}`);
    return{x:biome.review.aircraft[0],z:biome.review.aircraft[2],biome};
  }

  getReviewView(id:string,altitude=80,maxVisibleDistance=300):{camera:[number,number,number];target:[number,number,number]}{
    const {biome}=this.findBiome(id),review=biome.review;
    const baseAltitude=review.aircraft[1]-this.sampleGroundHeight(review.aircraft[0],review.aircraft[2]);
    const camera=new THREE.Vector3(review.camera[0],review.camera[1]+altitude-baseAltitude,review.camera[2]);
    const target=new THREE.Vector3(...review.target);
    // Short streamed views should still show the authored landmark in review
    // mode. Keep high-altitude establishing shots unchanged, but pull a low
    // review camera toward its target when the original framing lies outside
    // the resident radius.
    const safeDistance=Math.max(100,Math.min(maxVisibleDistance,altitude*1.35+40));
    const distance=camera.distanceTo(target);
    if(distance>safeDistance)camera.lerp(target,safeDistance/distance);
    return{camera:camera.toArray() as [number,number,number],target:target.toArray() as [number,number,number]};
  }

  get diagnostics(){
    const streaming=this.streaming?.stats;
    const sourceObjects=streaming?.residentSourceObjects??this.transfers.reduce((sum,item)=>sum+item.sourceObjects,0);
    const sourceTriangles=streaming?.residentTriangles??this.transfers.reduce((sum,item)=>sum+item.sourceTriangles,0);
    const renderedTriangles=streaming?.residentTriangles??this.transfers.reduce((sum,item)=>sum+item.renderedTriangles,0);
    const renderBatches=streaming?.residentBatches??this.transfers.reduce((sum,item)=>sum+item.renderBatches,0);
    return{
      name:this.manifest.name,worldVersion:this.manifest.version,worldType:'authored-four-biome',ready:this.isViewReady,
      authoredBiomeCount:this.biomeDefinitions.length,loadedBiomes:streaming?.loadedBiomeIds.length??this.loaded.size,activeBiomeIds:streaming?.loadedBiomeIds??[...this.loaded.keys()],
      currentBiomeId:this.getBiomeAt(this.position.x,this.position.y).id,
      outsideWorld:!inside(this.manifest.bounds,this.position.x,this.position.y),bounds:{...this.manifest.bounds},
      sourceObjects,sourceTriangles,renderedInstances:sourceObjects,renderedTriangles,renderBatches,
      trianglePreservation:sourceTriangles===renderedTriangles,spatialCellSize:SPATIAL_CELL_SIZE,
      geometries:streaming?.geometries??this.geometries.size,releasedSourceGeometries:this.releasedSourceGeometries,materials:streaming?.materials??this.materials.size,textures:streaming?.textures??this.textures.size,
      geometryCompression:false,lod:false,nativeDetail:true,loadTimeMs:this.loadTimeMs,
      streaming:streaming??{enabled:false},preload:this.preloadStats,renderRevision:this.renderRevision,
      biomeTransfers:this.transfers.map(item=>({...item})),
      biomes:this.biomeDefinitions.map(biome=>({id:biome.id,label:biome.label,landmark:biome.landmark,region:biome.region,center:{...biome.center}})),
      resourceIdentities:[...this.geometries].map(geometry=>geometry.uuid).sort(),disposed:this.disposed,
    };
  }

  dispose():void{
    if(this.disposed)return;this.disposed=true;this.ready=false;
    this.lifetime.abort();this.streaming?.dispose();
    this.preloadCache?.dispose();this.preloadCache=null;
    this.root.traverse(object=>{if(object instanceof THREE.InstancedMesh)object.dispose();});
    for(const geometry of this.geometries)geometry.dispose();
    for(const material of this.materials)material.dispose();
    for(const texture of this.textures)texture.dispose();
    this.root.clear();this.root.removeFromParent();this.loaded.clear();
  }
}
