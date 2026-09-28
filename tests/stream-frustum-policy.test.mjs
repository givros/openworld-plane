import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';
import { markImmutableStreamSource, isImmutableStreamSource } from '../src/world/ImmutableStreamSources.ts';
import { markStreamFrustumOnlySource, isStreamFrustumOnlySource } from '../src/world/StreamRenderPolicy.ts';

function broadFrustum() {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 200), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 200),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 200), new THREE.Plane(new THREE.Vector3(0, -1, 0), 200),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 200), new THREE.Plane(new THREE.Vector3(0, 0, -1), 200),
  );
}

test('ordinary identity wrappers retain frustum-corner geometry beyond the genuine-instance radial range', () => {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const wrapped = new THREE.InstancedMesh(geometry, material, 1), genuine = new THREE.InstancedMesh(geometry, material, 1);
  const originalMesh = new THREE.Mesh(geometry, material), camera = new THREE.PerspectiveCamera(20, 1, .15, 100);
  for (const source of [wrapped, genuine, originalMesh]) { source.position.set(90, 0, -90); source.castShadow = true; source.updateMatrixWorld(); }
  markStreamFrustumOnlySource(wrapped); markImmutableStreamSource(wrapped); markImmutableStreamSource(genuine);
  scene.add(wrapped, genuine); scene.updateMatrixWorld(true);
  let preservePolicy = true;
  const culler = new PassInstanceCuller([wrapped, genuine], 1, { isImmutableSource: isImmutableStreamSource,
    isFrustumOnlySource: source => preservePolicy && isStreamFrustumOnlySource(source) });
  culler.deferredShadowPasses = new Set([0]); scene.add(culler.beautyGroup, ...culler.shadowGroups);
  const passes = [{ light: new THREE.DirectionalLight(), frustum: broadFrustum() }], beautyFrustum = new THREE.Frustum();
  const prepare = () => {
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(); scene.updateMatrixWorld(true);
    beautyFrustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    culler.prepare(beautyFrustum, passes, 1, { origin: new THREE.Vector3(), distance: 100 });
  };
  const drawn = root => {
    const sources = [];
    root.traverse(object => { if (object instanceof THREE.InstancedMesh && object.visible && object.count) sources.push(culler.resolveProxyInstance(object, 0).source); });
    return sources;
  };
  try {
    prepare(); culler.enable(); assert.deepEqual(drawn(culler.beautyGroup), []);
    prepare(); assert.deepEqual(drawn(culler.beautyGroup), [], 'Start with fully inactive cells');
    camera.fov = 90; prepare();
    assert.equal(beautyFrustum.intersectsObject(originalMesh), true);
    assert.ok(wrapped.position.length() > 100);
    assert.deepEqual(drawn(culler.beautyGroup), [wrapped], 'Synthetic ordinary meshes keep the native frustum path; genuine instances retain radial culling');
    prepare(); assert.deepEqual(drawn(culler.beautyGroup), [wrapped]);
    culler.withShadowRegion(0, broadFrustum(), () => assert.deepEqual(drawn(culler.shadowGroups[0]), [wrapped, genuine], 'Beauty policy does not modify shadow coverage'));
    preservePolicy = false; prepare(); assert.deepEqual(drawn(culler.beautyGroup), []);
    preservePolicy = true; prepare(); assert.deepEqual(drawn(culler.beautyGroup), [wrapped], 'A policy transition reactivates even an immutable rejected cell');
    wrapped.position.set(140, 0, -140); scene.updateMatrixWorld(true); prepare();
    assert.deepEqual(drawn(culler.beautyGroup), [], 'The original camera far plane is still enforced');
  } finally { culler.dispose(); wrapped.dispose(); genuine.dispose(); geometry.dispose(); material.dispose(); }
});
