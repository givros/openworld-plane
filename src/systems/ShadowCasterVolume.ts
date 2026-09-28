import * as THREE from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { isPassInstanceProxy,type InstanceClipVolume } from '../world/PassInstanceCuller';
import { copyStreamGeometryBounds } from '../world/StreamGeometryBounds';

/** Conservative caster culling: every retained source mesh is rendered at full detail. */
export class ShadowCasterVolume {
  private readonly planes:THREE.Plane[]=[];
  private readonly sphere=new THREE.Sphere();
  private empty=false;
  enabled=true;

  get clippingVolume():InstanceClipVolume {
    return {planes:this.planes,empty:this.empty,enabled:this.enabled};
  }

  update(camera:THREE.PerspectiveCamera,near:number,far:number,receivers:THREE.Box3,direction:THREE.Vector3,extrusion:number,padding:number):void{
    this.planes.length=0;this.empty=false;
    if(receivers.isEmpty())return;
    const view=camera.clone();
    // Camera.copy in r184 copies the matrix, but omits its depth convention.
    (view as THREE.PerspectiveCamera&{_reversedDepth:boolean})._reversedDepth=camera.reversedDepth;
    view.near=Math.max(.001,near);view.far=Math.max(view.near+.001,far);view.updateProjectionMatrix();
    const projection=new THREE.Matrix4().multiplyMatrices(view.projectionMatrix,camera.matrixWorldInverse);
    const clipping=new THREE.Frustum().setFromProjectionMatrix(projection,view.coordinateSystem,view.reversedDepth).planes.map(plane=>plane.clone());
    const {min,max}=receivers;
    clipping.push(new THREE.Plane(new THREE.Vector3(1,0,0),-min.x),new THREE.Plane(new THREE.Vector3(-1,0,0),max.x),
      new THREE.Plane(new THREE.Vector3(0,1,0),-min.y),new THREE.Plane(new THREE.Vector3(0,-1,0),max.y),
      new THREE.Plane(new THREE.Vector3(0,0,1),-min.z),new THREE.Plane(new THREE.Vector3(0,0,-1),max.z));
    const vertices:THREE.Vector3[]=[],cross=new THREE.Vector3(),point=new THREE.Vector3();
    // Vertices of a convex intersection are intersections of triples of planes.
    for(let i=0;i<clipping.length-2;i++)for(let j=i+1;j<clipping.length-1;j++)for(let k=j+1;k<clipping.length;k++){
      const a=clipping[i],b=clipping[j],c=clipping[k];
      cross.crossVectors(b.normal,c.normal);const determinant=a.normal.dot(cross);
      if(Math.abs(determinant)<1e-9)continue;
      point.copy(cross).multiplyScalar(-a.constant)
        .addScaledVector(new THREE.Vector3().crossVectors(c.normal,a.normal),-b.constant)
        .addScaledVector(new THREE.Vector3().crossVectors(a.normal,b.normal),-c.constant).divideScalar(determinant);
      if(clipping.every(plane=>plane.distanceToPoint(point)>=-1e-4)&&!vertices.some(vertex=>vertex.distanceToSquared(point)<1e-8))vertices.push(point.clone());
    }
    if(!vertices.length){this.empty=true;return;}
    // Degenerate clipped volumes are kept conservatively instead of rejecting casters.
    if(vertices.length<4)return;
    const upstream=direction.clone().normalize().multiplyScalar(-extrusion);
    const hull=new ConvexHull().setFromPoints([...vertices,...vertices.map(vertex=>vertex.clone().add(upstream))]);
    for(const face of hull.faces)this.planes.push(new THREE.Plane(face.normal.clone().negate(),face.constant+padding));
  }

  intersectsObject(object:THREE.Object3D):boolean{
    if(!this.enabled)return true;
    if(this.empty)return false;
    const mesh=object as THREE.Mesh&{boundingSphere?:THREE.Sphere|null;computeBoundingSphere?:()=>void};
    if(mesh.boundingSphere!==undefined){
      if(mesh.boundingSphere===null)mesh.computeBoundingSphere?.();
      if(!mesh.boundingSphere)return true;
      this.sphere.copy(mesh.boundingSphere);
    }else{
      if(!mesh.geometry)return true;
      if(!mesh.geometry.boundingSphere)mesh.geometry.computeBoundingSphere();
      if(!mesh.geometry.boundingSphere)return true;
      this.sphere.copy(mesh.geometry.boundingSphere);
    }
    this.sphere.applyMatrix4(mesh.matrixWorld);
    return this.planes.every(plane=>plane.distanceToPoint(this.sphere.center)>=-this.sphere.radius);
  }
}

/** Source bounds are revalidated against the buffers and transforms each update. */
export class ShadowReceiverBounds {
  readonly bounds=new THREE.Box3();
  private readonly local=new THREE.Box3();
  private readonly geometryStates=new WeakMap<THREE.BufferGeometry,{frame:number;revision:number;attributes:object[];arrays:unknown[];versions:number[]}>();
  private readonly instanceStates=new WeakMap<THREE.InstancedMesh,{geometry:THREE.BufferGeometry;revision:number;matrix:THREE.InstancedBufferAttribute;version:number;count:number}>();
  private frame=0;
  update(scene:THREE.Object3D,excludedRoot?:THREE.Object3D):THREE.Box3{
    this.bounds.makeEmpty();this.frame++;
    const pending=[scene];
    while(pending.length){
      const object=pending.pop()!;
      if(!object.visible||object===excludedRoot||isPassInstanceProxy(object))continue;
      for(const child of object.children)pending.push(child);
      if(!(object instanceof THREE.Mesh)||!object.receiveShadow)continue;
      const geometry=object.geometry;
      let state=this.geometryStates.get(geometry);
      if(!state){state={frame:-1,revision:0,attributes:[],arrays:[],versions:[]};this.geometryStates.set(geometry,state);}
      // A shared prototype is validated once per frame, regardless of how many
      // grass/leaf batches reference it. Only position data affects its bounds.
      if(state.frame!==this.frame){
        const attributes=[geometry.getAttribute('position'),...(geometry.morphAttributes.position??[])];
        const buffers=attributes.map(attribute=>'data' in attribute?attribute.data:attribute);
        const changed=!geometry.boundingBox||attributes.length!==state.attributes.length||attributes.some((attribute,index)=>
          attribute!==state!.attributes[index]||buffers[index].array!==state!.arrays[index]||buffers[index].version!==state!.versions[index]);
        if(changed){
          const box=geometry.boundingBox??new THREE.Box3(),sphere=geometry.boundingSphere??new THREE.Sphere();
          // The stream pack already contains exact source bounds. Reusing its
          // guarded snapshot avoids rescanning millions of vertices when a new
          // sector becomes a shadow receiver. Mutable/morphed geometry falls back.
          if(attributes.length===1&&copyStreamGeometryBounds(geometry,box,sphere)){
            geometry.boundingBox=box;geometry.boundingSphere=sphere;
          }else{geometry.computeBoundingBox();geometry.computeBoundingSphere();}
          state.revision++;
          state.attributes=attributes;state.arrays=buffers.map(buffer=>buffer.array);state.versions=buffers.map(buffer=>buffer.version);
        }
        state.frame=this.frame;
      }
      if(object instanceof THREE.InstancedMesh){
        const instances=this.instanceStates.get(object);
        if(!object.boundingBox||!instances||instances.geometry!==geometry||instances.revision!==state.revision||
          instances.matrix!==object.instanceMatrix||instances.version!==object.instanceMatrix.version||instances.count!==object.count){
          object.computeBoundingBox();object.computeBoundingSphere();
          this.instanceStates.set(object,{geometry,revision:state.revision,matrix:object.instanceMatrix,version:object.instanceMatrix.version,count:object.count});
        }
        if(object.boundingBox)this.local.copy(object.boundingBox);else continue;
      }else if(object instanceof THREE.SkinnedMesh){object.computeBoundingBox();this.local.copy(object.boundingBox!);}
      else if(geometry.boundingBox)this.local.copy(geometry.boundingBox);else continue;
      // Displacement maps use normalized samples; retain their whole possible range.
      let displacement=0;
      for(const material of Array.isArray(object.material)?object.material:[object.material]){
        const surface=material as THREE.MeshStandardMaterial;
        if(surface.displacementMap)displacement=Math.max(displacement,Math.abs(surface.displacementScale)+Math.abs(surface.displacementBias));
      }
      if(displacement)this.local.expandByScalar(displacement);
      this.bounds.union(this.local.applyMatrix4(object.matrixWorld));
    }
    // Include normal bias and numerical edge tolerances without contracting source bounds.
    return this.bounds.expandByScalar(2);
  }
}
