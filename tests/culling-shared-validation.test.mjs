import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';

function boxFrustum(minX = -1000, maxX = 1000) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -minX), new THREE.Plane(new THREE.Vector3(-1, 0, 0), maxX),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 1000), new THREE.Plane(new THREE.Vector3(0, -1, 0), 1000),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 1000), new THREE.Plane(new THREE.Vector3(0, 0, -1), 1000),
  );
}

function fixture(options = {}, beforeConstruction = () => {}) {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const sources = [0, 200].map((x, index) => {
    const source = new THREE.InstancedMesh(geometry, material, 2);
    source.name = `Shared source ${index}`;
    source.position.x = x;
    source.setMatrixAt(1, new THREE.Matrix4().makeTranslation(50, 0, 0));
    source.instanceMatrix.needsUpdate = true;
    scene.add(source);
    return source;
  });
  scene.updateMatrixWorld(true);
  beforeConstruction({ geometry, material, sources });
  const culler = new PassInstanceCuller(sources, 0, options);
  scene.add(culler.beautyGroup);
  return { scene, geometry, material, sources, culler,
    prepare: (frustum = boxFrustum()) => culler.prepare(frustum, []),
    close: () => { culler.dispose(); for (const source of sources) source.dispose(); geometry.dispose(); material.dispose(); },
  };
}

test('shared geometry dictionaries and materials are validated once per prepare and again next prepare', () => {
  const f = fixture();
  let attributeScans = 0, materialReads = 0;
  const attributes = f.geometry.attributes;
  f.geometry.attributes = new Proxy(attributes, { ownKeys(target) { attributeScans++; return Reflect.ownKeys(target); } });
  Object.defineProperty(f.material, 'transparent', { configurable: true, get() { materialReads++; return false; } });
  try {
    f.prepare();
    assert.equal(attributeScans, 1);
    assert.equal(materialReads, 1);
    f.prepare();
    assert.equal(attributeScans, 2, 'No validation snapshot survives into the next prepare');
    assert.equal(materialReads, 2);
    f.geometry.setAttribute('lateInstanceOffset', new THREE.InstancedBufferAttribute(new Float32Array(6), 3));
    assert.throws(f.prepare, /geometry-owned instanced/);
    f.geometry.deleteAttribute('lateInstanceOffset');
    f.prepare();
  } finally { f.geometry.attributes = attributes; f.close(); }
});

test('shared geometry same-array edits and array replacements refresh every source including rejected cells', () => {
  const f = fixture(), near = boxFrustum(-3, 3);
  try {
    f.prepare(near);
    assert.deepEqual(f.culler.beautyGroup.children.map(proxy => proxy.count), [1, 0]);
    const position = f.geometry.getAttribute('position'), originalArray = position.array;
    for (let i = 0; i < position.count; i++) position.array[i * 3] -= 200;
    position.needsUpdate = true;
    f.prepare(near);
    assert.equal(position.array, originalArray);
    assert.deepEqual(f.culler.beautyGroup.children.map(proxy => proxy.count), [0, 1]);
    position.array = position.array.slice();
    for (let i = 0; i < position.count; i++) position.array[i * 3] += 200;
    f.prepare(near);
    assert.deepEqual(f.culler.beautyGroup.children.map(proxy => proxy.count), [1, 0]);
  } finally { f.close(); }
});

test('mixed and same-identity material arrays observe in-place replacement, hooks and displacement edits', () => {
  const f = fixture(), second = new THREE.MeshStandardMaterial(), shared = [f.material, second];
  f.sources[0].material = shared;
  f.sources[1].material = [second, f.material, second];
  try {
    f.prepare();
    second.transparent = true;
    assert.throws(f.prepare, /transparent/);
    second.transparent = false;
    f.prepare();
    second.onBeforeRender = () => {};
    assert.throws(f.prepare, /callbacks/);
    second.onBeforeRender = THREE.Material.prototype.onBeforeRender;
    second.displacementMap = new THREE.Texture(); second.displacementScale = 7; second.displacementBias = -2;
    f.prepare();
    assert.equal(f.sources[0].material, shared);
    assert.equal(f.culler.canonicalSources[0].worldBox.min.x, -10);
    second.displacementScale = 11;
    f.prepare();
    assert.equal(f.culler.canonicalSources[0].worldBox.min.x, -14);
    const incompatible = new THREE.ShaderMaterial();
    shared[1] = incompatible;
    assert.throws(f.prepare, /shader materials/);
    shared[1] = second; incompatible.dispose();
    f.prepare();
  } finally { second.displacementMap?.dispose(); second.dispose(); f.close(); }
});

test('shared custom-hook allowlists remain source-specific and are called anew on each prepare', () => {
  let denied, calls = 0;
  const hook = () => {};
  const options = { isMaterialCompatible(material, source) { calls++; return material.onBeforeCompile === hook && source !== denied; } };
  const f = fixture(options, ({ material }) => { material.onBeforeCompile = hook; });
  try {
    calls = 0; f.prepare(); assert.equal(calls, 2);
    calls = 0; f.prepare(); assert.equal(calls, 2);
    denied = f.sources[1];
    assert.throws(f.prepare, /compatibility allowlist/);
    denied = undefined; f.prepare();
    f.material.onBeforeCompile = () => {};
    assert.throws(f.prepare, /compatibility allowlist/);
  } finally { f.close(); }
});

test('per-source late matrix and instance-buffer mutations retain the complete live checks', () => {
  const f = fixture(), near = boxFrustum(-3, 3);
  try {
    f.prepare(near);
    f.sources[1].matrixWorld.elements[0] = 2;
    f.sources[1].matrixWorld.elements[15] = Infinity;
    assert.throws(() => f.prepare(near), /world transforms must be finite/);
    f.sources[1].matrixWorld.elements[15] = 1;
    f.sources[1].matrixWorld.elements[12] = 0;
    f.prepare(near);
    assert.deepEqual(f.culler.beautyGroup.children.map(proxy => proxy.count), [1, 1]);
    f.sources[1].setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 0, 0));
    f.sources[1].instanceMatrix.needsUpdate = true;
    f.prepare(near);
    assert.deepEqual(f.culler.beautyGroup.children.map(proxy => proxy.count), [1, 0]);
  } finally { f.close(); }
});
