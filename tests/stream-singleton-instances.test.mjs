import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpatialWorldStream } from '../src/world/SpatialWorldStream.ts';
import { PassInstanceCuller, isInstanceCullingCandidate } from '../src/world/PassInstanceCuller.ts';
import { isStreamFrustumOnlySource } from '../src/world/StreamRenderPolicy.ts';

function box(min = -100, max = 100) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -min), new THREE.Plane(new THREE.Vector3(-1, 0, 0), max),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 100), new THREE.Plane(new THREE.Vector3(0, -1, 0), 100),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 100), new THREE.Plane(new THREE.Vector3(0, 0, -1), 100),
  );
}

function fixture(options = {}) {
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const geometry = new THREE.BoxGeometry(2, 3, 4), material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const local = geometry.boundingBox, sphere = geometry.boundingSphere;
  const model = new THREE.Matrix4().compose(new THREE.Vector3(12, 4, 5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .27), new THREE.Vector3(-2, 1, 3));
  const instance = new THREE.Matrix4().makeTranslation(40, 0, 0);
  const bounds = [...local.min.toArray(), ...local.max.toArray()];
  const matrices = new Float32Array(32);
  // Ordinary meshes have never consumed this slot. The opt-in path must also
  // ignore it even when its contents differ from the synthetic identity.
  matrices.set(new THREE.Matrix4().makeTranslation(999, 999, 999).toArray()); matrices.set(instance.toArray(), 16);
  const batches = [false, true].map((isInstancedMesh, id) => ({
    id, name: `Original batch ${id}`, geometryId: 0, materialId: 0, count: 1, isInstancedMesh,
    modelMatrix: (isInstancedMesh ? new THREE.Matrix4() : model).toArray(), renderOrder: 3 + id, layers: 65,
    castShadow: true, receiveShadow: true, matrixOffset: id * 64,
    bounds: [-100, -100, -100, 100, 100, 100],
    localBounds: isInstancedMesh ? [39, -1.5, -2, 41, 1.5, 2] : [...bounds],
    boundingSphere: { center: isInstancedMesh ? [40, 0, 0] : sphere.center.toArray(), radius: sphere.radius },
    userData: { biomeId: 'fixture', sourceObjects: [{ name: `Source ${id}`, stableId: `asset-${id}` }], detail: { authored: true } },
    sourceObjects: 1, triangles: 12,
  }));
  const definition = { id: 'fixture/cell', biomeId: 'fixture', global: false, bounds: [-100, -100, -100, 100, 100, 100],
    url: '/cell.json', metadataBytes: 1, matrixBytes: matrices.byteLength, batches: 2, sourceObjects: 2, triangles: 24,
    placements: 2, geometryIds: [0], materialIds: [0] };
  const data = { version: 1, id: definition.id, biomeId: definition.biomeId, global: false, bounds: definition.bounds,
    matrices: { url: '/cell.bin', bytes: matrices.byteLength, sha256: 'fixture' }, batches };
  const manifest = { version: 1, complete: true, cellSize: 160, chunks: [definition], geometries: [], materials: [], textures: [], images: [] };
  let geometryRefs = 0, materialRefs = 0, geometryDisposed = false;
  geometry.addEventListener('dispose', () => { geometryDisposed = true; });
  const resources = {
    async acquireGeometry() { geometryRefs++; return geometry; }, releaseGeometry() { if (--geometryRefs === 0) geometry.dispose(); },
    async acquireMaterial() { materialRefs++; return material; }, releaseMaterial() { if (--materialRefs === 0) material.dispose(); },
    get stats() { return { geometries: geometryRefs ? 1 : 0, materials: materialRefs ? 1 : 0, textures: 0, images: 0, geometryBytes: geometryRefs ? 1024 : 0, pendingGeometries: 0 }; },
    dispose() {},
  };
  const events = [];
  const stream = new SpatialWorldStream(manifest, root, { commitBudgetMs: 10000, resourceCache: resources,
    readJSON: async () => data, readBinary: async () => matrices.buffer.slice(0), ...options,
    onChange: event => { events.push(event); options.onChange?.(event); },
  });
  const start = async () => { stream.update({ position: { x: 0, y: 0, z: 0 }, altitude: 0, baseDistance: 100, viewDistance: 100 }); await stream.whenReady(); };
  return { scene, root, geometry, material, model, instance, matrices, batches, stream, events, start,
    get geometryDisposed() { return geometryDisposed; },
  };
}

test('ordinary stream batches opt into one identity instance without changing assets, placement, bounds or provenance', async () => {
  for (const instanceSingletons of [undefined, false, true]) {
    const f = fixture({ instanceSingletons }), originalMatrices = f.matrices.slice(), originalPositions = f.geometry.attributes.position.array.slice();
    try {
      await f.start();
      const [ordinary, instanced] = f.root.children[0].children;
      assert.equal(ordinary instanceof THREE.InstancedMesh, instanceSingletons === true);
      assert.ok(instanced instanceof THREE.InstancedMesh);
      assert.equal(isStreamFrustumOnlySource(ordinary), instanceSingletons === true);
      assert.equal(isStreamFrustumOnlySource(instanced), false, 'Genuine single-placement instance batches keep their original radial policy');
      for (const [index, mesh] of [ordinary, instanced].entries()) {
        const batch = f.batches[index];
        assert.equal(mesh.geometry, f.geometry); assert.equal(mesh.material, f.material);
        assert.equal(mesh.name, batch.name); assert.equal(mesh.renderOrder, batch.renderOrder); assert.equal(mesh.layers.mask, batch.layers);
        assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true); assert.equal(mesh.matrixAutoUpdate, false);
        assert.deepEqual(mesh.matrix.elements, batch.modelMatrix); assert.ok(mesh.matrixWorld.equals(new THREE.Matrix4().fromArray(batch.modelMatrix)));
        assert.deepEqual(mesh.userData, { ...batch.userData, streamBatchId: batch.id, streamChunkId: 'fixture/cell' });
        assert.equal(mesh.userData.sourceObjects, batch.userData.sourceObjects);
      }
      assert.deepEqual([...instanced.instanceMatrix.array], f.instance.toArray());
      if (instanceSingletons) {
        assert.equal(ordinary.count, 1); assert.equal(ordinary.instanceMatrix.count, 1);
        assert.deepEqual([...ordinary.instanceMatrix.array], new THREE.Matrix4().toArray());
        assert.deepEqual(ordinary.boundingBox, f.geometry.boundingBox); assert.deepEqual(ordinary.boundingSphere, f.geometry.boundingSphere);
        const point = new THREE.Vector3(.123, -.456, .789);
        assert.deepEqual(point.clone().applyMatrix4(new THREE.Matrix4().fromArray(ordinary.instanceMatrix.array)).applyMatrix4(ordinary.matrixWorld), point.clone().applyMatrix4(f.model));
      }
      assert.deepEqual(f.matrices, originalMatrices); assert.deepEqual(f.geometry.attributes.position.array, originalPositions);
      assert.equal(f.stream.stats.residentTriangles, 24); assert.equal(f.stream.stats.residentBatches, 2); assert.equal(f.stream.stats.residentPlacements, 2);
      assert.deepEqual(f.events.find(event => event.added.length).added, [ordinary, instanced]);
      assert.equal(f.stream.stats.geometries, 1, 'Both containers keep one shared geometry lease');
    } finally { f.stream.dispose(); }
    assert.equal(f.geometryDisposed, true); assert.equal(f.root.children.length, 0);
  }
});

test('singleton casters enter deferred spatial selection and its mutation/unload shadow journal', async () => {
  let culler, fixtureRef, disposedInstances = 0;
  const f = fixture({ instanceSingletons: true, onChange: event => {
    if (event.added.length) {
      assert.equal(event.added[0].parent.visible, false);
      assert.ok(event.added.every(object => isInstanceCullingCandidate(object, 0, 1)));
      for (const object of event.added) object.addEventListener('dispose', () => { disposedInstances++; });
      culler.addSources(event.added);
    }
    if (event.removed.length) { assert.equal(fixtureRef.geometryDisposed, false); culler.removeSources(event.removed); }
  } }); fixtureRef = f;
  culler = new PassInstanceCuller([], 1); culler.trackShadowContent = true; culler.deferredShadowPasses = new Set([0]);
  f.scene.add(culler.beautyGroup, ...culler.shadowGroups);
  const passes = [{ light: new THREE.DirectionalLight(), frustum: box() }];
  const prepare = () => { f.scene.updateMatrixWorld(true); culler.prepare(box(), passes); };
  const visibleSources = () => {
    const sources = [];
    culler.shadowGroups[0].traverse(object => { if (object instanceof THREE.InstancedMesh && object.visible && object.count) sources.push(culler.resolveProxyInstance(object, 0).source); });
    return sources;
  };
  try {
    await f.start(); prepare(); culler.enable();
    const [ordinary, instanced] = f.root.children[0].children;
    assert.equal(culler.canonicalSources.length, 2); assert.equal(ordinary.layers.mask, 0); assert.equal(instanced.layers.mask, 0);
    assert.equal(culler.statistics[1].selected, 0);
    culler.withShadowRegion(0, box(5, 20), () => assert.deepEqual(visibleSources(), [ordinary]));
    culler.withShadowRegion(0, box(38, 42), () => assert.deepEqual(visibleSources(), [instanced]));
    let revision = culler.shadowChanges.revision;
    ordinary.matrix.elements[12] += 8; prepare();
    assert.ok(culler.shadowChanges.revision > revision); assert.ok(culler.shadowChanges.bounds.length);
    assert.ok(culler.shadowChanges.bounds.some(bounds => bounds.containsPoint(new THREE.Vector3(12, 4, 5))), 'Old ordinary placement remains dirty');
    assert.ok(culler.shadowChanges.bounds.some(bounds => bounds.containsPoint(new THREE.Vector3(20, 4, 5))), 'New ordinary placement becomes dirty');
    revision = culler.shadowChanges.revision; f.material.alphaTest = .25; prepare();
    assert.ok(culler.shadowChanges.revision > revision, 'Shared material changes invalidate singleton shadows');
    revision = culler.shadowChanges.revision; f.stream.dispose(); prepare();
    assert.equal(culler.canonicalSources.length, 0); assert.ok(culler.shadowChanges.revision > revision);
    assert.ok(culler.shadowChanges.bounds.length); assert.equal(disposedInstances, 2); assert.equal(f.geometryDisposed, true);
  } finally { f.stream.dispose(); culler.dispose(); }
});

test('ordinary count validation remains enforced with singleton conversion enabled or disabled', async () => {
  for (const instanceSingletons of [false, true]) {
    const f = fixture({ instanceSingletons }); f.batches[0].count = 2;
    try { await assert.rejects(f.start(), /Ordinary streamed meshes must have one placement/); }
    finally { f.stream.dispose(); }
    assert.equal(f.root.children.length, 0); assert.equal(f.geometryDisposed, true);
    assert.equal(f.events.some(event => event.added.length), false);
  }
});
