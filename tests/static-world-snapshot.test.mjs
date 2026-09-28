import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StaticWorldSnapshot } from '../src/world/StaticWorldSnapshot.ts';

function fixture() {
  const scene = new THREE.Scene(), root = new THREE.Group(), branch = new THREE.Group();
  const geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const a = new THREE.InstancedMesh(geometry, material, 2), b = new THREE.Mesh(geometry, material);
  a.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 0, 0)); a.receiveShadow = true; b.receiveShadow = true;
  b.position.set(30, 0, 0); root.add(a, branch); branch.add(b); scene.add(root);
  const snapshot = new StaticWorldSnapshot(root, {sourceIdentity: 'fixture-source-sha256'});
  const close = () => {snapshot.dispose(); a.dispose(); geometry.dispose(); material.dispose();};
  return {scene, root, branch, geometry, material, a, b, snapshot, close};
}

test('warm static preparation reuses complete bounds without inspecting source geometry', () => {
  const f = fixture(), first = f.snapshot.prepare(), key = first.cacheKey;
  assert.equal(first.processedStaticSources, 2); assert.equal(first.staticReceivers, 2);
  assert.deepEqual(first.staticReceiverBounds.min.toArray(), [-1, -1, -1]);
  assert.deepEqual(first.staticReceiverBounds.max.toArray(), [31, 1, 1]);
  f.snapshot.assertFresh();
  Object.defineProperty(f.a, 'geometry', {configurable: true, get() {throw new Error('unexpected static geometry scan');}});
  const second = f.snapshot.prepare(); assert.equal(second.processedStaticSources, 0); assert.equal(second.cacheKey, key);
  Object.defineProperty(f.a, 'geometry', {configurable: true, writable: true, value: f.geometry});
  f.close();
});

test('targeted instance and ancestor-transform edits update complete static bounds and revisions', () => {
  const f = fixture(); let old = f.snapshot.prepare().staticRevision;
  f.snapshot.mutate(['instances'], [f.a], () => {f.a.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-60, 0, 0)); f.a.instanceMatrix.needsUpdate = true;});
  let frame = f.snapshot.prepare(); assert.equal(frame.processedStaticSources, 1); assert.ok(frame.staticRevision > old);
  assert.equal(frame.staticReceiverBounds.min.x, -61); assert.equal(f.a.boundingBox.min.x, -61);
  assert.ok(f.a.boundingSphere.containsPoint(new THREE.Vector3(-60, 0, 0))); old = frame.staticRevision; f.snapshot.assertFresh();
  f.snapshot.mutate(['transforms'], [f.branch], () => f.branch.position.set(50, 2, 0));
  frame = f.snapshot.prepare(); assert.equal(frame.processedStaticSources, 1); assert.equal(frame.staticReceiverBounds.max.x, 81); assert.ok(frame.staticRevision > old);
  f.snapshot.assertFresh(); f.close();
});

test('shared geometry and displacement material edits rebuild every dependent bound', () => {
  const f = fixture(); f.snapshot.prepare();
  f.snapshot.mutate(['geometry'], [f.a], () => {f.geometry.scale(3, 1, 1);});
  let frame = f.snapshot.prepare(); assert.equal(frame.processedStaticSources, 2); assert.equal(frame.staticReceiverBounds.min.x, -3); assert.equal(frame.staticReceiverBounds.max.x, 33);
  f.snapshot.mutate(['materials'], [f.a], () => {f.material.displacementMap = new THREE.Texture(); f.material.displacementScale = 2;});
  frame = f.snapshot.prepare(); assert.equal(frame.staticReceiverBounds.min.x, -5); assert.equal(frame.staticReceiverBounds.max.x, 35);
  f.snapshot.assertFresh(); f.material.displacementMap.dispose(); f.close();
});

test('membership, visibility, source identity and sunlight have explicit independent invalidation', () => {
  const f = fixture(); const initial = f.snapshot.prepare();
  f.snapshot.setSunlight([.48, -.58, .65, 1, 10000]); let frame = f.snapshot.prepare();
  assert.equal(frame.processedStaticSources, 0); assert.equal(frame.staticRevision, initial.staticRevision); assert.equal(frame.sunlightRevision, 1); assert.notEqual(frame.cacheKey, initial.cacheKey);
  f.snapshot.setSunlight([.48, -.58, .65, 1, 10000]); assert.equal(f.snapshot.prepare().sunlightRevision, 1);
  f.snapshot.mutate(['visibility'], [f.branch], () => {f.branch.visible = false;}); frame = f.snapshot.prepare(); assert.equal(frame.staticReceivers, 1);
  f.snapshot.mutate(['membership'], [f.branch], () => {f.branch.remove(f.b);}); frame = f.snapshot.prepare(); assert.equal(frame.staticSources.length, 1);
  f.snapshot.setSourceIdentity('new-source-sha256'); frame = f.snapshot.prepare(); assert.equal(frame.rebuiltMembership, true); assert.ok(frame.cacheKey.startsWith('new-source-sha256:'));
  f.snapshot.assertFresh(); f.close();
});

test('dynamic receivers remain outside the static revision and can move every frame', () => {
  const f = fixture(), dynamic = new THREE.Mesh(f.geometry, f.material); dynamic.receiveShadow = true; f.scene.add(dynamic);
  const first = f.snapshot.prepare(); dynamic.position.set(500, 0, 0);
  let frame = f.snapshot.prepare([dynamic]); assert.equal(frame.processedStaticSources, 0); assert.equal(frame.dynamicReceivers, 1); assert.equal(frame.receiverBounds.max.x, 503); assert.equal(frame.staticRevision, first.staticRevision);
  dynamic.position.x = -500; frame = f.snapshot.prepare([dynamic]); assert.equal(frame.receiverBounds.min.x, -503);
  dynamic.receiveShadow = false; frame = f.snapshot.prepare([dynamic]); assert.equal(frame.dynamicReceivers, 0); assert.equal(frame.receiverBounds.min.x, -3);
  assert.throws(() => f.snapshot.prepare([f.a]), /both static and dynamic/); f.snapshot.assertFresh(); f.close();
});

test('debug audit catches undeclared transforms, geometry, materials and removed membership', () => {
  const f = fixture(); f.snapshot.prepare();
  f.b.position.x = 100; assert.throws(() => f.snapshot.assertFresh(), /Unreported/);
  f.snapshot.invalidate(['transforms'], [f.b]); f.snapshot.prepare(); f.snapshot.assertFresh();
  f.geometry.getAttribute('position').needsUpdate = true; assert.throws(() => f.snapshot.assertFresh(), /geometry/);
  f.snapshot.invalidate(['geometry']); f.snapshot.prepare();
  f.material.color.set('#ff0000'); assert.throws(() => f.snapshot.assertFresh(), /material/);
  f.snapshot.invalidate(['materials']); f.snapshot.prepare();
  f.branch.removeFromParent(); assert.throws(() => f.snapshot.assertFresh(), /removed/); f.close();
});

test('a targeted transaction does not conceal an unrelated undeclared group mutation', () => {
  const f = fixture(); f.snapshot.prepare(); f.branch.visible = false;
  f.snapshot.mutate(['transforms'], [f.a], () => {f.a.position.x = 3;}); f.snapshot.prepare();
  assert.throws(() => f.snapshot.assertFresh(), /Unreported.*visibility/); f.close();
});

test('material-array slot replacement is audited even when the array identity is unchanged', () => {
  const f = fixture(), other = new THREE.MeshStandardMaterial(); f.a.material = [f.material]; f.snapshot.prepare();
  f.a.material[0] = other; assert.throws(() => f.snapshot.assertFresh(), /Unreported source/);
  f.snapshot.invalidate(['materials'], [f.a]); f.snapshot.prepare(); f.snapshot.assertFresh(); other.dispose(); f.close();
});

test('external ancestor edits fail before stale bounds can be returned', () => {
  const f = fixture(); f.snapshot.prepare(); f.scene.position.x = 12;
  assert.throws(() => f.snapshot.prepare(), /ancestor changed/);
  f.snapshot.invalidate(['transforms']); const frame = f.snapshot.prepare(); assert.equal(frame.staticReceiverBounds.min.x, 11);
  f.snapshot.assertFresh(); f.close();
});

test('canonical layer virtualization can be declared without changing static revision', () => {
  const f = fixture(); f.snapshot.dispose();
  const logicalMasks = new Map([[f.a, 1], [f.b, 1]]);
  const snapshot = new StaticWorldSnapshot(f.root, {sourceIdentity: 'source', logicalLayers: source => logicalMasks.get(source)});
  const first = snapshot.prepare(); f.a.layers.mask = 0; snapshot.assertFresh(); assert.equal(snapshot.prepare().staticRevision, first.staticRevision);
  logicalMasks.set(f.a, 4); assert.throws(() => snapshot.assertFresh(), /Unreported source/);
  snapshot.invalidate(['visibility'], [f.a]); snapshot.prepare(); snapshot.assertFresh(); snapshot.dispose(); f.close();
});

test('transactions cannot be sampled halfway; failed edits stay invalidated; disposal releases borrowed inventory', () => {
  const f = fixture(); const inventory = f.snapshot.prepare().staticSources;
  assert.throws(() => f.snapshot.mutate(['transforms'], [f.a], () => {f.a.position.x = 70; f.snapshot.prepare();}), /partial/);
  assert.equal(f.snapshot.prepare().staticReceiverBounds.max.x, 81); f.snapshot.assertFresh();
  let disposed = false; f.geometry.addEventListener('dispose', () => {disposed = true;});
  f.snapshot.dispose(); f.snapshot.dispose(); assert.equal(inventory.length, 0); assert.equal(disposed, false);
  assert.throws(() => f.snapshot.prepare(), /disposed/); f.close();
});
