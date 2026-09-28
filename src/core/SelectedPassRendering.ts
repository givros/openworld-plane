import * as THREE from 'three';
import { SelectedInstanceBatcher } from '../experiments/SelectedInstanceBatcher';
import { distanceDetailLevels } from '../world/DistanceDetailGeometry';
import type { CanonicalInstanceSource } from '../world/PassInstanceCuller';

interface ParentSelection {parent:THREE.Object3D;selected:THREE.InstancedMesh[];generation:number;original:THREE.Object3D[]|undefined;result:THREE.Object3D[]|undefined}
interface PassScratch {
  parents:Map<THREE.Object3D,ParentSelection>;
  groups:ParentSelection[];
  sources:THREE.InstancedMesh[];
  sourceParents:THREE.Object3D[];
  visible:THREE.Object3D[];
  orderCounts:Map<number,number>;
  generation:number;
  cached:boolean;
  revision:number|undefined;
}
const createScratch=():PassScratch=>({parents:new Map(),groups:[],sources:[],sourceParents:[],visible:[],orderCounts:new Map(),generation:0,cached:false,revision:undefined});

/** Group already-selected opaque instances, preserving inherited order groups. */
export class SelectedPassRendering{
  private readonly batchers=new Map<string,SelectedInstanceBatcher>();
  private readonly scratchByPass=new Map<number,WeakMap<THREE.Group,PassScratch>>();
  private readonly activePasses=new Set<number>();
  private readonly lastRoots=new Map<number,THREE.Group>();
  readonly selectionCacheStatistics={reusedPasses:0,preparedPasses:0};
  /** Defined pass revisions are an explicit owner promise covering the complete
   * selected list, hierarchy, presentation, bindings and instance content. */
  constructor(private readonly getRenderProxyRevision?:(proxy:THREE.InstancedMesh)=>number|undefined,
    private readonly getRenderPassRevision?:(pass:number)=>number|undefined){}
  private batcher(pass:number,order:number):SelectedInstanceBatcher{
    const key=`${pass}/${order}`;let batcher=this.batchers.get(key);
    if(!batcher){batcher=new SelectedInstanceBatcher({getSourceRevision:this.getRenderProxyRevision});this.batchers.set(key,batcher);}
    return batcher;
  }
  prepare(descriptors:readonly CanonicalInstanceSource[],proxies:readonly THREE.Mesh[],detail:boolean):void{
    this.scratchByPass.clear();this.lastRoots.clear();
    const sources=new Map(descriptors.map(descriptor=>[descriptor.source.id,descriptor]));
    const templates=new Map<SelectedInstanceBatcher,THREE.InstancedMesh[]>();
    for(const proxy of proxies){
      if(!(proxy instanceof THREE.InstancedMesh)||proxy.userData.shadowRegionProxy)continue;
      const descriptor=sources.get(proxy.userData.canonicalSourceId);if(!descriptor)continue;
      const source=descriptor.source,pass=proxy.userData.passIndex as number;
      const batcher=this.batcher(pass,proxy.parent?.renderOrder??0);
      let list=templates.get(batcher);if(!list){list=[];templates.set(batcher,list);}
      const geometries=pass===0?[source.geometry,...(detail?distanceDetailLevels(source.geometry).map(level=>level.geometry):[])]:[proxy.geometry];
      for(const geometry of geometries){
        const template=new THREE.InstancedMesh(geometry,source.material,0);
        // CPU preparation only; no carrier is submitted or owns these buffers.
        template.instanceMatrix=proxy.instanceMatrix;template.instanceColor=proxy.instanceColor;
        template.count=0;template.matrixWorld.copy(source.matrixWorld);template.visible=true;
        template.castShadow=pass>0&&source.castShadow;template.receiveShadow=pass===0&&source.receiveShadow;
        template.layers.mask=descriptor.originalLayerMask;template.renderOrder=source.renderOrder;
        template.customDepthMaterial=proxy.customDepthMaterial;template.customDistanceMaterial=proxy.customDistanceMaterial;
        list.push(template);
      }
    }
    for(const [batcher,list]of templates)batcher.prepare(list);
  }
  preparationMeshes():THREE.InstancedMesh[]{return [...this.batchers.values()].flatMap(batcher=>batcher.preparationMeshes());}
  readonly render=<T>(root:THREE.Group,selected:readonly THREE.InstancedMesh[],pass:number,draw:()=>T):T=>{
    const reentrant=this.activePasses.has(pass);
    let scratch:PassScratch;
    if(reentrant)scratch=createScratch();
    else{
      let roots=this.scratchByPass.get(pass);if(!roots){roots=new WeakMap();this.scratchByPass.set(pass,roots);}
      const previous=roots.get(root);scratch=previous??createScratch();if(!previous)roots.set(root,scratch);
    }
    const revision=reentrant?undefined:this.getRenderPassRevision?.(pass);
    const reuse=!reentrant&&revision!==undefined&&scratch.cached&&scratch.revision===revision&&this.lastRoots.get(pass)===root;
    if(!reentrant)this.lastRoots.set(pass,root);
    if(reuse)this.selectionCacheStatistics.reusedPasses++;
    else{
      this.selectionCacheStatistics.preparedPasses++;scratch.cached=false;
      let same=scratch.sources.length===selected.length;
      for(let i=0;i<selected.length;i++){
        const mesh=selected[i];
        const parent=mesh.parent;
        if(!parent||parent!==root&&parent.parent!==root)throw new Error('Selected rendering requires direct pass order groups');
        if(scratch.sources[i]!==mesh||scratch.sourceParents[i]!==parent)same=false;
      }
      if(!same){
        const generation=++scratch.generation;
        scratch.groups.length=0;scratch.sources.length=selected.length;scratch.sourceParents.length=selected.length;
        for(let i=0;i<selected.length;i++){
          const mesh=selected[i],parent=mesh.parent!;
          scratch.sources[i]=mesh;scratch.sourceParents[i]=parent;
          let group=scratch.parents.get(parent);
          if(!group){group={parent,selected:[],generation:-1,original:undefined,result:undefined};scratch.parents.set(parent,group);}
          if(group.generation!==generation){group.generation=generation;group.selected.length=0;scratch.groups.push(group);}
          group.selected.push(mesh);
        }
      }
    }
    const children=root.children,{visible,orderCounts}=scratch;
    if(!reuse){
      visible.length=0;orderCounts.clear();
      for(const group of scratch.groups)orderCounts.set(group.parent.renderOrder,(orderCounts.get(group.parent.renderOrder)??0)+1);
    }
    this.activePasses.add(pass);
    try{
      for(const group of scratch.groups){
        const {parent,selected:list}=group;
        // A reusable batch output cannot be installed under two parents at once.
        const result=reuse?group.result!:reentrant||orderCounts.get(parent.renderOrder)!>1?list:this.batcher(pass,parent.renderOrder).select(list) as unknown as THREE.Object3D[];
        group.result=result;
        if(parent===root){if(!reuse)visible.push(...result);}
        else{group.original=parent.children;parent.children=result;if(!reuse)visible.push(parent);}
      }
      scratch.cached=!reentrant&&revision!==undefined;scratch.revision=revision;
      root.children=visible;
      return draw();
    }finally{
      root.children=children;
      for(const group of scratch.groups)if(group.original){group.parent.children=group.original;group.original=undefined;}
      if(!reentrant)this.activePasses.delete(pass);
    }
  };
  get statistics(){return Object.fromEntries([...this.batchers].map(([key,batcher])=>[key,{...batcher.statistics}]));}
  dispose():void{for(const batcher of this.batchers.values())batcher.dispose();this.batchers.clear();this.scratchByPass.clear();this.activePasses.clear();this.lastRoots.clear();}
}
