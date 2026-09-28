import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StreamResourceCache } from '../src/world/StreamResources.ts';
import { copyStreamGeometryBounds } from '../src/world/StreamGeometryBounds.ts';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';

async function loadedGeometry() {
  const binary = new ArrayBuffer(48);
  new Float32Array(binary, 0, 9).set([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  new Uint32Array(binary, 36, 3).set([0, 1, 2]);
  const geometry = { id: 0, name: 'Original triangle', url: '/exact.bin', bytes: 48, sha256: 'fixture',
    attributes: { position: { byteOffset: 0, bytes: 36, count: 3, itemSize: 3, arrayType: 'Float32Array', normalized: false, gpuType: THREE.FloatType } },
    index: { byteOffset: 36, bytes: 12, count: 3, arrayType: 'Uint32Array' },
    bounds: [0, 0, 0, 2, 2, 0], boundingSphere: { center: [1, 1, 0], radius: Math.SQRT2 }, groups: [], drawRange: { start: 0, count: 3 } };
  const cache = new StreamResourceCache({ geometries: [geometry], materials: [], textures: [], images: [] }, { readBinary: async () => binary });
  return { geometry: await cache.acquireGeometry(0), close: () => cache.dispose() };
}

function culling(geometry, matrices = [new THREE.Matrix4()]) {
  const scene = new THREE.Scene(), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((matrix, index) => source.setMatrixAt(index, matrix));
  source.instanceMatrix.needsUpdate = true;
  scene.add(source); scene.updateMatrixWorld(true);
  const culler = new PassInstanceCuller([source], 0); scene.add(culler.beautyGroup);
  return { source, culler, close() { culler.dispose(); source.dispose(); material.dispose(); } };
}

function volume(minX, maxX) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -minX), new THREE.Plane(new THREE.Vector3(-1, 0, 0), maxX),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 100), new THREE.Plane(new THREE.Vector3(0, -1, 0), 100),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 100), new THREE.Plane(new THREE.Vector3(0, 0, -1), 100),
  );
}

function selected(culler) {
  const proxy = culler.beautyGroup.children[0];
  return Array.from({ length: proxy.count }, (_, slot) => culler.resolveProxyInstance(proxy, slot).instanceId);
}

test('exact loader bounds avoid position scans and are independent of public bounds mutations', async () => {
  const loaded = await loadedGeometry(), geometry = loaded.geometry, box = new THREE.Box3(), sphere = new THREE.Sphere();
  let fixture;
  try {
    assert.equal(copyStreamGeometryBounds(geometry, box, sphere), true);
    assert.deepEqual(box.max.toArray(), [2, 2, 0]); assert.equal(sphere.radius, Math.SQRT2);
    box.makeEmpty(); sphere.makeEmpty();
    geometry.boundingBox.makeEmpty(); geometry.boundingSphere.center.set(900, 900, 900); geometry.boundingSphere.radius = 0;
    geometry.attributes.position.getX = () => { throw new Error('Unexpected prototype rescan'); };
    fixture = culling(geometry);
    assert.deepEqual(fixture.culler.canonicalSources[0].worldBox.max.toArray(), [2, 2, 0]);
    fixture.culler.prepare(volume(-1, 3), []); fixture.culler.enable();
    assert.deepEqual(selected(fixture.culler), [0]);
    assert.equal(copyStreamGeometryBounds(geometry, box, sphere), true);
    assert.deepEqual(box.max.toArray(), [2, 2, 0]); assert.equal(sphere.radius, Math.SQRT2);
  } finally { fixture?.close(); loaded.close(); }
});

for (const change of ['version', 'attribute', 'array']) test(`changed position ${change} falls back to actual geometry without false negatives`, async () => {
  const loaded = await loadedGeometry(), geometry = loaded.geometry, fixture = culling(geometry);
  try {
    fixture.culler.prepare(volume(-1, 3), []); fixture.culler.enable(); assert.deepEqual(selected(fixture.culler), [0]);
    const position = geometry.attributes.position, moved = position.array.slice();
    for (let offset = 0; offset < moved.length; offset += 3) moved[offset] += 20;
    if (change === 'version') { position.array.set(moved); position.needsUpdate = true; }
    else if (change === 'attribute') geometry.setAttribute('position', new THREE.BufferAttribute(moved, 3));
    else position.array = moved;
    geometry.boundingBox.makeEmpty(); geometry.boundingSphere.radius = 0;
    assert.equal(copyStreamGeometryBounds(geometry, new THREE.Box3(), new THREE.Sphere()), false);
    fixture.culler.prepare(volume(19, 23), []);
    assert.deepEqual(selected(fixture.culler), [0]);
    assert.deepEqual(fixture.culler.canonicalSources[0].worldBox.min.toArray(), [20, 0, 0]);
    fixture.culler.prepare(volume(-1, 3), []); assert.deepEqual(selected(fixture.culler), []);
  } finally { fixture.close(); loaded.close(); }
});

test('generic geometry cannot opt in through copied userData or fabricated public bounds', async () => {
  const loaded = await loadedGeometry(), geometry = loaded.geometry.clone();
  geometry.translate(20, 0, 0); geometry.boundingBox.makeEmpty(); geometry.boundingSphere.radius = 0;
  let fixture;
  try {
    assert.equal(copyStreamGeometryBounds(geometry, new THREE.Box3(), new THREE.Sphere()), false);
    fixture = culling(geometry); fixture.culler.prepare(volume(19, 23), []); fixture.culler.enable();
    assert.deepEqual(selected(fixture.culler), [0]);
  } finally { fixture?.close(); geometry.dispose(); loaded.close(); }
});

test('trusted and scanned geometry keep identical conservative selections under shear and nonuniform scale', async () => {
  const loaded = await loadedGeometry(), generic = loaded.geometry.clone();
  const matrices = Array.from({ length: 25 }, (_, index) => new THREE.Matrix4().set(
    index % 2 ? -2 : 2, .7, .2, (index - 12) * 3,
    .1, 1.3, .4, index % 3,
    0, .3, .5, 0,
    0, 0, 0, 1,
  ));
  const fast = culling(loaded.geometry, matrices), scanned = culling(generic, matrices);
  try {
    for (let x = -40; x <= 40; x += 2) {
      const frustum = volume(x, x + 7);
      fast.culler.prepare(frustum, []); scanned.culler.prepare(frustum, []);
      fast.culler.enable(); scanned.culler.enable();
      assert.deepEqual(selected(fast.culler), selected(scanned.culler));
    }
  } finally { fast.close(); scanned.close(); generic.dispose(); loaded.close(); }
});
