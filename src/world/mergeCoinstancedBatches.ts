import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface SourceInstance { name:string;matrix:THREE.Matrix4;metadata:Record<string,unknown> }
export interface SourceGeometryRange {
  sourceGeometryUuid:string;vertexOffset:number;vertexCount:number;
  indexOffset:number;indexCount:number;triangleOffset:number;triangleCount:number;
}
export interface SourceComponent { instances:SourceInstance[];range:SourceGeometryRange }
export interface StaticBatch {
  geometry:THREE.BufferGeometry;material:THREE.Material|THREE.Material[];instances:SourceInstance[];
  cell:string;renderOrder:number;layers:number;components?:SourceComponent[];
}

function layoutFor(batch:StaticBatch):string|null{
  const {geometry,material,instances}=batch;
  if(instances.length<2||batch.components||Array.isArray(material)||material.transparent||material.opacity!==1||
    material.alphaTest!==0||material.alphaHash||!material.depthWrite||!material.depthTest||
    (material as THREE.MeshPhysicalMaterial).transmission>0||
    (material.blending!==THREE.NormalBlending&&material.blending!==THREE.NoBlending)||
    geometry.groups.length||geometry.drawRange.start!==0||geometry.drawRange.count!==Infinity||
    Object.keys(geometry.morphAttributes).length)return null;
  const position=geometry.getAttribute('position');
  if(!position||instances.some(instance=>!instance.matrix.elements.every(Number.isFinite)||instance.matrix.determinant()<=0))return null;
  const layout=[];
  for(const name of Object.keys(geometry.attributes).sort()){
    const attribute=geometry.getAttribute(name);
    if(attribute.count!==position.count||attribute instanceof THREE.InstancedBufferAttribute)return null;
    // The authored exports use separate attribute arrays. Leave interleaved
    // layouts untouched rather than introducing an implicit buffer conversion.
    if(attribute instanceof THREE.InterleavedBufferAttribute)return null;
    layout.push(`${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}:${attribute.gpuType}`);
  }
  return `${!!geometry.index}|${layout.join('|')}`;
}

function sameMatrices(a:SourceInstance[],b:SourceInstance[]):boolean{
  return a.length===b.length&&a.every((instance,index)=>instance.matrix.equals(b[index].matrix));
}

/** Join complete opaque prototype parts only when every instance matrix agrees. */
export function mergeCoinstancedBatches(input:Iterable<StaticBatch>){
  const batches=[...input],candidates=new Map<string,StaticBatch[][]>();
  for(const batch of batches){
    const layout=layoutFor(batch);if(layout===null)continue;
    const key=`${(batch.material as THREE.Material).uuid}|${batch.cell}|${batch.renderOrder}|${batch.layers}|${layout}|${batch.instances.length}|${batch.instances[0].matrix.elements.join(',')}`;
    let groups=candidates.get(key);if(!groups){groups=[];candidates.set(key,groups);}
    const match=groups.find(group=>sameMatrices(group[0].instances,batch.instances));
    if(match)match.push(batch);else groups.push([batch]);
  }
  const replacements=new Map<StaticBatch,StaticBatch|null>();
  const geometries=new Set<THREE.BufferGeometry>();
  const cache=new Map<string,{geometry:THREE.BufferGeometry;ranges:SourceGeometryRange[]}>();
  let mergedGroups=0,removedBatches=0,cacheHits=0;
  for(const groups of candidates.values())for(const group of groups){
    if(group.length<2)continue;
    const key=group.map(batch=>batch.geometry.uuid).join('|');
    let merged=cache.get(key);
    if(merged)cacheHits++;
    else{
      // Concatenate original arrays directly. No transform baking, welding,
      // attribute stripping, quantization or per-instance geometry expansion.
      const geometry=mergeGeometries(group.map(batch=>batch.geometry),false);
      if(!geometry)continue;
      geometry.computeBoundingBox();geometry.computeBoundingSphere();
      let vertexOffset=0,indexOffset=0,triangleOffset=0;
      const ranges=group.map(batch=>{
        const source=batch.geometry,vertexCount=source.getAttribute('position').count,indexCount=source.index?.count??0;
        const triangleCount=(source.index?.count??vertexCount)/3;
        const range={sourceGeometryUuid:source.uuid,vertexOffset,vertexCount,indexOffset,indexCount,triangleOffset,triangleCount};
        vertexOffset+=vertexCount;indexOffset+=indexCount;triangleOffset+=triangleCount;return range;
      });
      merged={geometry,ranges};cache.set(key,merged);geometries.add(geometry);
    }
    const first=group[0];
    replacements.set(first,{...first,geometry:merged.geometry,components:group.map((batch,index)=>({instances:batch.instances,range:merged!.ranges[index]}))});
    for(let i=1;i<group.length;i++)replacements.set(group[i],null);
    mergedGroups++;removedBatches+=group.length-1;
  }
  return{batches:batches.flatMap(batch=>replacements.has(batch)?replacements.get(batch)?[replacements.get(batch)!]:[]:[batch]),
    geometries,mergedGroups,removedBatches,cacheHits};
}
