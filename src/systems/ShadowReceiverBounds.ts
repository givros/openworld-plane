import * as THREE from 'three';
import { isPassInstanceProxy } from '../world/PassInstanceCuller';

interface GeometryState {
  frame:number;revision:number;
  attributes:(THREE.BufferAttribute|THREE.InterleavedBufferAttribute)[];
  arrays:unknown[];versions:number[];
}
interface ObjectBoundsState {
  matrix:number[];
  local:THREE.Box3;
  world:THREE.Box3;
}

/** Full receiver bounds with version-checked buffers and cached world-space boxes. */
export class ShadowReceiverBounds {
  readonly bounds=new THREE.Box3();
  private readonly local=new THREE.Box3();
  private readonly geometryStates=new WeakMap<THREE.BufferGeometry,GeometryState>();
  private readonly instanceStates=new WeakMap<THREE.InstancedMesh,{geometry:THREE.BufferGeometry;revision:number;matrix:THREE.InstancedBufferAttribute;array:unknown;version:number;count:number}>();
  private readonly objectStates=new WeakMap<THREE.Mesh,ObjectBoundsState>();
  private frame=0;

  private geometryState(geometry:THREE.BufferGeometry):GeometryState {
    let state=this.geometryStates.get(geometry);
    if(!state){state={frame:-1,revision:0,attributes:[],arrays:[],versions:[]};this.geometryStates.set(geometry,state);}
    if(state.frame===this.frame)return state;
    const position=geometry.getAttribute('position'),morph=geometry.morphAttributes.position;
    const count=1+(morph?.length??0);
    let changed=!geometry.boundingBox||state.attributes.length!==count;
    for(let i=0;!changed&&i<count;i++){
      const attribute=i===0?position:morph![i-1];
      const buffer='data' in attribute?attribute.data:attribute;
      changed=attribute!==state.attributes[i]||buffer.array!==state.arrays[i]||buffer.version!==state.versions[i];
    }
    if(changed){
      geometry.computeBoundingBox();geometry.computeBoundingSphere();state.revision++;
      state.attributes.length=count;state.arrays.length=count;state.versions.length=count;
      for(let i=0;i<count;i++){
        const attribute=i===0?position:morph![i-1];
        const buffer='data' in attribute?attribute.data:attribute;
        state.attributes[i]=attribute;state.arrays[i]=buffer.array;state.versions[i]=buffer.version;
      }
    }
    state.frame=this.frame;
    return state;
  }

  private include(object:THREE.Mesh):void {
    const geometry=object.geometry,state=this.geometryState(geometry);
    if(object instanceof THREE.InstancedMesh){
      const instances=this.instanceStates.get(object);
      if(!object.boundingBox||!instances||instances.geometry!==geometry||instances.revision!==state.revision||
        instances.matrix!==object.instanceMatrix||instances.array!==object.instanceMatrix.array||instances.version!==object.instanceMatrix.version||instances.count!==object.count){
        object.computeBoundingBox();object.computeBoundingSphere();
        this.instanceStates.set(object,{geometry,revision:state.revision,matrix:object.instanceMatrix,array:object.instanceMatrix.array,version:object.instanceMatrix.version,count:object.count});
      }
      if(!object.boundingBox)return;
      this.local.copy(object.boundingBox);
    }else if(object instanceof THREE.SkinnedMesh){
      object.computeBoundingBox();this.local.copy(object.boundingBox!);
    }else{
      if(!geometry.boundingBox)return;
      this.local.copy(geometry.boundingBox);
    }
    let displacement=0;
    if(Array.isArray(object.material))for(const material of object.material)displacement=Math.max(displacement,this.displacementFor(material));
    else displacement=this.displacementFor(object.material);
    if(displacement)this.local.expandByScalar(displacement);

    let cached=this.objectStates.get(object);
    if(!cached){
      cached={matrix:object.matrixWorld.toArray(),local:this.local.clone(),world:this.local.clone().applyMatrix4(object.matrixWorld)};
      this.objectStates.set(object,cached);
    }else{
      const matrix=object.matrixWorld.elements;
      let changed=!cached.local.equals(this.local);
      for(let i=0;!changed&&i<16;i++)changed=matrix[i]!==cached.matrix[i];
      if(changed){
        cached.local.copy(this.local);cached.world.copy(this.local).applyMatrix4(object.matrixWorld);
        object.matrixWorld.toArray(cached.matrix);
      }
    }
    this.bounds.union(cached.world);
  }

  private displacementFor(material:THREE.Material):number {
    const surface=material as THREE.MeshStandardMaterial;
    return surface.displacementMap?Math.abs(surface.displacementScale)+Math.abs(surface.displacementBias):0;
  }

  private readonly visit=(object:THREE.Object3D):void=>{
    if(object instanceof THREE.Mesh&&object.receiveShadow&&!isPassInstanceProxy(object))this.include(object);
  };

  update(scene:THREE.Scene):THREE.Box3 {
    this.bounds.makeEmpty();this.frame++;
    scene.traverseVisible(this.visit);
    return this.bounds.expandByScalar(2);
  }
}
