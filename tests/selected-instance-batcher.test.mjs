import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SelectedInstanceBatcher } from '../src/experiments/SelectedInstanceBatcher.ts';

function fixture(colors = false) {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const meshes = [2, 3].map((capacity, m) => {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(m * 10 + i, i, -i));
      if (colors) mesh.setColorAt(i, new THREE.Color().setRGB(i / 4, m / 2, .75));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  });
  return { geometry, material, meshes, batcher: new SelectedInstanceBatcher() };
}

test('concatenates exact selected prefixes and colors without changing source arrays', () => {
  const { meshes, batcher, geometry, material } = fixture(true);
  const originals = meshes.map(mesh => mesh.instanceMatrix.array.slice());
  meshes[1].count = 2;
  const [batch] = batcher.select(meshes);
  assert.equal(batch.geometry, geometry); assert.equal(batch.material, material);
  assert.equal(batch.count, 4); assert.equal(batch.frustumCulled, false);
  assert.deepEqual(Array.from(batch.instanceMatrix.array.slice(0, 64)), [...originals[0], ...originals[1].slice(0, 32)]);
  assert.deepEqual(Array.from(batch.instanceColor.array.slice(0, 12)), [...meshes[0].instanceColor.array, ...meshes[1].instanceColor.array.slice(0, 6)]);
  meshes.forEach((mesh, i) => assert.deepEqual(mesh.instanceMatrix.array, originals[i]));
  assert.equal(batcher.statistics.copiedInstances, 4);
  const version = batch.instanceMatrix.version;
  assert.equal(batcher.select(meshes)[0], batch);
  assert.equal(batch.instanceMatrix.version, version);
  assert.equal(batcher.statistics.reusedBatches, 1);
  meshes[0].instanceMatrix.array[12] = 90; meshes[0].instanceMatrix.needsUpdate = true;
  batcher.select(meshes); assert.equal(batch.instanceMatrix.array[12], 90);
  batcher.dispose();
});

test('equal nonidentity world transforms retain exact placement; incompatible matrices split', () => {
  const { meshes, batcher } = fixture();
  for (const mesh of meshes) mesh.matrixWorld.makeTranslation(12, 34, 56);
  let selected = batcher.select(meshes);
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].matrixWorld.elements, meshes[0].matrixWorld.elements);
  assert.equal(selected[0].matrixAutoUpdate, false); assert.equal(selected[0].matrixWorldAutoUpdate, false);
  meshes[1].matrixWorld.elements[12] = 13;
  selected = batcher.select(meshes); assert.equal(selected.length, 2);
  batcher.dispose();
});

test('reserves full capacities before selection and keeps GPU objects stable after count growth', () => {
  const { meshes, batcher } = fixture(true);
  meshes.forEach(mesh => mesh.count = 1);
  batcher.prepare(meshes);
  const [prepared] = batcher.preparationMeshes();
  assert.equal(prepared.instanceMatrix.count, 5);
  assert.equal(prepared.instanceColor.count, 5);
  assert.equal(batcher.select(meshes)[0], prepared);
  meshes[0].count = 2; meshes[1].count = 3;
  assert.equal(batcher.select(meshes)[0], prepared); assert.equal(prepared.count, 5);
  batcher.dispose();
});

test('unsupported draw semantics pass through untouched', () => {
  const { meshes, batcher } = fixture();
  const unsupported = [
    new THREE.Mesh(meshes[0].geometry, meshes[0].material),
    new THREE.InstancedMesh(meshes[0].geometry, [meshes[0].material], 1),
    new THREE.InstancedMesh(meshes[0].geometry, new THREE.MeshStandardMaterial({ transparent: true }), 1),
    new THREE.InstancedMesh(meshes[0].geometry, new THREE.ShaderMaterial(), 1),
  ];
  const callback = new THREE.InstancedMesh(meshes[0].geometry, meshes[0].material, 1);
  callback.onBeforeRender = () => {}; unsupported.push(callback);
  const morph = new THREE.InstancedMesh(meshes[0].geometry.clone(), meshes[0].material, 1);
  morph.geometry.morphAttributes.position = [morph.geometry.attributes.position.clone()]; unsupported.push(morph);
  assert.deepEqual(batcher.select(unsupported), unsupported);
  batcher.dispose();
});

test('material, layers, render order, shadow policy and custom depth split compatible groups', () => {
  for (const change of [
    mesh => mesh.material = mesh.material.clone(), mesh => mesh.layers.mask = 8,
    mesh => mesh.renderOrder = 2, mesh => mesh.castShadow = true, mesh => mesh.receiveShadow = true,
    mesh => mesh.customDepthMaterial = new THREE.MeshDepthMaterial(),
    mesh => mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial(),
  ]) {
    const { meshes, batcher } = fixture(); change(meshes[1]);
    assert.equal(batcher.select(meshes).length, 2); batcher.dispose();
  }
});

test('first group position and unsupported fallback position remain stable', () => {
  const { meshes, batcher } = fixture();
  const fallback = new THREE.Mesh(meshes[0].geometry, meshes[0].material);
  const selected = batcher.select([meshes[0], fallback, meshes[1]]);
  assert.equal(selected.length, 2); assert.equal(selected[1], fallback); assert.equal(selected[0].count, 5);
  const first = selected[0];
  assert.equal(batcher.select([meshes[1], fallback, meshes[0]])[0], first);
  assert.equal(first.instanceMatrix.array[12], 10);
  batcher.dispose();
});

test('owned buffers are disposed on growth and final disposal; shared resources stay alive', () => {
  const { meshes, batcher, geometry, material } = fixture();
  let sharedDisposals = 0, oldDisposals = 0, finalDisposals = 0;
  geometry.addEventListener('dispose', () => sharedDisposals++);
  material.addEventListener('dispose', () => sharedDisposals++);
  const [first] = batcher.select([meshes[0]]);
  first.addEventListener('dispose', () => oldDisposals++);
  const [second] = batcher.select(meshes);
  assert.notEqual(first, second); assert.equal(oldDisposals, 1);
  second.addEventListener('dispose', () => finalDisposals++);
  batcher.dispose(); batcher.dispose();
  assert.equal(finalDisposals, 1); assert.equal(sharedDisposals, 0);
});

test('stable keys reuse snapshots while shared eligibility is checked once each selection', () => {
  const { meshes, batcher } = fixture();
  batcher.select(meshes);
  assert.equal(batcher.statistics.rebuiltKeys, 2);
  batcher.select(meshes);
  assert.equal(batcher.statistics.reusedKeys, 2);
  assert.equal(batcher.statistics.rebuiltKeys, 0);
  assert.equal(batcher.statistics.geometryValidations, 1);
  assert.equal(batcher.statistics.materialValidations, 1);
  meshes[1].matrixWorld.elements[12] = 100;
  assert.equal(batcher.select(meshes).length, 2);
  assert.equal(batcher.statistics.rebuiltKeys, 1);
  meshes[1].matrixWorld.elements[12] = NaN;
  assert.equal(batcher.select(meshes)[1], meshes[1]);
  batcher.dispose();
});

test('cached keys cannot hide geometry membership, material or callback mutations', () => {
  const { meshes, batcher, geometry, material } = fixture();
  batcher.select(meshes);
  geometry.setAttribute('instanceExtra', new THREE.InstancedBufferAttribute(new Float32Array(5), 1));
  assert.deepEqual(batcher.select(meshes), meshes);
  geometry.deleteAttribute('instanceExtra');
  assert.equal(batcher.select(meshes).length, 1);
  geometry.morphAttributes.position = [geometry.attributes.position.clone()];
  assert.deepEqual(batcher.select(meshes), meshes);
  delete geometry.morphAttributes.position;
  material.transparent = true;
  assert.deepEqual(batcher.select(meshes), meshes);
  material.transparent = false;
  assert.equal(batcher.select(meshes).length, 1);
  meshes[0].onBeforeRender = () => {};
  assert.equal(batcher.select(meshes)[0], meshes[0]);
  meshes[0].onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
  meshes[0].instanceMatrix.normalized = true;
  assert.equal(batcher.select(meshes)[0], meshes[0]);
  meshes[0].instanceMatrix.normalized = false;
  meshes[1].setColorAt(0, new THREE.Color('red'));
  assert.equal(batcher.select(meshes).length, 2);
  meshes[1].instanceColor.normalized = true;
  assert.equal(batcher.select(meshes)[1], meshes[1]);
  batcher.dispose();
});

test('stable membership copies only changed members and tracks pending upload ranges', () => {
  const { meshes, batcher } = fixture(true);
  const [batch] = batcher.select(meshes);
  batch.instanceMatrix.clearUpdateRanges(); batch.instanceColor.clearUpdateRanges();
  const colorVersion = batch.instanceColor.version;
  meshes[1].instanceMatrix.array[12] = 99; meshes[1].instanceMatrix.needsUpdate = true;
  batcher.select(meshes);
  assert.equal(batcher.statistics.reusedLayouts, 1);
  assert.equal(batcher.statistics.copiedInstances, 3);
  assert.equal(batcher.statistics.copiedBytes, 3 * 64);
  assert.equal(batch.instanceColor.version, colorVersion);
  assert.deepEqual(batch.instanceMatrix.updateRanges, [{ start: 32, count: 48 }]);
  // A second selection before GPU submission must retain the first dirty range.
  meshes[0].instanceMatrix.array[12] = 88; meshes[0].instanceMatrix.needsUpdate = true;
  batcher.select(meshes);
  assert.deepEqual(batch.instanceMatrix.updateRanges, [{ start: 0, count: 80 }]);
  assert.equal(batch.instanceMatrix.array[12], 88); assert.equal(batch.instanceMatrix.array[44], 99);
  batch.instanceMatrix.clearUpdateRanges(); batch.instanceColor.clearUpdateRanges();
  const matrixVersion = batch.instanceMatrix.version;
  meshes[0].instanceColor.array[0] = .125; meshes[0].instanceColor.needsUpdate = true;
  batcher.select(meshes);
  assert.equal(batcher.statistics.copiedBytes, 2 * 12);
  assert.equal(batch.instanceMatrix.version, matrixVersion);
  assert.deepEqual(batch.instanceColor.updateRanges, [{ start: 0, count: 6 }]);
  batcher.dispose();
});

test('reused grouping handles count, member, eligibility and geometry changes exactly', () => {
  const { meshes, batcher } = fixture();
  const [batch] = batcher.select(meshes);
  meshes[0].count = 1;
  assert.equal(batcher.select(meshes)[0], batch);
  assert.equal(batch.count, 4);
  assert.deepEqual(Array.from(batch.instanceMatrix.array.slice(0, 64)), [...meshes[0].instanceMatrix.array.slice(0, 16), ...meshes[1].instanceMatrix.array]);
  batcher.select([meshes[1], meshes[0]]);
  assert.equal(batcher.statistics.reusedLayouts, 0); assert.equal(batch.instanceMatrix.array[12], 10);
  meshes[1].visible = false;
  assert.equal(batcher.select(meshes)[1], meshes[1]);
  meshes[1].visible = true;
  assert.equal(batcher.select(meshes).length, 1);
  meshes[1].geometry = meshes[1].geometry.clone();
  assert.equal(batcher.select(meshes).length, 2);
  batcher.dispose();
});

test('explicit owned revisions skip duplicate checks but retain content updates and revocation fallback', () => {
  const { meshes } = fixture(true);
  let revision = 1;
  const batcher = new SelectedInstanceBatcher({ getSourceRevision: () => revision });
  const [batch] = batcher.select(meshes);
  batcher.select(meshes);
  assert.equal(batcher.statistics.reusedOwnedKeys, 2);
  assert.equal(batcher.statistics.geometryValidations, 0); assert.equal(batcher.statistics.materialValidations, 0);
  meshes[1].count = 1; meshes[1].instanceMatrix.array[12] = 200; meshes[1].instanceMatrix.needsUpdate = true;
  assert.equal(batcher.select(meshes)[0], batch); assert.equal(batch.count, 3);
  assert.equal(batch.instanceMatrix.array[44], 200);
  meshes[1].geometry = meshes[1].geometry.clone();
  assert.equal(batcher.select(meshes).length, 2);
  assert.equal(batcher.statistics.reusedOwnedKeys, 1);
  revision++;
  meshes[1].matrixWorld.makeTranslation(10, 20, 30);
  assert.deepEqual(batcher.select(meshes)[1].matrixWorld.elements, meshes[1].matrixWorld.elements);
  assert.equal(batcher.statistics.reusedOwnedKeys, 0);
  revision = undefined;
  meshes[0].onBeforeRender = () => {};
  assert.equal(batcher.select(meshes)[0], meshes[0]);
  assert.equal(batcher.statistics.reusedOwnedKeys, 0);
  batcher.dispose();
});
