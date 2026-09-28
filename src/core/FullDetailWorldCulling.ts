import * as THREE from 'three';
import { PassInstanceCuller,isInstanceCullingCandidate,type InstanceShadowPass } from '../world/PassInstanceCuller';
import { isImmutableStreamSource, getStaticStreamSourceLease, getStaticStreamOwnershipRevision } from '../world/ImmutableStreamSources';
import { isStreamFrustumOnlySource } from '../world/StreamRenderPolicy';
import {TemporalBeautyVolume} from './TemporalBeautyVolume';

/** Owns rendering proxies; the world's complete source graph remains authoritative. */
export class FullDetailWorldCulling {
  readonly culler:PassInstanceCuller;
  private readonly projection=new THREE.Matrix4();
  private readonly frustum=new THREE.Frustum();
  private initialized=false;
  private disposed=false;
  /** Validation can force the adapter while comparing it with canonical draws. */
  automaticSelection=true;
  private estimatedBeautyTriangles=0;
  private viewDistance=Infinity;
  private readonly viewOrigin=new THREE.Vector3();
  temporalBeauty:TemporalBeautyVolume|undefined;
  temporalBeautyHeight=900;
  prepareBeautySelection?: (selection:TemporalBeautyVolume)=>void;
  private readonly immutableSourcePredicate=typeof window!=='undefined'&&new URLSearchParams(window.location.search).get('immutableWorld')!=='0'?isImmutableStreamSource:undefined;

  constructor(
    world:THREE.Object3D,scene:THREE.Scene,private readonly camera:THREE.PerspectiveCamera,
    private readonly shadowPasses:()=>readonly InstanceShadowPass[],
    private readonly isMaterialCompatible:(material:THREE.Material)=>boolean,
    readonly minimumPrototypeTriangles=0,
    readonly pathThresholds={enterTriangles:500_000_000,exitTriangles:350_000_000},
  ){
    const sources:THREE.InstancedMesh[]=[];
    const options={isMaterialCompatible,isImmutableSource:this.immutableSourcePredicate,getStaticSourceLease:getStaticStreamSourceLease,getStaticSourceLeaseRevision:getStaticStreamOwnershipRevision,isFrustumOnlySource:isStreamFrustumOnlySource};
    world.traverse(object=>{if(isInstanceCullingCandidate(object,minimumPrototypeTriangles,1,options))sources.push(object);});
    this.culler=new PassInstanceCuller(sources,4,options);
    scene.add(this.culler.beautyGroup,...this.culler.shadowGroups);
  }

  /** Finite user-selected range forces per-instance selection instead of whole-batch fallback. */
  setViewDistance(distance:number):void {
    if(distance!==Infinity&&(!Number.isFinite(distance)||distance<=0))throw new Error('Visible distance must be positive');
    this.viewDistance=distance;
  }

  /** Register CSM material hooks before registering newly resident canonical batches. */
  addSources(objects:readonly THREE.Object3D[]):void {
    if(this.disposed)throw new Error('World culling is disposed');
    const options={isMaterialCompatible:this.isMaterialCompatible,isImmutableSource:this.immutableSourcePredicate,getStaticSourceLease:getStaticStreamSourceLease,getStaticSourceLeaseRevision:getStaticStreamOwnershipRevision,isFrustumOnlySource:isStreamFrustumOnlySource};
    this.culler.addSources(objects.filter((object):object is THREE.InstancedMesh=>
      isInstanceCullingCandidate(object,this.minimumPrototypeTriangles,1,options)));
  }

  /** Call before streamed meshes/geometry are released by the world owner. */
  removeSources(objects:readonly THREE.Object3D[]):void {this.culler.removeSources(objects);}

  /** Run after complete camera, light and source world-matrix preparation. */
  prepare():void {
    if(this.disposed)return;
    this.projection.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection,this.camera.coordinateSystem,this.camera.reversedDepth);
    if(this.automaticSelection&&this.viewDistance===Infinity){
      // This estimate chooses between two full-detail render paths. It never
      // rejects geometry: inexpensive views use the complete canonical graph.
      this.estimatedBeautyTriangles=0;
      for(const {source,originalLayerMask} of this.culler.canonicalSources){
        if(!(originalLayerMask&this.camera.layers.mask))continue;
        let object:THREE.Object3D|null=source,visible=true;
        while(object){if(!object.visible){visible=false;break;}if(object instanceof THREE.Scene)break;object=object.parent;}
        if(!visible||!object||source.frustumCulled&&!this.frustum.intersectsObject(source))continue;
        this.estimatedBeautyTriangles+=(source.geometry.index?.count??source.geometry.getAttribute('position').count)/3*source.count;
      }
      const threshold=this.culler.enabled?this.pathThresholds.exitTriangles:this.pathThresholds.enterTriangles;
      if(this.estimatedBeautyTriangles<threshold){
        this.culler.disable();this.initialized=true;return;
      }
    }
    this.viewOrigin.setFromMatrixPosition(this.camera.matrixWorld);
    const temporal=this.temporalBeauty;
    if(temporal){
      temporal.update(this.camera,this.frustum,this.viewDistance,this.temporalBeautyHeight);
      this.culler.beautySelectionRevision=temporal.revision;
      this.prepareBeautySelection?.(temporal);
    }
    this.culler.prepare(temporal?.frustum??this.frustum,this.shadowPasses(),this.camera.layers.mask,
      this.viewDistance===Infinity?undefined:{origin:temporal?.origin??this.viewOrigin,distance:temporal?.distance??this.viewDistance});
    if(!this.initialized||this.automaticSelection||this.viewDistance!==Infinity){this.culler.enable();this.initialized=true;}
  }

  get diagnostics(){
    const sources=this.culler.canonicalSources;
    const slots=sources.reduce((sum,item)=>sum+item.source.instanceMatrix.count,0);
    return {
      enabled:this.culler.enabled,minimumPrototypeTriangles:this.minimumPrototypeTriangles,viewDistance:this.viewDistance===Infinity?null:this.viewDistance,
      renderPath:this.culler.enabled?'instance-culling':'canonical',automaticSelection:this.automaticSelection,
      estimatedBeautyTriangles:this.automaticSelection&&this.viewDistance===Infinity?this.estimatedBeautyTriangles:null,pathThresholds:this.pathThresholds,
      canonicalBatches:sources.length,canonicalInstanceSlots:slots,
      allocatedMatrixBufferBytes:slots*16*4*(1+this.culler.shadowGroups.length),
      shadowDepthCache:false,geometryReduction:this.culler.geometryForPass!==undefined,
      staticLeases:{enabled:this.culler.staticStreamLeasesEnabled,...this.culler.staticLeaseStatistics},
      compactRenderLists:this.culler.compactRenderStatistics,
      temporalBeauty:this.temporalBeauty?{...this.temporalBeauty.statistics}:null,
      passes:this.culler.enabled?this.culler.statistics.map(statistics=>({...statistics})):[],
    };
  }

  dispose():void {
    if(this.disposed)return;
    this.culler.dispose();this.disposed=true;
  }
}
