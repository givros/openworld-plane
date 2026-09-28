import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';
import { markImmutableStreamSource, isImmutableStreamSource, releaseImmutableStreamSource } from '../src/world/ImmutableStreamSources.ts';

function box(min = -100, max = 100) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -min), new THREE.Plane(new THREE.Vector3(-1, 0, 0), max),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 100), new THREE.Plane(new THREE.Vector3(0, -1, 0), 100),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 100), new THREE.Plane(new THREE.Vector3(0, 0, -1), 100),
  );
}
function fixture(immutable = true) {
  const scene = new THREE.Scene(), root = new THREE.Group(), geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, 1); source.castShadow = true; root.add(source); scene.add(root);
  let callbackReads = 0, countReads = 0, count = source.count;
  Object.defineProperty(source, 'onBeforeRender', { configurable: true, get() { callbackReads++; return THREE.Object3D.prototype.onBeforeRender; } });
  Object.defineProperty(source, 'count', { configurable: true, get() { countReads++; return count; }, set(value) { count = value; } });
  if (immutable) markImmutableStreamSource(source);
  scene.updateMatrixWorld(true);
  const culler = new PassInstanceCuller([source], 1, { isImmutableSource: isImmutableStreamSource });
  culler.trackShadowContent = true; scene.add(culler.beautyGroup, ...culler.shadowGroups);
  const passes = [{ light: new THREE.DirectionalLight(), frustum: box() }];
  const prepare = (frustum = box()) => { scene.updateMatrixWorld(true); culler.prepare(frustum, passes); };
  return { scene, root, source, geometry, material, culler, passes, prepare,
    resetReads() { callbackReads = countReads = 0; }, get reads() { return { callbackReads, countReads }; },
    close() { culler.dispose(); source.dispose(); geometry.dispose(); material.dispose(); },
  };
}

test('immutable ownership skips authored source audits and revocation restores mutation detection', () => {
  for (const immutable of [false, true]) {
    const f = fixture(immutable);
    try {
      f.prepare(); f.culler.enable(); f.resetReads(); f.prepare();
      assert.equal(isImmutableStreamSource(f.source), immutable);
      if (immutable) assert.deepEqual(f.reads, { callbackReads: 0, countReads: 0 });
      else { assert.ok(f.reads.callbackReads); assert.ok(f.reads.countReads); }
      releaseImmutableStreamSource(f.source);
      f.source.setMatrixAt(0, new THREE.Matrix4().makeTranslation(20, 0, 0)); f.source.instanceMatrix.needsUpdate = true;
      f.resetReads(); f.prepare(); assert.ok(f.reads.callbackReads); assert.ok(f.reads.countReads);
      assert.equal(f.culler.canonicalSources[0].worldBox.getCenter(new THREE.Vector3()).x, 20);
      f.source.count = 2; assert.throws(f.prepare, /capacity changed/);
    } finally { f.close(); }
  }
});

test('immutable sources still observe parent transforms, geometry changes, displacement and shared material eligibility', () => {
  const f = fixture(), texture = new THREE.Texture();
  try {
    f.prepare(); f.culler.enable(); const before = f.culler.shadowChanges.revision;
    f.root.position.x = 15; f.prepare();
    assert.equal(f.culler.canonicalSources[0].worldBox.getCenter(new THREE.Vector3()).x, 15);
    assert.ok(f.culler.shadowChanges.revision > before);
    assert.ok(f.culler.shadowChanges.bounds.some(bounds => bounds.containsPoint(new THREE.Vector3(0, 0, 0))));
    f.geometry.attributes.position.setX(0, 8); f.geometry.attributes.position.needsUpdate = true; f.prepare();
    assert.equal(f.culler.canonicalSources[0].localBox.max.x, 8);
    f.material.displacementMap = texture; f.material.displacementScale = 3; f.material.displacementBias = -2; f.prepare();
    assert.equal(f.culler.canonicalSources[0].localBox.max.x, 13);
    f.material.transparent = true; assert.throws(f.prepare, /transparent/); f.material.transparent = false;
    f.source.matrixWorld.elements[0] += 1; f.source.matrixWorld.elements[15] = NaN;
    assert.throws(() => f.culler.prepare(box(), f.passes), /finite/, 'All matrix coefficients are checked even after an earlier change');
  } finally { texture.dispose(); f.close(); }
});

test('rejected immutable cells skip hidden draws but retain visibility, material and late residency journals', () => {
  const f = fixture(), added = new THREE.InstancedMesh(f.geometry, f.material, 1);
  let writes = 0;
  try {
    f.culler.deferredShadowPasses = new Set([0]); f.prepare(); f.culler.enable();
    f.root.position.x = 500; f.prepare();
    f.culler.beautyGroup.traverse(proxy => {
      if (!(proxy instanceof THREE.InstancedMesh)) return;
      let count = proxy.count, visible = proxy.visible;
      Object.defineProperty(proxy, 'count', { configurable: true, get: () => count, set: value => { writes++; count = value; } });
      Object.defineProperty(proxy, 'visible', { configurable: true, get: () => visible, set: value => { writes++; visible = value; } });
    });
    f.prepare(); assert.equal(writes, 0, 'Already-hidden sources in rejected cells skip all per-draw fields');
    let revision = f.culler.shadowChanges.revision;
    f.root.visible = false; f.prepare(); assert.ok(f.culler.shadowChanges.revision > revision);
    f.root.visible = true; f.prepare(); revision = f.culler.shadowChanges.revision;
    f.material.alphaTest = .25; f.prepare(); assert.ok(f.culler.shadowChanges.revision > revision);
    assert.ok(f.culler.shadowChanges.bounds.length, 'Offscreen material changes still refresh cached shadows');
    added.castShadow = true; markImmutableStreamSource(added); f.scene.add(added); f.scene.updateMatrixWorld(true);
    f.culler.addSources([added]); f.prepare(); assert.equal(f.culler.hasSource(added), true);
    assert.equal(f.culler.statistics[0].selected, 1, 'A new registered source is prepared before taking the hidden fast path');
    f.root.position.x = 0; f.prepare(); assert.equal(f.culler.statistics[0].selected, 2);
    f.culler.removeSources([added]); assert.equal(f.culler.hasSource(added), false);
  } finally { added.dispose(); f.close(); }
});
