import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { renderSceneWithPreparedMatrices } from './renderSceneWithPreparedMatrices';
import { prepareChunkPrograms } from './prepareChunkPrograms';
import { FullDetailWorldCulling } from './FullDetailWorldCulling';
import type { InstanceShadowPass } from '../world/PassInstanceCuller';
import { FloatDepthSurface,checkFloatDepthSurfaceSupport } from './FloatDepthSurface';
import { ScrollingShadowCache,type ShadowCacheRect,type ShadowCacheResult } from '../experiments/ScrollingShadowCache';
import { projectShadowDirtyBounds } from '../experiments/projectShadowDirtyBounds';
import { renderWithProxyWorld } from './renderWithProxyWorld';
import { prepareResidentBuffers, type ResidentBufferPreparationMetrics } from './prepareResidentBuffers';
import { DistanceDetailController,distanceDetailLevels } from '../world/DistanceDetailGeometry';
import { SelectedPassRendering } from './SelectedPassRendering';
import {TemporalBeautyVolume} from './TemporalBeautyVolume';
import {prepareResidentBindings,type ResidentBindingProgress} from './prepareResidentBindings';

export interface RenderPassStatistics {
  shadow:{calls:number;triangles:number};
  beauty:{calls:number;triangles:number};
  total:{calls:number;triangles:number};
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, .15, 16000);
  readonly passes:RenderPassStatistics={shadow:{calls:0,triangles:0},beauty:{calls:0,triangles:0},total:{calls:0,triangles:0}};
  private readonly environment: THREE.WebGLRenderTarget;
  private floatDepth:FloatDepthSurface|null=null;
  private shadowCache:ScrollingShadowCache|null=null;
  private cullingWorld:THREE.Object3D|null=null;
  private readonly shadowRegionProjection=new THREE.Matrix4();
  private readonly shadowRegionFrustum=new THREE.Frustum();
  private readonly shadowCacheResults=new Map<number,ShadowCacheResult>();
  private readonly shadowCacheRevisions=new Map<number,number>();
  private shadowCacheEligible:((index:number)=>boolean)|undefined;
  private readonly deferredShadowPasses=new Set<number>();
  private readonly residentShadowRegionPasses=new Set<number>();
  private readonly untrackedShadowCasters=new Set<THREE.Object3D>();
  private readonly untrackedWorldRenderables=new Set<THREE.Object3D>();
  private readonly pruneCanonicalTraversal=new URLSearchParams(window.location.search).get('pruneTraversal')!=='0';
  readonly depthStatus:{mode:string;fallback?:string}={mode:'logarithmic'};
  instanceCulling:FullDetailWorldCulling|null=null;
  residentPreparation:ResidentBufferPreparationMetrics|null=null;
  residentBindingPreparation:ResidentBindingProgress|null=null;
  distanceDetail:DistanceDetailController|null=null;
  selectedBatching:SelectedPassRendering|null=null;
  get batchingStatistics(){return this.selectedBatching?.statistics;}
  constructor(private readonly app: HTMLElement) {
    // Millimeter-separated roof tiles and decks remain distinct across the
    // .15–16000 m view range; ordinary perspective depth caused distant patches.
    const parameters:THREE.WebGLRendererParameters={antialias:true,powerPreference:'high-performance',stencil:false,logarithmicDepthBuffer:true};
    const query=new URLSearchParams(window.location.search),floatRequested=query.get('floatDepth')==='1';
    if(query.get('depth')==='reversed'||floatRequested){
      // Keep this controlled comparison opt-in. Check the extension before
      // selecting flags so unsupported devices retain the precise log path.
      const canvas=document.createElement('canvas');
      const context=canvas.getContext('webgl2',{antialias:true,powerPreference:'high-performance',stencil:false,alpha:false});
      if(!context)throw new Error('The reversed-depth comparison requires WebGL 2.');
      const supported=!!context.getExtension('EXT_clip_control')&&(!floatRequested||checkFloatDepthSurfaceSupport(context).supported);
      Object.assign(parameters,{canvas,context,reversedDepthBuffer:supported,logarithmicDepthBuffer:!supported});
      if(!supported&&floatRequested)this.depthStatus.fallback='Floating-point depth with unchanged antialiasing is unavailable.';
    }
    this.renderer = new THREE.WebGLRenderer(parameters);
    if(floatRequested&&this.renderer.capabilities.reversedDepthBuffer){
      try{this.floatDepth=new FloatDepthSurface(this.renderer);}
      catch(error){
        this.renderer.dispose();
        this.renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance',stencil:false,logarithmicDepthBuffer:true});
        this.depthStatus.fallback=String(error);
      }
    }
    this.depthStatus.mode=this.floatDepth?'reversed-float32':this.renderer.capabilities.reversedDepthBuffer?'reversed-default':'logarithmic';
    if(this.renderer.capabilities.reversedDepthBuffer){
      // r184 otherwise switches this flag during the first material draw,
      // after our streaming/instance cullers have already used the projection.
      (this.camera as THREE.PerspectiveCamera&{_reversedDepth:boolean})._reversedDepth=true;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.id = 'flight-canvas';
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', '3D aircraft and four connected biomes');
    app.prepend(this.renderer.domElement);
    this.scene.fog = null;
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, .04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = .22;
    room.dispose(); pmrem.dispose();
    // Three's default counter reset occurs after its shadow pass. Preserve both
    // parts so full-detail vegetation shadow work is visible in diagnostics.
    const shadowRender=this.renderer.shadowMap.render.bind(this.renderer.shadowMap);
    this.renderer.shadowMap.render=(lights,scene,camera)=>{
      const beforeCalls=this.renderer.info.render.calls,beforeTriangles=this.renderer.info.render.triangles;
      if(this.instanceCulling?.culler.enabled)this.instanceCulling.culler.renderShadowPasses(shadowRender,this.renderer.shadowMap,lights,scene,camera);
      else shadowRender(lights,scene,camera);
      this.passes.shadow.calls=this.renderer.info.render.calls-beforeCalls;
      this.passes.shadow.triangles=this.renderer.info.render.triangles-beforeTriangles;
    };
    this.renderer.info.autoReset=false;
    this.resize(); window.addEventListener('resize', this.resize);
  }
  readonly resize = (): void => {
    const w = this.app.clientWidth, h = this.app.clientHeight;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  };
  enableWorldCulling(world:THREE.Object3D,passes:()=>readonly InstanceShadowPass[],compatible:(material:THREE.Material)=>boolean):void {
    if(this.instanceCulling)throw new Error('World culling is already configured.');
    this.instanceCulling=new FullDetailWorldCulling(world,this.scene,this.camera,passes,compatible);
    const query=new URLSearchParams(window.location.search);
    this.instanceCulling.culler.coarseDetailSelection=query.get('coarseDetail')!=='0';
    this.instanceCulling.culler.coarseBeautySelection=query.get('exactBeauty')!=='1';
    if(query.get('batchVisible')!=='0'){
      this.selectedBatching=new SelectedPassRendering(this.instanceCulling.culler.getRenderProxyRevision,this.instanceCulling.culler.getRenderPassRevision);
      this.instanceCulling.culler.renderSelectedPass=this.selectedBatching.render;
    }
    if(query.get('detail')!=='full'){
      const requested=Number(query.get('detailError')??4);
      this.distanceDetail=new DistanceDetailController(this.camera,Number.isFinite(requested)&&requested>=.5&&requested<=12?requested:4);
      this.instanceCulling.culler.geometryForPass=this.distanceDetail.geometryForPass;
      if(query.get('temporalBeauty')!=='0'){
        this.instanceCulling.temporalBeauty=new TemporalBeautyVolume();
        this.instanceCulling.culler.reuseStaticBeautySelection=true;
        this.instanceCulling.prepareBeautySelection=selection=>this.distanceDetail!.setSelectionView(selection.origin,selection.pixelsPerRadian,selection.translationMargin);
      }
    }
    this.cullingWorld=world;
    this.renderer.setOpaqueSort(this.instanceCulling.culler.opaqueSort);
  }
  prepareWorldCulling():void {
    this.distanceDetail?.beginFrame(this.renderer.domElement.height);
    if(this.instanceCulling)this.instanceCulling.temporalBeautyHeight=this.renderer.domElement.height;
    if(this.instanceCulling&&this.shadowCacheEligible){
      this.deferredShadowPasses.clear();
      for(let index=0;index<4;index++)if(this.shadowCacheEligible(index))this.deferredShadowPasses.add(index);
      this.instanceCulling.culler.deferredShadowPasses=this.deferredShadowPasses;
    }
    this.instanceCulling?.prepare();
  }
  /** Full-resolution static cache; explicit debug links can disable it. */
  configureStaticShadowCache(eligible:(index:number)=>boolean,potentialPassIndices:readonly number[]):void {
    if(new URLSearchParams(window.location.search).get('cacheShadows')==='0')return;
    const adapter=this.instanceCulling,world=this.cullingWorld;
    if(!adapter||!world)throw new Error('Configure static shadows after world culling.');
    for(const index of potentialPassIndices){
      if(!Number.isInteger(index)||index<0||index>=adapter.culler.shadowGroups.length)throw new Error('Invalid potential shadow cache pass');
      this.residentShadowRegionPasses.add(index);
    }
    this.shadowCache=new ScrollingShadowCache(this.renderer,{maxLights:Math.max(1,potentialPassIndices.length)});
    this.shadowCacheEligible=index=>eligible(index)&&this.untrackedShadowCasters.size===0;
    const initial:THREE.Object3D[]=[];world.traverse(object=>initial.push(object));this.updateStaticShadowCoverage(initial,[]);
    adapter.culler.trackShadowContent=true;
    const visibility:Array<{object:THREE.Object3D;visible:boolean}>=[];
    const withStatic=(group:THREE.Group,draw:()=>void):void=>{
      visibility.length=0;
      for(const object of this.scene.children)if(object!==world&&object!==group){visibility.push({object,visible:object.visible});object.visible=false;}
      try{draw();}finally{for(const entry of visibility)entry.object.visible=entry.visible;visibility.length=0;}
    };
    const drawTrackedWorld=(drawNative:()=>void):void=>{
      // Region selection observes the source graph first. Once its proxies are
      // ready, every static caster is represented outside that source graph.
      const visible=world.visible;world.visible=false;
      this.renderer.info.render.frame++;
      try{drawNative();}finally{world.visible=visible;}
    };
    adapter.culler.shadowPassDispatcher=(index,light,group,drawNative)=>{
      if(!this.shadowCacheEligible!(index)){this.shadowCache!.invalidate(light);this.shadowCacheRevisions.delete(index);drawNative();return;}
      const changes=adapter.culler.shadowChanges;
      const dirtyRegions=!changes.full&&this.shadowCacheRevisions.get(index)===changes.fromRevision?projectShadowDirtyBounds(light,changes.bounds):undefined;
      const result=this.shadowCache!.render(light,changes.revision,{
        dirtyRegions,
        drawAll:()=>adapter.culler.withShadowRegion(index,light.shadow.getFrustum(),()=>drawTrackedWorld(drawNative)),
        drawDynamic:()=>{
          const worldVisible=world.visible,groupVisible=group.visible;
          world.visible=false;group.visible=false;
          try{drawNative();}finally{world.visible=worldVisible;group.visible=groupVisible;}
        },
        drawStatic:(rect:ShadowCacheRect)=>withStatic(group,()=>{
          const camera=light.shadow.camera,sx=(camera.right-camera.left)/light.shadow.mapSize.x,sy=(camera.top-camera.bottom)/light.shadow.mapSize.y;
          const left=camera.left+rect.x*sx,bottom=camera.bottom+rect.y*sy;
          this.shadowRegionProjection.makeOrthographic(left,left+rect.width*sx,bottom+rect.height*sy,bottom,camera.near,camera.far);
          this.shadowRegionProjection.multiply(camera.matrixWorldInverse);
          this.shadowRegionFrustum.setFromProjectionMatrix(this.shadowRegionProjection);
          const frustum=light.shadow.getFrustum(),intersects=frustum.intersectsObject;
          frustum.intersectsObject=object=>intersects.call(frustum,object)&&this.shadowRegionFrustum.intersectsObject(object);
          try{adapter.culler.withShadowRegion(index,this.shadowRegionFrustum,()=>{
              // Native shadow draws do not advance Three's per-object upload frame.
              // Each strip may reuse its own region proxy with a new matrix prefix.
              drawTrackedWorld(drawNative);
            });
          }finally{frustum.intersectsObject=intersects;}
        }),
      });
      if(result.cached)this.shadowCacheRevisions.set(index,changes.revision);else this.shadowCacheRevisions.delete(index);
      this.shadowCacheResults.set(index,result);
    };
  }
  updateStaticShadowCoverage(added:readonly THREE.Object3D[],removed:readonly THREE.Object3D[]):void {
    if(!this.shadowCache||!this.instanceCulling)return;
    for(const source of removed){this.untrackedShadowCasters.delete(source);this.untrackedWorldRenderables.delete(source);}
    for(const source of added){
      const tracked=this.instanceCulling.culler.hasSource(source);
      if(source instanceof THREE.Mesh&&source.castShadow&&!tracked)this.untrackedShadowCasters.add(source);
      if(!tracked&&(source instanceof THREE.Mesh||source instanceof THREE.Line||source instanceof THREE.Points||source instanceof THREE.Sprite||source instanceof THREE.Light||source instanceof THREE.LOD))this.untrackedWorldRenderables.add(source);
    }
  }
  get shadowCacheDiagnostics(){return this.shadowCache?{cascades:Object.fromEntries(this.shadowCacheResults),statistics:{...this.shadowCache.statistics},allocatedBytes:this.shadowCache.allocatedBytes,untrackedCasters:this.untrackedShadowCasters.size}:null;}
  prepareChunkPrograms(chunk:THREE.Group,signal:AbortSignal):Promise<void> {
    return prepareChunkPrograms(this.renderer,chunk,this.camera,this.scene,signal);
  }
  async prepareResidentBuffers(world:THREE.Object3D,signal:AbortSignal,progress:(completed:number,total:number)=>void):Promise<void>{
    const culler=this.instanceCulling?.culler;
    const meshes:THREE.Mesh[]=culler?[...culler.preparationMeshes(this.residentShadowRegionPasses)]:[];
    const preparedVariants=new Set<THREE.BufferGeometry>();
    if(this.distanceDetail)world.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return;
      if(!preparedVariants.has(object.geometry)){
        preparedVariants.add(object.geometry);meshes.push(new THREE.Mesh(object.geometry,object.material));
      }
      for(const level of distanceDetailLevels(object.geometry))if(!preparedVariants.has(level.geometry)){
        preparedVariants.add(level.geometry);meshes.push(new THREE.Mesh(level.geometry,object.material));
      }
    });
    world.traverse(object=>{if(object instanceof THREE.Mesh&&!culler?.hasSource(object))meshes.push(object);});
    if(this.selectedBatching&&culler){
      this.selectedBatching.prepare(culler.canonicalSources,meshes,!!this.distanceDetail);
      meshes.push(...this.selectedBatching.preparationMeshes());
    }
    const bindings=new URLSearchParams(window.location.search).get('warmBindings')!=='0'?(this.selectedBatching?.preparationMeshes()??[]):[];
    this.residentPreparation=await prepareResidentBuffers(this.renderer,meshes,signal,
      state=>progress(state.completed,state.total+bindings.length));
    if(bindings.length){
      const sun=this.scene.children.find(object=>object instanceof THREE.DirectionalLight&&object.castShadow) as THREE.DirectionalLight|undefined;
      const target=new THREE.WebGLRenderTarget(1,1);
      try{
        const completed=this.residentPreparation.completed;
        this.residentBindingPreparation=await prepareResidentBindings(this.renderer,this.scene,this.camera,bindings,signal,
          state=>progress(completed+state.completed,completed+state.total),{shadowCamera:sun?.shadow.camera,shadowTarget:target,realDraw:new URLSearchParams(window.location.search).get('warmBindingsDraw')==='1'});
      }finally{target.dispose();}
    }
  }
  render(sceneMatricesPrepared=false): void {
    if(this.instanceCulling&&!sceneMatricesPrepared){
      this.scene.updateMatrixWorld();
      if(this.camera.parent===null)this.camera.updateMatrixWorld();
      sceneMatricesPrepared=true;
    }
    this.prepareWorldCulling();
    this.renderer.info.reset();
    this.floatDepth?.begin();
    try{
      const drawNative=()=>{
        if(sceneMatricesPrepared)renderSceneWithPreparedMatrices(this.renderer,this.scene,this.camera);
        else this.renderer.render(this.scene,this.camera);
      };
      const draw=()=>this.instanceCulling?.culler.enabled?this.instanceCulling.culler.withCompactBeauty(drawNative):drawNative();
      if(this.pruneCanonicalTraversal&&this.shadowCache&&this.instanceCulling?.culler.enabled&&this.untrackedWorldRenderables.size===0&&this.cullingWorld)
        renderWithProxyWorld(this.scene,this.cullingWorld,draw);
      else draw();
      this.floatDepth?.end();
    }catch(error){this.floatDepth?.abort();throw error;}
    this.passes.total.calls=this.renderer.info.render.calls;this.passes.total.triangles=this.renderer.info.render.triangles;
    this.passes.beauty.calls=this.passes.total.calls-this.passes.shadow.calls;
    this.passes.beauty.triangles=this.passes.total.triangles-this.passes.shadow.triangles;
  }
  disposeWorldCulling():void {this.shadowCache?.dispose();this.shadowCache=null;this.selectedBatching?.dispose();this.selectedBatching=null;this.instanceCulling?.dispose();this.instanceCulling=null;this.cullingWorld=null;this.renderer.setOpaqueSort(null);}
  dispose(): void { this.disposeWorldCulling();window.removeEventListener('resize', this.resize); this.environment.dispose();this.floatDepth?.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}
