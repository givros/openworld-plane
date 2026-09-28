import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeCoinstancedBatches } from '../src/world/mergeCoinstancedBatches.ts';

function geometry(offset=0,quad=false){
  const positions=quad?[offset,0,0,offset+2,0,0,offset+2,3,0,offset,3,0]:[offset,0,0,offset+2,0,0,offset,3,0];
  const count=positions.length/3,g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('normal',new THREE.Float32BufferAttribute(Array.from({length:count},(_,i)=>[.1*i,.2,1]).flat(),3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:count},(_,i)=>[.15,.2+i*.1,.7]).flat(),3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(Array.from({length:count},(_,i)=>[i/count,.4]).flat(),2));
  g.setAttribute('uv1',new THREE.Float32BufferAttribute(Array.from({length:count},(_,i)=>[.8,i/count]).flat(),2));
  g.setAttribute('surfaceId',new THREE.Uint16BufferAttribute(Array.from({length:count},(_,i)=>i+offset),1));
  g.setIndex(quad?[0,1,2,0,2,3]:[0,1,2]);return g;
}
function transforms(shift=0){
  return [0,1].map(i=>new THREE.Matrix4().compose(new THREE.Vector3(1060+shift+i*14,5,1060),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,.7+i*.3,.1)),new THREE.Vector3(2,.7,1.4)));
}
function batch(g,material,matrices=transforms(),name='part'){
  return {geometry:g,material,cell:'6,6',renderOrder:3,layers:1,
    instances:matrices.map((matrix,index)=>({matrix,name:`${name}-${index}`,metadata:{stableId:`REG_TEST_${name}_${index}`,material_role:'fixture-stone',nested:{part:name,index}}}))};
}

test('coinstanced merging preserves all arrays, matrices, ranges and component metadata',()=>{
  const material=new THREE.MeshStandardMaterial({vertexColors:true}),a=geometry(),b=geometry(7,true);
  const source=[batch(a,material,transforms(),'a'),batch(b,material,transforms(),'b')];
  const result=mergeCoinstancedBatches(source);assert.equal(result.batches.length,1);assert.equal(result.removedBatches,1);
  const merged=result.batches[0];assert.equal(merged.material,material);assert.equal(merged.instances,source[0].instances);
  for(const key of Object.keys(a.attributes))assert.deepEqual(Array.from(merged.geometry.getAttribute(key).array),[...a.getAttribute(key).array,...b.getAttribute(key).array],key);
  assert.deepEqual(Array.from(merged.geometry.index.array),[0,1,2,3,4,5,3,5,6]);
  assert.deepEqual(merged.components.map(component=>component.range),[
    {sourceGeometryUuid:a.uuid,vertexOffset:0,vertexCount:3,indexOffset:0,indexCount:3,triangleOffset:0,triangleCount:1},
    {sourceGeometryUuid:b.uuid,vertexOffset:3,vertexCount:4,indexOffset:3,indexCount:6,triangleOffset:1,triangleCount:2},
  ]);
  for(let part=0;part<2;part++){
    const component=merged.components[part];assert.equal(component.instances,source[part].instances);
    for(let i=0;i<2;i++)for(let v=0;v<component.range.vertexCount;v++){
      const actual=new THREE.Vector3().fromBufferAttribute(merged.geometry.getAttribute('position'),component.range.vertexOffset+v).applyMatrix4(merged.instances[i].matrix);
      const expected=new THREE.Vector3().fromBufferAttribute(source[part].geometry.getAttribute('position'),v).applyMatrix4(source[part].instances[i].matrix);
      assert.deepEqual(actual.toArray(),expected.toArray());
    }
  }
  assert.equal(merged.geometry.index.count/3*merged.instances.length,6);
});

test('identical ordered geometry lists share one merged buffer across cells',()=>{
  const material=new THREE.MeshStandardMaterial(),a=geometry(),b=geometry(5);
  const second=[batch(a,material,transforms(320),'a2'),batch(b,material,transforms(320),'b2')];
  for(const entry of second)entry.cell='8,6';
  const result=mergeCoinstancedBatches([batch(a,material),batch(b,material),...second]);
  assert.equal(result.batches.length,2);assert.equal(result.geometries.size,1);assert.equal(result.cacheHits,1);
  assert.equal(result.batches[0].geometry,result.batches[1].geometry);
  assert.notDeepEqual(result.batches[0].instances[0].matrix.elements,result.batches[1].instances[0].matrix.elements);
});

test('nonmatching instance sequences or rendering layouts stay separate',()=>{
  const cases={
    laterMatrix:(_a,b)=>{b.instances[1].matrix.elements[12]+=.000001;},
    reordered:(_a,b)=>{b.instances.reverse();},
    cell:(_a,b)=>{b.cell='7,6';},renderOrder:(_a,b)=>{b.renderOrder++;},layers:(_a,b)=>{b.layers=2;},
    material:(_a,b)=>{b.material=b.material.clone();},
    attribute:(_a,b)=>{b.geometry.deleteAttribute('uv1');},
    precision:(_a,b)=>{b.geometry.setAttribute('surfaceId',new THREE.Uint32BufferAttribute([0,1,2],1));},
    normalized:(_a,b)=>{b.geometry.getAttribute('surfaceId').normalized=true;},
    groups:(_a,b)=>{b.geometry.addGroup(0,3,0);},range:(_a,b)=>{b.geometry.setDrawRange(0,3);},
    reflected:(_a,b)=>{b.instances[1].matrix.scale(new THREE.Vector3(-1,1,1));},
    transparent:(a)=>{a.material.transparent=true;},opacity:(a)=>{a.material.opacity=.7;},
    transmission:(a)=>{a.material.transmission=.5;},alphaTest:(a)=>{a.material.alphaTest=.5;},
    morph:(_a,b)=>{b.geometry.morphAttributes.position=[b.geometry.getAttribute('position').clone()];},
  };
  for(const [name,mutate] of Object.entries(cases)){
    const material=new THREE.MeshStandardMaterial(),a=batch(geometry(),material),b=batch(geometry(4),material);
    mutate(a,b);const result=mergeCoinstancedBatches([a,b]);
    assert.deepEqual(result.batches,[a,b],name);assert.equal(result.geometries.size,0,name);
  }
});
