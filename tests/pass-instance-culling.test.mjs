import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller, isPassInstanceProxy, isInstanceCullingCandidate } from '../src/world/PassInstanceCuller.ts';

function boxFrustum(minX, maxX, minY = -100, maxY = 100, minZ = -100, maxZ = 100) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -minX),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), maxX),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -minY),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), maxY),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), maxZ),
  );
}

function fixture(xs = [-60, -30, 0, 30, 60], shadowCount = 4) {
  const scene = new THREE.Scene(), parent = new THREE.Group();
  const geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, xs.length);
  source.name = 'Canonical trees'; source.castShadow = source.receiveShadow = true;
  source.layers.mask = 1 | (1 << 7);
  source.userData.sourceObjects = xs.map((_, index) => ({ name: `original-${index}`, components: ['trunk', 'leaves'] }));
  xs.forEach((x, index) => source.setMatrixAt(index, new THREE.Matrix4().makeTranslation(x, 0, 0)));
  source.instanceMatrix.needsUpdate = true;
  parent.add(source); scene.add(parent); scene.updateMatrixWorld(true);
  const culler = new PassInstanceCuller([source], shadowCount);
  scene.add(culler.beautyGroup, ...culler.shadowGroups);
  const lights = Array.from({ length: shadowCount }, () => new THREE.DirectionalLight());
  const passes = lights.map(light => ({ light, frustum: boxFrustum(-1000, 1000) }));
  const close = () => { culler.dispose(); source.dispose(); geometry.dispose(); material.dispose(); };
  return { scene, parent, source, geometry, material, culler, lights, passes, close };
}

function selected(culler, proxy) {
  return Array.from({ length: proxy.count }, (_, slot) => culler.resolveProxyInstance(proxy, slot).instanceId);
}

function independentBoxSelection(source, frustum, extra) {
  const prototype = new THREE.Box3().setFromBufferAttribute(source.geometry.getAttribute('position'));
  const matrix = new THREE.Matrix4(), world = new THREE.Matrix4(), box = new THREE.Box3(), support = new THREE.Vector3();
  const kept = [];
  for (let index = 0; index < source.count; index++) {
    source.getMatrixAt(index, matrix); world.multiplyMatrices(source.matrixWorld, matrix);
    box.copy(prototype).applyMatrix4(world);
    if (frustum.intersectsBox(box) && (extra?.enabled === false || !extra?.empty) &&
      (extra?.enabled === false || (extra?.planes ?? []).every(plane => {
        support.set(plane.normal.x >= 0 ? box.max.x : box.min.x, plane.normal.y >= 0 ? box.max.y : box.min.y, plane.normal.z >= 0 ? box.max.z : box.min.z);
        return plane.distanceToPoint(support) >= -1e-6 * plane.normal.length();
      }))) kept.push(index);
  }
  return kept;
}

test('finite visible range retains crossing geometry, refreshes on movement, and leaves offscreen shadows intact', () => {
  const f = fixture([0, 10, 12, 25], 1);
  try {
    const wide = boxFrustum(-100, 100);
    const view = { origin: new THREE.Vector3(), distance: 10 };
    f.culler.prepare(wide, f.passes, 1, view); f.culler.enable();
    const beauty = f.culler.beautyGroup.children[0], shadow = f.culler.shadowGroups[0].children[0];
    assert.deepEqual(selected(f.culler, beauty), [0, 1], 'an instance crossing the distance boundary retains its complete geometry');
    assert.deepEqual(selected(f.culler, shadow), [0, 1, 2, 3], 'distance applies only to beauty; upstream casters keep their independent shadow volume');
    const version = beauty.instanceMatrix.version;
    f.culler.prepare(wide, f.passes, 1, view);
    assert.equal(beauty.instanceMatrix.version, version, 'unchanged range reuses selected buffers');
    view.origin.x = 14;
    f.culler.prepare(wide, f.passes, 1, view);
    assert.deepEqual(selected(f.culler, beauty), [1, 2, 3]);
    view.distance = 1;
    f.culler.prepare(wide, f.passes, 1, view);
    assert.deepEqual(selected(f.culler, beauty), [2], 'tangent contact remains conservative');
    const matrix = new THREE.Matrix4().makeScale(30, 1, 1); matrix.setPosition(25, 0, 0);
    f.source.setMatrixAt(3, matrix); f.source.instanceMatrix.needsUpdate = true;
    f.culler.prepare(wide, f.passes, 1, { origin: new THREE.Vector3(), distance: 2 });
    assert.deepEqual(selected(f.culler, beauty), [0, 3], 'large geometry crossing the origin is retained even though its pivot lies far outside range');
    assert.equal(beauty.geometry, f.geometry); assert.equal(f.source.count, 4);
    assert.throws(() => f.culler.prepare(wide, f.passes, 1, { origin: new THREE.Vector3(), distance: NaN }), /Visible range/);
  } finally { f.close(); }
});

test('streamed batches register and release incrementally without retaining source resources or changing source data', () => {
  const f = fixture([0, 15], 1);
  const extra = new THREE.InstancedMesh(f.geometry, f.material, 1);
  extra.name = 'Arriving chunk'; extra.castShadow = true; extra.layers.mask = 1 | 64;
  extra.setMatrixAt(0, new THREE.Matrix4().makeTranslation(3, 0, 0));
  extra.instanceMatrix.needsUpdate = true;
  let geometryDisposed = false; f.geometry.addEventListener('dispose', () => { geometryDisposed = true; });
  try {
    const volume = boxFrustum(-5, 5), origin = new THREE.Vector3();
    f.culler.prepare(volume, f.passes, 1, { origin, distance: 5 }); f.culler.enable();
    const existingProxy = f.culler.beautyGroup.children[0], existingVersion = existingProxy.instanceMatrix.version;
    const chunk = new THREE.Group(); chunk.visible = false; chunk.add(extra); f.scene.add(chunk); f.scene.updateMatrixWorld(true);
    const matrices = extra.instanceMatrix.array.slice();
    f.culler.addSources([extra]);
    assert.equal(extra.layers.mask, 0, 'new canonical drawing is suppressed before the chunk is published');
    assert.equal(f.culler.canonicalSources.length, 2);
    assert.throws(() => f.culler.addSources([extra]), /already registered/);
    f.culler.prepare(volume, f.passes, 1, { origin, distance: 5 });
    const proxy = f.culler.beautyGroup.children.find(object => object.userData.canonicalSourceUUID === extra.uuid);
    assert.equal(proxy.visible, false, 'unpublished chunks cannot produce ghost draws');
    chunk.visible = true; f.scene.updateMatrixWorld(true);
    f.culler.prepare(volume, f.passes, 1, { origin, distance: 5 });
    assert.deepEqual(selected(f.culler, proxy), [0]);
    assert.equal(existingProxy.instanceMatrix.version, existingVersion);
    let disposedProxies = 0;
    for (const group of [f.culler.beautyGroup, ...f.culler.shadowGroups]) group.children.find(object => object.userData.canonicalSourceUUID === extra.uuid).addEventListener('dispose', () => { disposedProxies++; });
    f.culler.removeSources([extra]);
    assert.equal(disposedProxies, 2); assert.equal(proxy.parent, null);
    assert.equal(f.culler.resolveProxyInstance(proxy, 0), undefined);
    assert.equal(f.culler.canonicalSources.length, 1); assert.equal(extra.layers.mask, 65);
    assert.deepEqual(extra.instanceMatrix.array, matrices); assert.equal(extra.count, 1);
    assert.equal(geometryDisposed, false, 'only chunk owner can dispose shared canonical geometry');
    f.culler.prepare(volume, f.passes, 1, { origin, distance: 5 });
    assert.equal(f.culler.statistics[0].selected, 1);
  } finally { extra.dispose(); f.close(); }
});

test('cached cell rejection uses complete occupied bounds and still observes mutations in a rejected cell', () => {
  const f = fixture([0, 8], 1);
  const distant = new THREE.InstancedMesh(f.geometry, f.material, 2);
  distant.userData.spatialCell = 'distant cell'; distant.castShadow = true;
  distant.setMatrixAt(0, new THREE.Matrix4().makeTranslation(350, 0, 0));
  distant.setMatrixAt(1, new THREE.Matrix4().makeTranslation(370, 0, 0));
  distant.instanceMatrix.needsUpdate = true;
  f.parent.add(distant); f.scene.updateMatrixWorld(true); f.culler.addSources([distant]);
  try {
    const view = { origin: new THREE.Vector3(), distance: 20 }, frustum = boxFrustum(-1000, 1000);
    f.culler.prepare(frustum, f.passes, 1, view);
    const proxy = f.culler.beautyGroup.children.find(object => object.userData.canonicalSourceUUID === distant.uuid);
    assert.equal(proxy.count, 0); assert.equal(f.culler.statistics[0].cellRejected, 1);
    assert.equal(f.culler.statistics[0].cellTests, 2);
    f.culler.prepare(frustum, f.passes, 1, view);
    assert.equal(f.culler.statistics[0].cellTests, 0, 'unchanged cells and volume reuse exact rejection');
    distant.setMatrixAt(0, new THREE.Matrix4().makeTranslation(2, 0, 0)); distant.instanceMatrix.needsUpdate = true;
    f.culler.prepare(frustum, f.passes, 1, view);
    assert.deepEqual(selected(f.culler, proxy), [0], 'a mutation invalidates even a previously rejected cell');
    assert.equal(f.culler.statistics[0].cellTests, 1);
    const full = new THREE.Matrix4().makeScale(400, 1, 1); full.setPosition(350, 0, 0);
    distant.setMatrixAt(1, full); distant.instanceMatrix.needsUpdate = true;
    f.culler.prepare(frustum, f.passes, 1, view);
    assert.deepEqual(selected(f.culler, proxy), [0, 1], 'nominal cell ownership cannot reject an occupied volume spanning the near area');
  } finally { f.culler.removeSources([distant]); distant.dispose(); f.close(); }
});

test('streamed material and batch identities preserve opaque tie order independently of arrival order', () => {
  const f = fixture([0], 0);
  try {
    const a = new THREE.Mesh(f.geometry, f.material), b = new THREE.Mesh(f.geometry, f.material);
    a.userData.streamBatchId = 9; b.userData.streamBatchId = 2;
    const item = object => ({ id: object.id, object, groupOrder: 0, renderOrder: 0, material: object.material, z: 0 });
    assert.equal(f.culler.opaqueSort(item(a), item(b)), 7);
    const later = new THREE.MeshStandardMaterial(); later.userData.streamMaterialId = 1;
    f.material.userData.streamMaterialId = 3; b.material = later;
    assert.equal(f.culler.opaqueSort(item(a), item(b)), 2);
    later.dispose();
  } finally { f.close(); }
});

test('five passes match independent canonical tests and retain off-screen shadow casters', () => {
  const f = fixture(Array.from({ length: 96 }, (_, i) => i * 4 - 190));
  const beauty = boxFrustum(-20, 20);
  f.passes.forEach((pass, i) => {
    pass.frustum = boxFrustum(-170 + i * 35, 70 + i * 35);
    pass.casterVolume = { planes: [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 42 + i * 30)] };
  });
  f.culler.prepare(beauty, f.passes);
  const proxies = [f.culler.beautyGroup.children[0], ...f.culler.shadowGroups.map(group => group.children[0])];
  assert.deepEqual(selected(f.culler, proxies[0]), independentBoxSelection(f.source, beauty));
  for (let i = 0; i < f.passes.length; i++) assert.deepEqual(selected(f.culler, proxies[i + 1]), independentBoxSelection(f.source, f.passes[i].frustum, f.passes[i].casterVolume));
  assert.ok(selected(f.culler, proxies[1]).some(index => !selected(f.culler, proxies[0]).includes(index)), 'off-screen casters must survive');
  assert.equal(new Set(proxies.map(proxy => proxy.instanceMatrix)).size, 5);
  assert.equal(new Set(proxies.map(proxy => proxy.instanceMatrix.array.buffer)).size, 5);
  for (const proxy of proxies) {
    assert.equal(proxy.geometry, f.geometry); assert.equal(proxy.material, f.material);
    assert.equal(proxy.layers.mask, f.source.layers.mask); assert.equal(isPassInstanceProxy(proxy), true);
    assert.deepEqual(proxy.boundingBox, f.culler.canonicalSources[0].localBox);
    for (let slot = 0; slot < proxy.count; slot++) {
      const original = f.culler.resolveProxyInstance(proxy, slot).instanceId;
      assert.deepEqual(Array.from(proxy.instanceMatrix.array.slice(slot * 16, slot * 16 + 16)), Array.from(f.source.instanceMatrix.array.slice(original * 16, original * 16 + 16)));
    }
  }
  assert.ok(f.culler.statistics[0].boundsTests < f.source.count, 'BVH rejects outlying nodes');
  f.close();
});

test('whole-source shadow gates retain off-screen casters and invalidate without changing planes', () => {
  const f = fixture();
  f.source.computeBoundingSphere();
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -40);
  let enabled = true, calls = 0;
  f.passes[0].sourceFilter = source => {
    calls++;
    assert.equal(source, f.source); assert.equal(source.count, 5);
    assert.equal(source.instanceMatrix.array.length, 80);
    // The complete batch intersects this legacy volume. Do not reinterpret its
    // empirical filter-support margin as a stricter per-instance plane gate.
    return enabled && plane.distanceToPoint(source.boundingSphere.center) >= -source.boundingSphere.radius;
  };
  const beauty = boxFrustum(-5, 5);
  f.culler.prepare(beauty, f.passes); f.culler.enable();
  const shadow = f.culler.shadowGroups[0].children[0];
  assert.deepEqual(selected(f.culler, f.culler.beautyGroup.children[0]), [2]);
  assert.deepEqual(selected(f.culler, shadow), [0, 1, 2, 3, 4]);
  assert.ok(plane.distanceToPoint(new THREE.Vector3(-60, 0, 0)) < -2, 'off-screen member would be lost by an individual volume test');
  const revision = f.culler.canonicalSources[0].revision;
  enabled = false; f.culler.prepare(beauty, f.passes); assert.equal(shadow.count, 0);
  enabled = true; f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, shadow), [0, 1, 2, 3, 4]);
  assert.equal(calls, 3); assert.equal(f.culler.canonicalSources[0].revision, revision);
  f.culler.prepare(beauty, f.passes); assert.equal(calls, 4); assert.equal(f.culler.statistics[1].reusedSelections, 1);
  f.close();
});

test('inactive passes retain current assets and fully rebind changed source state when visible again', () => {
  const f = fixture([0, 10], 1), broad = boxFrustum(-1000, 1000);
  let allowed = true, filterCalls = 0;
  f.passes[0].sourceFilter = () => { filterCalls++; return allowed; };
  f.culler.prepare(broad, f.passes); f.culler.enable();
  const beauty = f.culler.beautyGroup.children[0], shadow = f.culler.shadowGroups[0].children[0];
  assert.deepEqual(f.culler.statistics.map(pass => pass.activeBatches), [1, 1]);
  const oldMatrix = beauty.matrixWorld.clone(), oldBounds = beauty.boundingBox.clone(), oldParent = beauty.parent;
  allowed = false;
  const geometry = new THREE.BoxGeometry(3, 6, 4), material = new THREE.MeshStandardMaterial({ color: 0x224466 });
  const depth = new THREE.MeshDepthMaterial(), distance = new THREE.MeshDistanceMaterial();
  f.source.geometry = geometry; f.source.material = material;
  f.source.customDepthMaterial = depth; f.source.customDistanceMaterial = distance;
  f.source.receiveShadow = false; f.source.renderOrder = 6; f.parent.renderOrder = 9;
  f.parent.position.set(33, 3, 22); f.source.rotation.y = .3;
  f.source.setMatrixAt(0, new THREE.Matrix4().makeTranslation(4, 0, 0));
  f.source.setMatrixAt(1, new THREE.Matrix4().makeTranslation(18, 0, 0)); f.source.instanceMatrix.needsUpdate = true;
  f.source.setColorAt(0, new THREE.Color(.2, .4, .6)); f.source.setColorAt(1, new THREE.Color(.7, .3, .1)); f.source.instanceColor.needsUpdate = true;
  f.source.computeBoundingBox(); f.source.computeBoundingSphere(); f.scene.updateMatrixWorld(true);
  f.culler.prepare(boxFrustum(300, 400), f.passes);
  for (const proxy of [beauty, shadow]) {
    assert.equal(proxy.count, 0); assert.equal(proxy.visible, false);
    assert.equal(proxy.geometry, geometry); assert.equal(proxy.material, material);
    assert.equal(proxy.customDepthMaterial, depth); assert.equal(proxy.customDistanceMaterial, distance);
  }
  assert.deepEqual(f.culler.statistics.map(pass => pass.activeBatches), [0, 0]);
  assert.equal(beauty.matrixWorld.equals(oldMatrix), true); assert.deepEqual(beauty.boundingBox, oldBounds);
  assert.equal(beauty.parent, oldParent); assert.equal(filterCalls, 2);
  allowed = true; f.culler.prepare(broad, f.passes);
  for (const proxy of [beauty, shadow]) {
    assert.equal(proxy.count, 2); assert.equal(proxy.visible, true);
    assert.equal(proxy.matrix.equals(f.source.matrixWorld), true); assert.equal(proxy.matrixWorld.equals(f.source.matrixWorld), true);
    assert.equal(proxy.parent.renderOrder, 9); assert.equal(proxy.renderOrder, 6);
    assert.deepEqual(proxy.boundingBox, f.culler.canonicalSources[0].localBox);
    assert.deepEqual(proxy.boundingSphere, f.culler.canonicalSources[0].localSphere);
    assert.deepEqual(proxy.instanceMatrix.array, f.source.instanceMatrix.array);
    assert.deepEqual(proxy.instanceColor.array, f.source.instanceColor.array);
  }
  assert.equal(beauty.castShadow, false); assert.equal(beauty.receiveShadow, false);
  assert.equal(shadow.castShadow, true); assert.equal(shadow.receiveShadow, false);
  assert.deepEqual(f.culler.statistics.map(pass => pass.activeBatches), [1, 1]);
  f.culler.prepare(broad, f.passes);
  assert.deepEqual(f.culler.statistics.map(pass => pass.activeBatches), [1, 1]);
  assert.deepEqual(f.culler.statistics.map(pass => pass.reusedSelections), [1, 1]);
  assert.equal(filterCalls, 4);
  f.close(); geometry.dispose(); material.dispose(); depth.dispose(); distance.dispose();
});

test('moving frusta reuse exact uploaded IDs while changed IDs, matrices and colors upload fresh data', () => {
  const f = fixture([-20, 0, 20], 0);
  f.source.setColorAt(0, new THREE.Color(1, 0, 0)); f.source.setColorAt(1, new THREE.Color(0, 1, 0)); f.source.setColorAt(2, new THREE.Color(0, 0, 1));
  f.source.instanceColor.needsUpdate = true;
  const proxy = f.culler.beautyGroup.children[0];
  f.culler.prepare(boxFrustum(-5, 5), []);
  const initialMatrixVersion = proxy.instanceMatrix.version, initialColorVersion = proxy.instanceColor.version;
  assert.deepEqual(selected(f.culler, proxy), [1]);
  assert.equal(f.culler.statistics[0].uploadedSelections, 1); assert.equal(f.culler.statistics[0].reusedUploads, 0);
  // Both camera planes change, forcing selection to run again, but its exact
  // canonical ID sequence is unchanged; no GPU attribute version may advance.
  f.culler.prepare(boxFrustum(-4.4, 5.6), []);
  assert.equal(f.culler.statistics[0].reusedSelections, 0); assert.equal(f.culler.statistics[0].reusedUploads, 1);
  assert.equal(f.culler.statistics[0].uploadedSelections, 0);
  assert.equal(proxy.instanceMatrix.version, initialMatrixVersion); assert.equal(proxy.instanceColor.version, initialColorVersion);
  f.culler.prepare(boxFrustum(15, 25), []);
  assert.deepEqual(selected(f.culler, proxy), [2]);
  assert.equal(proxy.count, 1); assert.equal(f.culler.statistics[0].uploadedSelections, 1);
  assert.equal(proxy.instanceMatrix.version, initialMatrixVersion + 1);
  assert.deepEqual(proxy.instanceMatrix.array.slice(0, 16), f.source.instanceMatrix.array.slice(32, 48));
  assert.deepEqual(proxy.instanceColor.array.slice(0, 3), f.source.instanceColor.array.slice(6, 9));
  f.source.setMatrixAt(2, new THREE.Matrix4().makeTranslation(21, 1, 0)); f.source.instanceMatrix.needsUpdate = true;
  f.culler.prepare(boxFrustum(15, 25), []);
  assert.deepEqual(selected(f.culler, proxy), [2]); assert.equal(f.culler.statistics[0].uploadedSelections, 1);
  assert.equal(proxy.instanceMatrix.version, initialMatrixVersion + 2);
  assert.deepEqual(proxy.instanceMatrix.array.slice(0, 16), f.source.instanceMatrix.array.slice(32, 48));
  f.source.setColorAt(2, new THREE.Color(.2, .4, .6)); f.source.instanceColor.needsUpdate = true;
  const priorColorVersion = proxy.instanceColor.version;
  f.culler.prepare(boxFrustum(15, 25), []);
  assert.equal(f.culler.statistics[0].uploadedSelections, 1); assert.equal(proxy.instanceColor.version, priorColorVersion + 1);
  assert.deepEqual(proxy.instanceColor.array.slice(0, 3), f.source.instanceColor.array.slice(6, 9));
  f.culler.prepare(boxFrustum(-25, 25), []); assert.deepEqual(selected(f.culler, proxy), [0, 1, 2]);
  const fullMatrixVersion = proxy.instanceMatrix.version;
  f.culler.prepare(boxFrustum(80, 90), []);
  assert.equal(proxy.count, 0); assert.equal(proxy.instanceMatrix.version, fullMatrixVersion);
  assert.equal(f.culler.statistics[0].uploadedSelections, 0); assert.equal(f.culler.statistics[0].reusedUploads, 0);
  f.culler.prepare(boxFrustum(-25, 25), []);
  assert.equal(proxy.instanceMatrix.version, fullMatrixVersion); assert.equal(f.culler.statistics[0].reusedUploads, 1);
  assert.deepEqual(proxy.instanceMatrix.array, f.source.instanceMatrix.array);
  f.culler.prepare(boxFrustum(-25, 25), []);
  assert.equal(f.culler.statistics[0].reusedSelections, 1); assert.equal(f.culler.statistics[0].reusedUploads, 1);
  f.close();
});

test('cached selections invalidate on each bounds dependency and disabled caster volumes', () => {
  const f = fixture();
  const beauty = boxFrustum(-15, 15);
  const volume = { planes: [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)], enabled: true, empty: false };
  f.passes[0].casterVolume = volume;
  f.culler.prepare(beauty, f.passes);
  const beautyProxy = f.culler.beautyGroup.children[0], shadowProxy = f.culler.shadowGroups[0].children[0];
  const version = beautyProxy.instanceMatrix.version, revision = f.culler.canonicalSources[0].revision;
  f.culler.prepare(beauty, f.passes);
  assert.equal(f.culler.statistics[0].reusedSelections, 1); assert.equal(f.culler.statistics[0].boundsTests, 0);
  assert.equal(beautyProxy.instanceMatrix.version, version); assert.equal(f.culler.canonicalSources[0].revision, revision);
  volume.enabled = false; f.culler.prepare(beauty, f.passes);
  assert.deepEqual(selected(f.culler, shadowProxy), [0, 1, 2, 3, 4]);
  volume.enabled = true; volume.empty = true; f.culler.prepare(beauty, f.passes); assert.equal(shadowProxy.count, 0);
  volume.empty = false; volume.planes[0].constant = -45; f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, shadowProxy), [4]);
  f.source.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 0)); f.source.instanceMatrix.needsUpdate = true;
  f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, beautyProxy), [0, 2]);
  f.source.instanceMatrix = f.source.instanceMatrix.clone(); f.source.instanceMatrix.array[12] = 80;
  f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, beautyProxy), [2]);
  f.source.instanceMatrix.array = f.source.instanceMatrix.array.slice(); f.source.instanceMatrix.array[12] = 0;
  f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, beautyProxy), [0, 2]);
  f.parent.position.x = 100; f.scene.updateMatrixWorld(true);
  f.culler.prepare(beauty, f.passes); assert.equal(beautyProxy.count, 0);
  f.parent.position.x = 0; f.scene.updateMatrixWorld(true);
  const positions = f.geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) positions.setX(i, positions.getX(i) * 30);
  positions.needsUpdate = true; f.culler.prepare(beauty, f.passes); assert.ok(selected(f.culler, beautyProxy).includes(1));
  const replaced = positions.clone(); for (let i = 0; i < replaced.count; i++) replaced.setX(i, replaced.getX(i) / 30);
  f.geometry.setAttribute('position', replaced); f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, beautyProxy), [0, 2]);
  f.source.count = 1; f.culler.prepare(beauty, f.passes); assert.deepEqual(selected(f.culler, beautyProxy), [0]);
  assert.equal(f.culler.canonicalSources[0].count, 1);
  f.close();
});

test('nested rotated nonuniform scales never reject an instance with a visible transformed vertex', () => {
  const f = fixture(Array.from({ length: 48 }, (_, i) => i * 3 - 72));
  f.parent.scale.set(4, .4, 1.8); f.parent.rotation.set(.2, .45, .7);
  f.source.scale.set(.8, 2, 1); f.source.rotation.set(.5, -.8, .25);
  f.source.position.set(10, 6, -20); f.scene.updateMatrixWorld(true);
  const geometryPosition = f.geometry.getAttribute('position'), local = new THREE.Matrix4(), world = new THREE.Matrix4(), point = new THREE.Vector3();
  let checked = 0;
  for (let i = 0; i < f.source.count; i += 3) {
    f.source.getMatrixAt(i, local); world.multiplyMatrices(f.source.matrixWorld, local);
    point.fromBufferAttribute(geometryPosition, i % geometryPosition.count).applyMatrix4(world);
    const frustum = boxFrustum(point.x - .02, point.x + .02, point.y - .02, point.y + .02, point.z - .02, point.z + .02);
    f.culler.prepare(frustum, f.passes);
    assert.ok(selected(f.culler, f.culler.beautyGroup.children[0]).includes(i), `visible vertex from sheared instance ${i} lost`);
    assert.equal(f.culler.beautyGroup.children[0].matrixWorld.equals(f.source.matrixWorld), true);
    assert.equal(f.culler.canonicalSources[0].worldBox.containsPoint(point), true);
    checked++;
  }
  assert.equal(checked, 16); f.close();
});

test('AABB hierarchy exactly matches exhaustive canonical boxes through oblique moving frusta and shear', () => {
  const f = fixture(Array.from({ length: 128 }, (_, i) => (i % 16) * 14 - 105));
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3();
  for (let i = 0; i < f.source.count; i++) {
    position.set((i % 16) * 14 - 105, (i % 5) * 3, Math.floor(i / 16) * 23 - 85);
    rotation.setFromEuler(new THREE.Euler(i * .071, i * .193, i * .047));
    scale.set(.7 + (i % 3) * .3, 1 + (i % 7) * 1.3, .6 + (i % 4) * .4);
    f.source.setMatrixAt(i, matrix.compose(position, rotation, scale));
  }
  f.source.instanceMatrix.needsUpdate = true;
  f.parent.scale.set(1.7, .65, 1.2); f.parent.rotation.set(.23, .36, -.14);
  f.source.rotation.set(.1, -.24, .18); f.scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(43, 1.7, .1, 700);
  let comparisons = 0;
  for (let pose = 0; pose < 36; pose++) {
    const angle = pose * .174;
    camera.position.set(Math.sin(angle) * 230, 25 + pose * 2.3, Math.cos(angle) * 240);
    camera.lookAt(Math.sin(angle * 3) * 30, 7, Math.cos(angle * 2) * 35); camera.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    f.passes.forEach((pass, index) => {
      pass.frustum = frustum;
      pass.casterVolume = { enabled: (pose + index) % 7 !== 0, empty: (pose + index) % 17 === 0,
        planes: [new THREE.Plane(new THREE.Vector3(1, .4, -.3).normalize(), 15 + index * 22 - pose)] };
    });
    f.culler.prepare(frustum, f.passes);
    assert.deepEqual(selected(f.culler, f.culler.beautyGroup.children[0]), independentBoxSelection(f.source, frustum)); comparisons += f.source.count;
    for (let pass = 0; pass < 4; pass++) {
      assert.deepEqual(selected(f.culler, f.culler.shadowGroups[pass].children[0]), independentBoxSelection(f.source, frustum, f.passes[pass].casterVolume)); comparisons += f.source.count;
    }
  }
  assert.equal(comparisons, 23040); f.close();
});

test('tall prototype boxes reject empty side space without removing boundary or displaced geometry', () => {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(2, 40, 2), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, 2); source.setMatrixAt(1, new THREE.Matrix4().makeTranslation(30, 0, 0)); scene.add(source); scene.updateMatrixWorld(true);
  const culler = new PassInstanceCuller([source], 0); scene.add(culler.beautyGroup);
  culler.prepare(boxFrustum(8, 12), []); assert.equal(culler.beautyGroup.children[0].count, 0);
  culler.prepare(boxFrustum(1 + 5e-7, 1.1), []); assert.deepEqual(selected(culler, culler.beautyGroup.children[0]), [0]);
  material.displacementMap = new THREE.Texture(); material.displacementScale = 10; material.displacementBias = -2;
  culler.prepare(boxFrustum(8, 12), []); assert.deepEqual(selected(culler, culler.beautyGroup.children[0]), [0]);
  culler.dispose(); source.dispose(); geometry.dispose(); material.displacementMap.dispose(); material.dispose();
});

test('enable/disable preserves full source identity, layer bits, parent visibility and canonical receiver bounds', () => {
  const f = fixture();
  const matrices = f.source.instanceMatrix.array.slice(), identities = f.source.userData.sourceObjects;
  const matrixVersion = f.source.instanceMatrix.version, originalLayers = f.source.layers.mask;
  f.culler.prepare(boxFrustum(-4, 4), f.passes); const full = f.culler.canonicalSources[0].worldBox.clone();
  f.culler.enable(); assert.equal(f.source.layers.mask, 0); assert.equal(f.source.visible, true); assert.equal(f.source.count, 5);
  assert.equal(f.culler.beautyGroup.visible, true); assert.equal(f.culler.beautyGroup.children[0].count, 1);
  assert.deepEqual(f.culler.canonicalSources[0].worldBox, full);
  f.parent.visible = false; f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  for (const group of [f.culler.beautyGroup, ...f.culler.shadowGroups]) assert.equal(group.children[0].count, 0);
  f.parent.visible = true; f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  assert.equal(f.culler.beautyGroup.children[0].count, 5);
  f.culler.disable(); assert.equal(f.source.layers.mask, originalLayers); assert.equal(f.culler.beautyGroup.visible, false);
  assert.equal(f.source.userData.sourceObjects, identities); assert.equal(f.source.instanceMatrix.version, matrixVersion);
  assert.deepEqual(f.source.instanceMatrix.array, matrices); assert.equal(f.source.count, 5);
  f.culler.enable(); f.culler.dispose(); assert.equal(f.source.layers.mask, originalLayers);
  f.close();
});

test('native directional dispatch uses one independent buffer per light and restores flags after failure', () => {
  const f = fixture();
  f.passes.forEach((pass, i) => { pass.frustum = boxFrustum(-65 + i * 25, -30 + i * 25); });
  f.culler.prepare(boxFrustum(-5, 5), f.passes); f.culler.enable();
  const state = { enabled: true, autoUpdate: false, needsUpdate: true, type: THREE.PCFShadowMap };
  const camera = new THREE.PerspectiveCamera(), uploaded = new Map(), seen = [];
  const native = lights => {
    assert.equal(state.needsUpdate, true);
    const active = f.culler.shadowGroups.filter(group => group.visible); assert.equal(active.length, 1);
    const proxy = active[0].children[0];
    // Models WebGLObjects' once-per-object-per-render-frame upload cache.
    if (!uploaded.has(proxy)) uploaded.set(proxy, proxy.instanceMatrix.array.slice(0, proxy.count * 16));
    assert.deepEqual(uploaded.get(proxy), proxy.instanceMatrix.array.slice(0, proxy.count * 16));
    seen.push({ light: lights[0], instances: selected(f.culler, proxy) });
    state.needsUpdate = false;
  };
  f.culler.renderShadowPasses(native, state, f.lights, f.scene, camera);
  assert.deepEqual(seen.map(entry => entry.light), f.lights); assert.equal(uploaded.size, 4);
  assert.deepEqual(seen.map(entry => entry.instances), f.culler.shadowGroups.map(group => selected(f.culler, group.children[0])));
  assert.equal(f.culler.shadowGroups.every(group => !group.visible), true); assert.equal(state.needsUpdate, false);
  assert.equal(f.culler.beautyGroup.children[0].castShadow, false);
  state.needsUpdate = true; let calls = 0;
  assert.throws(() => f.culler.renderShadowPasses(() => { calls++; state.needsUpdate = false; if (calls === 2) throw new Error('fixture interruption'); }, state, f.lights, f.scene, camera), /fixture interruption/);
  assert.equal(f.culler.shadowGroups.every(group => !group.visible), true); assert.equal(state.needsUpdate, true);
  assert.throws(() => f.culler.renderShadowPasses(native, state, [new THREE.DirectionalLight()], f.scene, camera), /Unprepared/);
  f.culler.disable(); let fallback = 0;
  f.culler.renderShadowPasses(lights => { fallback++; assert.equal(lights, f.lights); }, state, f.lights, f.scene, camera);
  assert.equal(fallback, 1); f.close();
});

test('colors and raycast identities follow canonical slot mapping; disposal never frees shared assets', () => {
  const f = fixture([-20, 0, 20], 0);
  f.source.setColorAt(0, new THREE.Color(1, 0, 0)); f.source.setColorAt(1, new THREE.Color(0, 1, 0)); f.source.setColorAt(2, new THREE.Color(0, 0, 1));
  f.source.instanceColor.needsUpdate = true;
  f.culler.prepare(boxFrustum(15, 25), []);
  f.culler.enable();
  const proxy = f.culler.beautyGroup.children[0];
  assert.deepEqual(Array.from(proxy.instanceColor.array.slice(0, 3)), [0, 0, 1]);
  assert.equal(f.culler.resolveProxyInstance(proxy, 0).instanceId, 2);
  const hits = []; proxy.raycast(new THREE.Raycaster(new THREE.Vector3(20, 0, 10), new THREE.Vector3(0, 0, -1)), hits);
  assert.ok(hits.length > 0); assert.equal(hits.every(hit => hit.object === f.source && hit.instanceId === 2), true);
  f.source.setColorAt(2, new THREE.Color(.4, .5, .6)); f.source.instanceColor.needsUpdate = true;
  f.culler.prepare(boxFrustum(15, 25), []);
  assert.deepEqual(proxy.instanceColor.array.slice(0, 3), f.source.instanceColor.array.slice(6, 9));
  let geometryDisposed = 0, materialDisposed = 0, proxyDisposed = 0;
  f.geometry.addEventListener('dispose', () => geometryDisposed++); f.material.addEventListener('dispose', () => materialDisposed++); proxy.addEventListener('dispose', () => proxyDisposed++);
  f.culler.dispose(); f.culler.dispose();
  assert.equal(f.culler.canonicalSources.length, 0);
  assert.equal(proxyDisposed, 1); assert.equal(geometryDisposed, 0); assert.equal(materialDisposed, 0);
  assert.equal(f.culler.beautyGroup.parent, null); assert.equal(proxy.parent, null);
  assert.throws(() => f.culler.prepare(boxFrustum(-100, 100), []), /disposed/);
  f.close();
});

test('detached source ancestors do not leave ghost geometry or shadow proxies', () => {
  const f = fixture();
  f.culler.prepare(boxFrustum(-1000, 1000), f.passes); f.culler.enable();
  f.parent.removeFromParent(); f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  for (const group of [f.culler.beautyGroup, ...f.culler.shadowGroups]) assert.equal(group.children[0].count, 0);
  f.scene.add(f.parent); f.source.removeFromParent(); f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  for (const group of [f.culler.beautyGroup, ...f.culler.shadowGroups]) assert.equal(group.children[0].count, 0);
  f.close();
});

test('hidden shadow proxy groups never add duplicate raycast hits and disabled beauty proxies are inert', () => {
  const f = fixture([0]);
  f.culler.prepare(boxFrustum(-1000, 1000), f.passes); f.culler.enable();
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
  const direct = []; f.source.raycast(ray, direct);
  const enabledHits = ray.intersectObjects(f.scene.children, true);
  assert.equal(enabledHits.length, direct.length);
  assert.equal(enabledHits.every(hit => hit.object === f.source && hit.instanceId === 0), true);
  f.culler.disable(); const disabledHits = ray.intersectObjects(f.scene.children, true);
  assert.equal(disabledHits.length, direct.length);
  assert.equal(disabledHits.every(hit => hit.object === f.source && hit.instanceId === 0), true);
  f.close();
});

test('a layer mutation while enabled fails closed and restores the canonical draw path', () => {
  const f = fixture(); const mask = f.source.layers.mask;
  f.culler.prepare(boxFrustum(-1000, 1000), f.passes); f.culler.enable();
  f.source.layers.set(3);
  assert.throws(() => f.culler.prepare(boxFrustum(-1000, 1000), f.passes), /adapter disabled/);
  assert.equal(f.culler.enabled, false); assert.equal(f.source.layers.mask, mask);
  assert.equal(f.culler.beautyGroup.visible, false);
  f.close();
});

test('canonical sphere center, ancestor group order and opaque ID tie ordering remain identical', () => {
  const f = fixture([-60, -55, 20, 180]);
  f.source.computeBoundingSphere();
  const canonicalCenter = f.source.boundingSphere.center.clone();
  f.parent.renderOrder = 7;
  const beauty = f.culler.beautyGroup.children[0];
  f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  assert.deepEqual(beauty.boundingSphere.center, canonicalCenter);
  assert.equal(beauty.parent.renderOrder, 7);
  const other = new THREE.Mesh(f.geometry, f.material);
  const item = object => ({ id: object.id, object, groupOrder: 7, renderOrder: 0, material: f.material, materialVariant: 8, z: .5 });
  assert.equal(Math.sign(f.culler.opaqueSort(item(beauty), item(other))), Math.sign(f.source.id - other.id));
  assert.equal(Math.sign(f.culler.opaqueSort(item(beauty), { ...item(other), z: .4 })), 1);
  f.source.boundingSphere.center.set(12, 3, 4);
  f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  assert.deepEqual(beauty.boundingSphere.center, f.source.boundingSphere.center);
  // A Group whose layers miss the beauty camera does not override groupOrder.
  f.parent.layers.set(3); f.culler.prepare(boxFrustum(-1000, 1000), f.passes, 1);
  assert.equal(beauty.parent, f.culler.beautyGroup);
  f.culler.prepare(boxFrustum(-1000, 1000), f.passes, 1 << 3);
  assert.equal(beauty.parent.renderOrder, 7);
  f.close();
});

test('nondefault shader hooks need an explicit identity allowlist and cannot mutate silently', () => {
  const f = fixture();
  const hook = () => {}, cacheKey = () => 'known-static-csm';
  f.material.onBeforeCompile = hook; f.material.customProgramCacheKey = cacheKey;
  assert.equal(isInstanceCullingCandidate(f.source, 0), false);
  const options = { isMaterialCompatible: material => material === f.material && material.onBeforeCompile === hook && material.customProgramCacheKey === cacheKey };
  assert.equal(isInstanceCullingCandidate(f.source, 0, 2, options), true);
  const adapter = new PassInstanceCuller([f.source], 0, options);
  f.scene.add(adapter.beautyGroup); adapter.prepare(boxFrustum(-1000, 1000), []);
  f.material.onBeforeCompile = () => {};
  assert.throws(() => adapter.prepare(boxFrustum(-1000, 1000), []), /compatibility allowlist/);
  adapter.dispose(); f.close();
});

test('eligibility leaves unsupported or inexpensive batches canonical', () => {
  const f = fixture();
  assert.equal(isInstanceCullingCandidate(f.source, 12), true);
  assert.equal(isInstanceCullingCandidate(f.source, 13), false);
  f.material.transparent = true; assert.equal(isInstanceCullingCandidate(f.source, 0), false);
  assert.throws(() => new PassInstanceCuller([f.source]), /transparent/);
  f.material.transparent = false; f.source.onBeforeRender = () => {};
  assert.equal(isInstanceCullingCandidate(f.source, 0), false);
  assert.throws(() => new PassInstanceCuller([f.source]), /callbacks/);
  f.source.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
  f.geometry.setAttribute('instanceOffset', new THREE.InstancedBufferAttribute(new Float32Array(15), 3));
  assert.equal(isInstanceCullingCandidate(f.source, 0), false);
  assert.throws(() => new PassInstanceCuller([f.source]), /geometry-owned instanced/);
  f.geometry.deleteAttribute('instanceOffset');
  assert.throws(() => new PassInstanceCuller([f.source, f.source]), /unique/);
  f.close();
});

test('live eligibility checks still reject material arrays, custom depth hooks, and newly added deformation inputs', () => {
  const f = fixture(), second = new THREE.MeshStandardMaterial(), depth = new THREE.MeshDepthMaterial();
  const frustum = boxFrustum(-1000, 1000);
  try {
    f.culler.prepare(frustum, f.passes);
    f.source.material = [f.material, second];
    second.transparent = true;
    assert.throws(() => f.culler.prepare(frustum, f.passes), /transparent/);
    second.transparent = false;
    f.culler.prepare(frustum, f.passes);
    f.source.customDepthMaterial = depth;
    depth.onBeforeRender = () => {};
    assert.throws(() => f.culler.prepare(frustum, f.passes), /callbacks/);
    depth.onBeforeRender = THREE.Material.prototype.onBeforeRender;
    f.culler.prepare(frustum, f.passes);
    f.geometry.setAttribute('newInstanceOffset', new THREE.InstancedBufferAttribute(new Float32Array(15), 3));
    assert.throws(() => f.culler.prepare(frustum, f.passes), /geometry-owned instanced/);
    f.geometry.deleteAttribute('newInstanceOffset');
    f.geometry.morphAttributes.position = [f.geometry.attributes.position];
    assert.throws(() => f.culler.prepare(frustum, f.passes), /morph geometry/);
    delete f.geometry.morphAttributes.position;
    f.culler.prepare(frustum, f.passes);
  } finally { f.close(); second.dispose(); depth.dispose(); }
});

test('eligibility retains own enumerable attribute semantics when attributes inherit unused metadata', () => {
  const f = fixture(), attributesPrototype = Object.getPrototypeOf(f.geometry.attributes), morphPrototype = Object.getPrototypeOf(f.geometry.morphAttributes);
  try {
    Object.setPrototypeOf(f.geometry.attributes, { unused: new THREE.InstancedBufferAttribute(new Float32Array(15), 3) });
    Object.setPrototypeOf(f.geometry.morphAttributes, { unused: [f.geometry.attributes.position] });
    assert.equal(isInstanceCullingCandidate(f.source, 0), true);
    f.culler.prepare(boxFrustum(-1000, 1000), f.passes);
  } finally {
    Object.setPrototypeOf(f.geometry.attributes, attributesPrototype); Object.setPrototypeOf(f.geometry.morphAttributes, morphPrototype);
    f.close();
  }
});

test('live transform validation checks every coefficient even after an earlier coefficient changed', () => {
  const f = fixture([0], 1), wide = boxFrustum(-1000, 1000);
  try {
    f.culler.prepare(wide, f.passes);
    f.source.matrixWorld.elements[0] = 2;
    f.source.matrixWorld.elements[15] = Infinity;
    assert.throws(() => f.culler.prepare(wide, f.passes), /world transforms must be finite/);
    f.source.matrixWorld.elements[15] = 1;
    f.culler.prepare(wide, f.passes);
    for (const group of [f.culler.beautyGroup, ...f.culler.shadowGroups]) {
      assert.deepEqual(group.children[0].matrixWorld.elements, f.source.matrixWorld.elements);
      assert.deepEqual(group.children[0].boundingBox, f.culler.canonicalSources[0].localBox);
    }
  } finally { f.close(); }
});

test('non-normalized oblique planes retain the exact conservative tolerance at different scales', () => {
  const f = fixture([-20, 0, 20], 1), wide = boxFrustum(-1000, 1000);
  try {
    const plane = new THREE.Plane();
    f.passes[0].casterVolume = { planes: [plane] };
    for (const scale of [1e-6, 1, 1e6]) {
      plane.normal.set(3 * scale, -4 * scale, 0);
      plane.constant = (-7 - 5 * .75e-6) * scale;
      f.culler.prepare(wide, f.passes);
      assert.deepEqual(selected(f.culler, f.culler.shadowGroups[0].children[0]), [1, 2]);
      plane.constant = (-7 - 5 * 1.25e-6) * scale;
      f.culler.prepare(wide, f.passes);
      assert.deepEqual(selected(f.culler, f.culler.shadowGroups[0].children[0]), [2]);
    }
  } finally { f.close(); }
});
