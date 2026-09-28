import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { reuseExactVertices, reuseExactShadowVertices, disposeExactShadowVertices } from '../src/world/reuseExactVertices.ts';

const bytes = array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
function assertSameDraw(source, output) {
  const length = source.index?.count ?? source.attributes.position.count;
  assert.equal(output.index?.count ?? output.attributes.position.count, length);
  assert.deepEqual(output.groups, source.groups);
  assert.deepEqual(output.drawRange, source.drawRange);
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const actual = output.attributes[name], stride = attribute.itemSize * attribute.array.BYTES_PER_ELEMENT;
    assert.equal(actual.itemSize, attribute.itemSize);
    assert.equal(actual.normalized, attribute.normalized);
    assert.equal(actual.gpuType, attribute.gpuType);
    assert.equal(actual.array.constructor, attribute.array.constructor);
    for (let slot = 0; slot < length; slot++) {
      const a = source.index?.array[slot] ?? slot, b = output.index?.array[slot] ?? slot;
      assert.deepEqual(bytes(actual.array).subarray(b * stride, (b + 1) * stride), bytes(attribute.array).subarray(a * stride, (a + 1) * stride));
    }
  }
}
function duplicated() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,0, 1,0,0, 0,1,0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({length:6}, () => [0,0,1]).flat(), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 1,0, 0,1, 0,0, 1,0, 0,1], 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0,1,2,3,4,5]), 1));
  return geometry;
}

test('reuses only complete byte-identical vertices and leaves input untouched', () => {
  const source = duplicated();
  source.computeBoundingBox(); source.computeBoundingSphere(); source.name = 'Original';
  source.userData = { sourceSha256:'unchanged' }; source.setDrawRange(3,3);
  const originalAttributes = {...source.attributes}, originalIndex = source.index;
  const before = Object.fromEntries(Object.entries(source.attributes).map(([k,a])=>[k, bytes(a.array).slice()]));
  const output = reuseExactVertices(source);
  assert.notEqual(output, source); assert.equal(output.attributes.position.count,3);
  assertSameDraw(source, output);
  assert.deepEqual(output.boundingBox, source.boundingBox); assert.notEqual(output.boundingBox, source.boundingBox);
  assert.deepEqual(output.boundingSphere, source.boundingSphere); assert.equal(output.name, source.name);
  assert.deepEqual(output.userData, source.userData); assert.notEqual(output.userData, source.userData);
  assert.equal(source.index, originalIndex);
  for (const [name, attr] of Object.entries(source.attributes)) { assert.equal(attr, originalAttributes[name]); assert.deepEqual(bytes(attr.array), before[name]); }
});

test('retains UV/normal/color seams and attribute GPU semantics', () => {
  for (const name of ['uv','normal','color']) {
    const source = duplicated();
    if (name === 'color') source.setAttribute('color',new THREE.Uint8BufferAttribute([1,2,3, 1,2,3, 1,2,3, 1,2,3, 1,2,3, 1,2,3],3,true));
    const attr = source.attributes[name]; attr.array[3*attr.itemSize] += 1;
    attr.gpuType = THREE.IntType;
    const output = reuseExactVertices(source);
    assert.equal(output.attributes.position.count,4); assertSameDraw(source,output);
    assert.notEqual(output.index.array[0],output.index.array[3]);
  }
});

test('keeps distinct material group memberships separate', () => {
  const source = duplicated();
  source.addGroup(0,3,0); source.addGroup(3,3,1);
  assert.equal(reuseExactVertices(source),source);
  const repeated = new THREE.BufferGeometry();
  repeated.setAttribute('position',new THREE.Float32BufferAttribute(Array(12).fill([1,2,3]).flat(),3));
  repeated.setIndex(Array.from({length:12},(_,i)=>i));
  repeated.addGroup(0,6,0); repeated.addGroup(6,6,1);
  const output=reuseExactVertices(repeated);
  assert.equal(output.attributes.position.count,2); assert.notEqual(output.index.array[0],output.index.array[6]);
  assertSameDraw(repeated,output);
});

test('distinguishes signed zero and NaN payloads without canonicalizing output', () => {
  const source = new THREE.BufferGeometry();
  const bits = new Uint32Array([0,0x80000000,0x7fc00001,0x7fc00002,0,0x80000000,0x7fc00001,0x7fc00002,0]);
  source.setAttribute('position',new THREE.BufferAttribute(new Float32Array(bits.buffer),1));
  source.setAttribute('normal',new THREE.Float32BufferAttribute(Array(27).fill(1),3));
  source.setIndex(Array.from({length:9},(_,i)=>i));
  const output = reuseExactVertices(source);
  assert.equal(output.attributes.position.count,4); assertSameDraw(source,output);
  assert.deepEqual(Array.from(new Uint32Array(output.attributes.position.array.buffer)),[0,0x80000000,0x7fc00001,0x7fc00002]);
});

test('handles nonindexed triangles and nonzero typed-array byte offsets', () => {
  const source=duplicated();source.setIndex(null);
  const array=new Float32Array(source.attributes.position.array.length+4);array.set(source.attributes.position.array,2);
  source.setAttribute('position',new THREE.BufferAttribute(array.subarray(2,-2),3));
  const output=reuseExactVertices(source);
  assert.equal(output.attributes.position.count,3); assertSameDraw(source,output);
});

test('returns original for unsupported or non-beneficial geometries', () => {
  for(const prepare of [
    g=>{g.morphAttributes.position=[g.attributes.position.clone()];},
    g=>g.setIndirect(new THREE.BufferAttribute(new Uint32Array([6,1,0,0,0]),1)),
    g=>g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(Array(24).fill(0),4)),
    g=>g.attributes.position.setUsage(THREE.DynamicDrawUsage),
    g=>g.setAttribute('offset',new THREE.InstancedBufferAttribute(new Float32Array(18),3)),
    g=>g.setAttribute('position',new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Float32Array(18),3),3,0)),
    g=>g.setAttribute('position',new THREE.Float16BufferAttribute(new Uint16Array(18),3)),
    g=>g.setAttribute('normal',new THREE.Float32BufferAttribute([1,2,3],3)),
    g=>g.setIndex([0,1,999,3,4,5]),
    g=>g.setIndex([0,1,2,3]),
  ]) { const g=duplicated();prepare(g);assert.equal(reuseExactVertices(g),g); }
  const unique=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([1,2,3,4,5,6,7,8,9],3));
  assert.equal(reuseExactVertices(unique),unique);
  const tooSmall=new THREE.BufferGeometry().setAttribute('position',new THREE.Uint8BufferAttribute([1,1,1],1));
  assert.equal(reuseExactVertices(tooSmall),tooSmall);
});

test('all indexed triangle slots preserve exact custom attribute bits over repeated runs', () => {
  const g=new THREE.BufferGeometry(),count=300;
  const data=new Uint32Array(count*3),custom=new Uint8Array(count*3);
  for(let i=0;i<count;i++){const v=i%37;data.set([v*193,v*7,0x80000000],i*3);custom.set([v,v*2,v*3],i*3);}
  g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(data.buffer),3));
  g.setAttribute('custom',new THREE.BufferAttribute(custom,3,true));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from({length:600},(_,i)=>(i*173)%count),1));
  const output=reuseExactVertices(g);assertSameDraw(g,output);assert.equal(output.attributes.position.count,37);
  assert.equal(reuseExactVertices(output),output);
});

test('shadow-only reuse retains every opaque shadow triangle while beauty normals stay unchanged', () => {
  const geometry=duplicated();
  geometry.attributes.normal.array.set([0,1,0, 0,1,0, 0,1,0],9);
  assert.equal(reuseExactVertices(geometry),geometry);
  const source=new THREE.InstancedMesh(geometry,new THREE.MeshStandardMaterial({normalMap:new THREE.Texture()}),2);
  source.setMatrixAt(0,new THREE.Matrix4().makeTranslation(11,22,33));
  const matrix=source.instanceMatrix.array.slice(),normals=bytes(geometry.attributes.normal.array).slice();
  const output=reuseExactShadowVertices(source);
  assert.notEqual(output,geometry);assert.deepEqual(Object.keys(output.attributes),['position']);
  assert.equal(output.attributes.position,geometry.attributes.position);assert.equal(output.index.count,geometry.index.count);
  assert.deepEqual(Array.from(output.index.array),[0,1,2,0,1,2]);assert.equal(new Set(output.index.array).size,3);
  const positionOnly=new THREE.BufferGeometry().setAttribute('position',geometry.attributes.position).setIndex(geometry.index);
  assertSameDraw(positionOnly,output);
  assert.equal(source.geometry,geometry);assert.deepEqual(bytes(geometry.attributes.normal.array),normals);
  assert.deepEqual(source.instanceMatrix.array,matrix);
});

test('shadow-only helper refuses coverage, deformation, custom depth and nonstandard material paths', () => {
  for(const configure of [
    m=>{m.material.alphaTest=.1;},m=>{m.material.alphaHash=true;},m=>{m.material.alphaToCoverage=true;},
    m=>{m.material.alphaMap=new THREE.Texture();},m=>{m.material.displacementMap=new THREE.Texture();},
    m=>{m.material.transparent=true;},m=>{m.material.opacity=.5;},m=>{m.material.wireframe=true;},
    m=>{m.customDepthMaterial=new THREE.MeshDepthMaterial();},m=>{m.customDistanceMaterial=new THREE.MeshDistanceMaterial();},
    m=>{m.material=new THREE.ShaderMaterial();},m=>{m.onBeforeShadow=()=>{};},
    m=>{m.geometry.morphAttributes.normal=[m.geometry.attributes.normal.clone()];},
    m=>{m.material=new THREE.MeshPhysicalMaterial({transmission:.5});},
  ]){const source=new THREE.Mesh(duplicated(),new THREE.MeshStandardMaterial());configure(source);assert.equal(reuseExactShadowVertices(source),source.geometry);}
  const source=new THREE.SkinnedMesh(duplicated(),new THREE.MeshStandardMaterial());assert.equal(reuseExactShadowVertices(source),source.geometry);
});

test('shadow disposal removes shared attributes before renderer cleanup and retains original',()=>{
  const source=new THREE.Mesh(duplicated(),new THREE.MeshStandardMaterial()),original=source.geometry;
  const shadow=reuseExactShadowVertices(source),position=original.attributes.position;
  let sourceDisposals=0,shadowDisposals=0;
  original.addEventListener('dispose',()=>sourceDisposals++);
  shadow.addEventListener('dispose',()=>{shadowDisposals++;assert.equal(shadow.getAttribute('position'),undefined);});
  disposeExactShadowVertices(shadow,original);disposeExactShadowVertices(original,original);
  assert.equal(sourceDisposals,0);assert.equal(shadowDisposals,1);assert.equal(original.attributes.position,position);
});
