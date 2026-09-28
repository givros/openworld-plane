import * as THREE from 'three';

type VertexBytes = { attribute:THREE.BufferAttribute; bytes:Uint8Array; values:Uint8Array|Uint32Array; stride:number; byteStride:number };

function mapVertices(attributes:VertexBytes[],count:number,membership?:string[]){
  let capacity=1;while(capacity<count*2)capacity*=2;
  const slots=new Uint32Array(capacity),remap=new Uint32Array(count),representatives=new Uint32Array(count);
  const mask=capacity-1;
  let unique=0;
  for(let vertex=0;vertex<count;vertex++){
    let hash=2166136261;
    for(const {values,stride} of attributes){
      const end=(vertex+1)*stride;
      for(let i=vertex*stride;i<end;i++)hash=Math.imul(hash^values[i],16777619);
    }
    const member=membership?.[vertex];
    if(member)for(let i=0;i<member.length;i++)hash=Math.imul(hash^member.charCodeAt(i),16777619);
    hash^=hash>>>16;hash=Math.imul(hash,0x85ebca6b);hash^=hash>>>13;
    let slot=hash&mask;
    while(slots[slot]){
      const candidate=slots[slot]-1;
      let same=!membership||membership[candidate]===member;
      for(let a=0;same&&a<attributes.length;a++){
        const {values,stride}=attributes[a];
        for(let component=0;component<stride;component++)if(values[candidate*stride+component]!==values[vertex*stride+component]){same=false;break;}
      }
      if(same){remap[vertex]=remap[candidate];break;}
      slot=(slot+1)&mask;
    }
    if(!slots[slot]){slots[slot]=vertex+1;remap[vertex]=unique;representatives[unique++]=vertex;}
  }
  return {unique,remap,representatives};
}

/**
 * Re-index a static triangle mesh using byte-identical complete vertex records.
 * The original is never mutated/disposed; return it unchanged for unsupported
 * layouts or when the new arrays would not use less memory. Triangle/index order,
 * attribute bit patterns (including signed zero/NaN payloads), groups and bounds
 * are preserved. Distinct group memberships are never welded together.
 *
 * Callers must not use this with shaders that observe gl_VertexID or with code
 * that depends on original vertex numbers. Those uses cannot be inferred from
 * BufferGeometry. This is a load-time operation, not a per-frame operation.
 */
export function reuseExactVertices(source:THREE.BufferGeometry):THREE.BufferGeometry {
  if(source instanceof THREE.InstancedBufferGeometry||source.indirect||Object.keys(source.morphAttributes).length||
    source.hasAttribute('skinIndex')||source.hasAttribute('skinWeight'))return source;
  const position=source.getAttribute('position');
  if(!position||!Number.isInteger(position.count)||position.count<2||position.count>0x1fffffff)return source;
  const count=position.count,attributes:VertexBytes[]=[];
  let inputBytes=source.index?.array.byteLength??0,vertexBytes=0;
  for(const attribute of Object.values(source.attributes)){
    if(!(attribute instanceof THREE.BufferAttribute)||attribute instanceof THREE.InstancedBufferAttribute||
      ('isFloat16BufferAttribute' in attribute&&attribute.isFloat16BufferAttribute)||
      attribute.usage!==THREE.StaticDrawUsage||attribute.count!==count||
      !Number.isInteger(attribute.itemSize)||attribute.itemSize<1||
      attribute.array.length!==count*attribute.itemSize||
      (typeof SharedArrayBuffer!=='undefined'&&attribute.array.buffer instanceof SharedArrayBuffer))return source;
    const array=attribute.array,byteStride=array.BYTES_PER_ELEMENT*attribute.itemSize;
    const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
    const values=byteStride%4===0&&array.byteOffset%4===0?
      new Uint32Array(array.buffer,array.byteOffset,array.byteLength/4):bytes;
    attributes.push({attribute,bytes,values,stride:byteStride/values.BYTES_PER_ELEMENT,byteStride});
    inputBytes+=array.byteLength;vertexBytes+=byteStride;
  }
  const oldIndex=source.index,indexCount=oldIndex?.count??count;
  if(indexCount%3!==0)return source;
  if(oldIndex&&(oldIndex.itemSize!==1||oldIndex.normalized||oldIndex.usage!==THREE.StaticDrawUsage||
    !(oldIndex.array instanceof Uint8Array||oldIndex.array instanceof Uint16Array||oldIndex.array instanceof Uint32Array)))return source;
  for(let i=0;i<indexCount;i++)if(oldIndex&&oldIndex.array[i]>=count)return source;

  // Include group participation in the key: even identical attributes on a
  // material boundary retain their original separation.
  let membership:string[]|undefined;
  if(source.groups.length){
    membership=new Array<string>(count).fill('');
    const lastGroup=new Int32Array(count).fill(-1);
    for(let groupIndex=0;groupIndex<source.groups.length;groupIndex++){
      const group=source.groups[groupIndex];
      if(!Number.isInteger(group.start)||group.start<0||!Number.isInteger(group.count)||group.count<0||group.start+group.count>indexCount)return source;
      for(let i=group.start;i<group.start+group.count;i++){
        const vertex=oldIndex?oldIndex.array[i]:i;
        if(lastGroup[vertex]!==groupIndex){membership[vertex]+=`|${groupIndex}`;lastGroup[vertex]=groupIndex;}
      }
    }
  }
  const {unique,remap,representatives}=mapVertices(attributes,count,membership);
  if(unique===count)return source;
  // Keep the source index width when present. Index-width conversion is a
  // separate optimization and is deliberately not bundled into this experiment.
  const Index=oldIndex?oldIndex.array.constructor as THREE.TypedArrayConstructor:unique<=65535?Uint16Array:Uint32Array;
  if(unique*vertexBytes+indexCount*Index.BYTES_PER_ELEMENT>=inputBytes)return source;
  const result=new THREE.BufferGeometry();
  let attributeIndex=0;
  for(const [name,original]of Object.entries(source.attributes)){
    const {attribute,bytes,byteStride}=attributes[attributeIndex++];
    const ArrayType=attribute.array.constructor as THREE.TypedArrayConstructor;
    const array=new ArrayType(unique*attribute.itemSize),outputBytes=new Uint8Array(array.buffer);
    for(let vertex=0;vertex<unique;vertex++){
      const from=representatives[vertex]*byteStride,to=vertex*byteStride;
      for(let byte=0;byte<byteStride;byte++)outputBytes[to+byte]=bytes[from+byte];
    }
    const output=new THREE.BufferAttribute(array,original.itemSize,original.normalized);
    output.name=attribute.name;output.gpuType=attribute.gpuType;output.setUsage(attribute.usage);
    result.setAttribute(name,output);
  }
  const indices=new Index(indexCount);
  for(let i=0;i<indexCount;i++)indices[i]=remap[oldIndex?oldIndex.array[i]:i];
  const newIndex=new THREE.BufferAttribute(indices,1);
  if(oldIndex){newIndex.name=oldIndex.name;newIndex.gpuType=oldIndex.gpuType;newIndex.setUsage(oldIndex.usage);}
  result.setIndex(newIndex);
  result.name=source.name;
  result.userData={...source.userData};
  result.boundingBox=source.boundingBox?.clone()??null;
  result.boundingSphere=source.boundingSphere?.clone()??null;
  result.morphTargetsRelative=source.morphTargetsRelative;
  for(const group of source.groups)result.addGroup(group.start,group.count,group.materialIndex);
  result.setDrawRange(source.drawRange.start,source.drawRange.count);
  return result;
}

/**
 * Build a separate position-only geometry for Three's standard opaque shadow
 * depth pass. Beauty geometry remains untouched. Geometry/group/triangle order
 * and every submitted position bit remain exact; repeated positions reference
 * their FIRST ORIGINAL vertex slot. The original position attribute is shared,
 * not copied or compacted: the only additional GPU buffer is the remapped index.
 * Rejected meshes return their original geometry.
 *
 * Use ONLY on a dedicated shadow proxy, never on the beauty mesh. The caller
 * retains the same material, instance/model matrices, sides and shadow settings.
 * Re-evaluate eligibility if source geometry/material/deformation changes.
 */
export function supportsExactShadowVertices(source:THREE.Mesh):boolean {
  const geometry=source.geometry;
  if(source instanceof THREE.SkinnedMesh||source.customDepthMaterial||source.customDistanceMaterial||
    (source instanceof THREE.InstancedMesh&&source.morphTexture)||
    source.onBeforeShadow!==THREE.Object3D.prototype.onBeforeShadow||source.onAfterShadow!==THREE.Object3D.prototype.onAfterShadow||
    geometry instanceof THREE.InstancedBufferGeometry||geometry.indirect||Object.keys(geometry.morphAttributes).length||
    geometry.hasAttribute('skinIndex')||geometry.hasAttribute('skinWeight'))return false;
  const materials=Array.isArray(source.material)?source.material:[source.material];
  if(!materials.length||materials.some(material=>!(material instanceof THREE.MeshStandardMaterial)||
    material.transparent||material.opacity!==1||material.alphaTest!==0||material.alphaHash||material.alphaToCoverage||
    material.map||material.alphaMap||material.displacementMap||material.wireframe||
    (material instanceof THREE.MeshPhysicalMaterial&&material.transmission>0)))return false;
  return true;
}

export function reuseExactShadowVertices(source:THREE.Mesh):THREE.BufferGeometry {
  const geometry=source.geometry;
  if(!supportsExactShadowVertices(source))return geometry;
  const position=geometry.getAttribute('position');
  if(!(position instanceof THREE.BufferAttribute)||position instanceof THREE.InstancedBufferAttribute||position.itemSize!==3||
    ('isFloat16BufferAttribute' in position&&position.isFloat16BufferAttribute)||position.usage!==THREE.StaticDrawUsage||
    !Number.isInteger(position.count)||position.count<2||position.count>0x1fffffff||
    position.array.length!==position.count*3||
    (typeof SharedArrayBuffer!=='undefined'&&position.array.buffer instanceof SharedArrayBuffer))return geometry;
  const index=geometry.index,indexCount=index?.count??position.count;
  if(indexCount%3!==0||index&&(index.itemSize!==1||index.normalized||index.usage!==THREE.StaticDrawUsage||
    !(index.array instanceof Uint8Array||index.array instanceof Uint16Array||index.array instanceof Uint32Array)))return geometry;
  for(let i=0;i<indexCount;i++)if(index&&index.array[i]>=position.count)return geometry;
  const array=position.array,byteStride=array.BYTES_PER_ELEMENT*position.itemSize;
  const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
  const values=byteStride%4===0&&array.byteOffset%4===0?new Uint32Array(array.buffer,array.byteOffset,array.byteLength/4):bytes;
  const {unique,remap,representatives}=mapVertices([{attribute:position,bytes,values,stride:byteStride/values.BYTES_PER_ELEMENT,byteStride}],position.count);
  if(unique===position.count)return geometry;
  const Index=index?index.array.constructor as THREE.TypedArrayConstructor:position.count<=65535?Uint16Array:Uint32Array;
  const indices=new Index(indexCount);
  let changed=false;
  for(let i=0;i<indexCount;i++){
    const original=index?index.array[i]:i,target=representatives[remap[original]];
    indices[i]=target;if(target!==original)changed=true;
  }
  if(!changed)return geometry;
  const depth=new THREE.BufferGeometry();
  const outputIndex=new THREE.BufferAttribute(indices,1);
  if(index){outputIndex.name=index.name;outputIndex.gpuType=index.gpuType;outputIndex.setUsage(index.usage);}
  depth.setAttribute('position',position);depth.setIndex(outputIndex);
  depth.name=geometry.name;depth.userData={...geometry.userData};
  depth.boundingBox=geometry.boundingBox?.clone()??null;depth.boundingSphere=geometry.boundingSphere?.clone()??null;
  for(const group of geometry.groups)depth.addGroup(group.start,group.count,group.materialIndex);
  depth.setDrawRange(geometry.drawRange.start,geometry.drawRange.count);
  return depth;
}

/** Release only the shadow-owned index; retain the source's shared GPU attribute. */
export function disposeExactShadowVertices(shadow:THREE.BufferGeometry,original:THREE.BufferGeometry):void {
  if(shadow===original)return;
  for(const name of Object.keys(shadow.attributes))if(shadow.getAttribute(name)===original.getAttribute(name))shadow.deleteAttribute(name);
  shadow.dispose();
}
