import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { computeCascadeExtents, computeStableShadowDistanceEnvelope, StableShadowProjection } from '../src/experiments/StableShadowProjection.ts';
import { Atmosphere } from '../src/systems/Atmosphere.ts';
import { landscapeVisibility } from '../src/systems/LandscapeVisibility.ts';

const direction = new THREE.Vector3(.48, -.58, .65).normalize();
const options = (changes = {}) => ({
  lightDirection: direction, referenceWidth: 1000, referenceHeight: 1000,
  minimumNativeWidth: 800, minimumNativeHeight: 800, nativeMapSize: 4096, maxTextureSize: 8192,
  depthAxisOrigin: 5000, near: 1, far: 10000, ...changes,
});
const native = { width: 900, height: 900, mapSize: 4096 };
function fixture(changes = {}) {
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight(), reference = new StableShadowProjection(options(changes));
  light.shadow.camera.near = 1; light.shadow.camera.far = 10000;
  scene.add(light, light.target);
  const move = position => { light.position.copy(position); light.target.position.copy(position).add(direction); scene.updateMatrixWorld(true); };
  move(new THREE.Vector3(100, 200, 300));
  return { scene, light, reference, move };
}
function mutableState(light) {
  const camera = light.shadow.camera;
  return { position: light.position.toArray(), target: light.target.position.toArray(), mapSize: light.shadow.mapSize.toArray(),
    extents: [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far], projection: camera.projectionMatrix.toArray() };
}

test('reference extents reproduce installed CSM diagonal coverage and corrected fade expansion', () => {
  const camera = new THREE.PerspectiveCamera(48, 1.6, .15, 16000), breaks = [.12, .32, .62, 1];
  const scene = new THREE.Scene(), csm = new CSM({ camera, parent: scene, maxFar: 600, cascades: 4, mode: 'custom',
    customSplitsCallback: (_count, _near, _far, target) => target.push(...breaks), shadowMapSize: 4096 });
  try {
    csm.fade = true; csm.updateFrustums();
    const actual = computeCascadeExtents(camera, 600, breaks);
    for (let i = 0; i < 4; i++) {
      const depth = csm.frustums[i].vertices.far[0].z;
      const correction = .25 * depth * depth * (1 / (600 - camera.near) - 1 / (camera.far - camera.near));
      const expected = csm.lights[i].shadow.camera.right - csm.lights[i].shadow.camera.left + correction;
      assert.ok(Math.abs(actual[i] - expected) < 1e-9);
    }
    const unchanged = camera.projectionMatrix.toArray();
    camera._reversedDepth = true; camera.updateProjectionMatrix();
    const reversed = camera.projectionMatrix.toArray();
    assert.notDeepEqual(reversed, unchanged);
    assert.deepEqual(computeCascadeExtents(camera, 600, breaks), actual);
    assert.deepEqual(camera.projectionMatrix.toArray(), reversed, 'The view camera remains reversed and unchanged');
    const small = computeCascadeExtents(camera, 600, breaks, 43), large = computeCascadeExtents(camera, 600, breaks, 52);
    assert.ok(small.every((width, i) => width < large[i]));
  } finally { csm.remove(); csm.dispose(); }
});

test('stable reference increases resolution, preserves native texel density and fixes the light depth axis', () => {
  const f = fixture();
  assert.equal(f.reference.mapSize, 5122);
  assert.ok(f.reference.texelWidth <= 800 / 4096);
  assert.ok(f.reference.texelHeight <= 800 / 4096);
  assert.deepEqual(f.reference.apply(f.light, native, [-18, 600]), { applied: true });
  f.light.shadow.updateMatrices(f.light);
  const firstProjection = f.light.shadow.camera.projectionMatrix.toArray();
  const orientation = new THREE.Matrix4().lookAt(new THREE.Vector3(), direction, new THREE.Vector3(0, 1, 0));
  const right = new THREE.Vector3().setFromMatrixColumn(orientation, 0), up = new THREE.Vector3().setFromMatrixColumn(orientation, 1), back = new THREE.Vector3().setFromMatrixColumn(orientation, 2);
  const first = f.light.position.clone();
  assert.ok(Math.abs(first.dot(back) - 5000) < 1e-9);
  f.move(new THREE.Vector3(100, 200, 300).addScaledVector(right, f.reference.texelWidth * 7.2).addScaledVector(up, f.reference.texelHeight * -3.1));
  assert.equal(f.reference.apply(f.light, { ...native, width: 980, height: 980 }, [-18, 600]).applied, true);
  f.light.shadow.updateMatrices(f.light);
  assert.deepEqual(f.light.shadow.camera.projectionMatrix.toArray(), firstProjection);
  assert.ok(Math.abs(f.light.position.dot(back) - 5000) < 1e-9);
  for (const [axis, texel] of [[right, f.reference.texelWidth], [up, f.reference.texelHeight]]) {
    const shift = f.light.position.clone().sub(first).dot(axis) / texel;
    assert.ok(Math.abs(shift - Math.round(shift)) < 1e-8, 'A moving window shifts by whole texels');
  }
  assert.deepEqual([f.light.shadow.camera.near, f.light.shadow.camera.far], [1, 10000]);
});

test('the height-slab depth guarantee covers every map corner without relying on small map X/Z bounds', () => {
  const f = fixture(), heights = [-18, 331.64886474609375];
  assert.equal(f.reference.apply(f.light, native, heights).applied, true);
  f.light.shadow.updateMatrices(f.light);
  const camera = f.light.shadow.camera;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const back = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  const centerX = f.light.position.dot(right), centerY = f.light.position.dot(up);
  for (const xSign of [-1, 1]) for (const ySign of [-1, 1]) for (const height of heights) {
    const x = centerX + xSign * f.reference.width / 2, y = centerY + ySign * f.reference.height / 2;
    const z = (height - right.y * x - up.y * y) / back.y;
    const point = right.clone().multiplyScalar(x).addScaledVector(up, y).addScaledVector(back, z);
    assert.ok(Math.abs(point.y - height) < 1e-9);
    point.applyMatrix4(camera.matrixWorldInverse);
    assert.ok(-point.z >= camera.near && -point.z <= camera.far);
  }
});

test('coverage, density, resource and depth failures leave the native light completely untouched', () => {
  const cases = [
    [{}, { ...native, width: 1001 }, [-18, 600], 'native-coverage'],
    [{}, { ...native, width: 700 }, [-18, 600], 'native-density'],
    [{ maxTextureSize: 4096 }, native, [-18, 600], 'texture-limit'],
    [{ depthAxisOrigin: 50000 }, native, [-18, 600], 'depth-range'],
    [{}, native, [-18, 100000], 'depth-range'],
  ];
  for (const [changes, projection, heights, reason] of cases) {
    const f = fixture(changes), before = mutableState(f.light);
    assert.deepEqual(f.reference.apply(f.light, projection, heights), { applied: false, reason });
    assert.deepEqual(mutableState(f.light), before);
  }
});

test('changed sun/depth policy falls back and parent transforms preserve the fixed world basis', () => {
  const f = fixture();
  f.light.target.position.add(new THREE.Vector3(1, 0, 0));
  assert.equal(f.reference.apply(f.light, native, [-18, 600]).reason, 'sun-direction');
  f.move(new THREE.Vector3(100, 200, 300)); f.light.shadow.camera.far = 9000;
  assert.equal(f.reference.apply(f.light, native, [-18, 600]).reason, 'depth-range');
  f.light.shadow.camera.far = 10000;
  f.light.shadow.camera.zoom = 2;
  assert.equal(f.reference.apply(f.light, native, [-18, 600]).reason, 'projection-policy');
  f.light.shadow.camera.zoom = 1;
  const parent = new THREE.Group(); parent.position.set(30, -10, 15); parent.rotation.y = .3; f.scene.add(parent);
  parent.attach(f.light); parent.attach(f.light.target); f.scene.updateMatrixWorld(true);
  assert.equal(f.reference.apply(f.light, native, [-18, 600]).applied, true);
  const world = f.light.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(world.dot(direction.clone().negate()) - 5000) < 1e-9);
});

test('reserved distance envelope spans normal climbs and never weakens native shadow density', () => {
  const camera = new THREE.PerspectiveCamera(48, 1.6, .15, 16000), breaks = [.12, .32, .62, 1];
  for (const groundDistance of [300, 600]) {
    const envelope = computeStableShadowDistanceEnvelope(groundDistance, landscapeVisibility(groundDistance, 0).cameraFar, camera.near);
    assert.equal(envelope.lowerFar, groundDistance);
    assert.equal(envelope.upperFar, groundDistance === 300 ? 384 : 768);
    const smallest = computeCascadeExtents(camera, envelope.lowerFar, breaks, 43);
    const largest = computeCascadeExtents(camera, envelope.upperFar, breaks, 52);
    const references = [2, 3].map(index => new StableShadowProjection(options({ referenceWidth: largest[index], referenceHeight: largest[index],
      minimumNativeWidth: smallest[index], minimumNativeHeight: smallest[index] })));
    for (const altitude of [0, 80, 120, 180, 225]) {
      const far = landscapeVisibility(groundDistance, altitude).cameraFar;
      assert.deepEqual(computeStableShadowDistanceEnvelope(groundDistance, far, camera.near), envelope);
      for (const fov of [43, 48, 52]) {
        const extents = computeCascadeExtents(camera, far, breaks, fov);
        for (let i = 0; i < references.length; i++) {
          assert.ok(extents[i + 2] <= largest[i + 2] + 1e-9);
          assert.ok(references[i].texelWidth <= extents[i + 2] / 4096 + 1e-12);
          assert.ok(references[i].mapSize <= 8192);
        }
      }
    }
  }
  assert.deepEqual(computeStableShadowDistanceEnvelope(300, 400, .15), { lowerFar: 300, upperFar: 448 });
  assert.deepEqual(computeStableShadowDistanceEnvelope(300, 250, .15), { lowerFar: 250, upperFar: 384 });
});

test('atmosphere reuses reserved far maps through climbs while preserving native near cascades and visibility', () => {
  const camera = new THREE.PerspectiveCamera(48, 1.6, .15, 304), plainCamera = camera.clone();
  const renderer = { capabilities: { maxTextureSize: 8192 }, shadowMap: { autoUpdate: true } };
  const plain = new Atmosphere(new THREE.Scene(), renderer, plainCamera);
  const originalWindow = globalThis.window;
  let stable;
  try {
    globalThis.window = { location: { search: '?cacheShadows=1&middleShadowCache=0' } };
    stable = new Atmosphere(new THREE.Scene(), renderer, camera);
  } finally { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
  const prepare = (atmosphere, view, altitude, base = 300, far = landscapeVisibility(base, altitude).cameraFar) => {
    view.position.set(0, altitude, 0); view.lookAt(0, altitude - 20, -100); view.far = far; view.updateProjectionMatrix();
    atmosphere.setViewDistance(far, base, altitude); atmosphere.prepareRender();
  };
  try {
    let references, projection, sizes;
    for (const altitude of [0, 80, 120, 180, 225]) {
      prepare(plain, plainCamera, altitude); prepare(stable, camera, altitude);
      assert.deepEqual(camera.projectionMatrix, plainCamera.projectionMatrix);
      assert.equal(stable.sunlight.maxFar, plain.sunlight.maxFar);
      assert.equal(stable.scene.fog,null); assert.equal(plain.scene.fog,null);
      for (const index of [0, 1]) {
        assert.deepEqual(stable.sunlight.lights[index].shadow.camera.projectionMatrix, plain.sunlight.lights[index].shadow.camera.projectionMatrix);
        assert.deepEqual(stable.sunlight.lights[index].shadow.mapSize.toArray(), [4096, 4096]);
      }
      for (const index of [2, 3]) assert.equal(stable.canCacheShadowPass(index), true);
      const currentProjection = stable.sunlight.lights.slice(2).map(light => light.shadow.camera.projectionMatrix.toArray());
      const currentSizes = stable.sunlight.lights.slice(2).map(light => light.shadow.mapSize.toArray());
      if (!references) { references = stable.stableReferences; projection = currentProjection; sizes = currentSizes; }
      else { assert.equal(stable.stableReferences, references); assert.deepEqual(currentProjection, projection); assert.deepEqual(currentSizes, sizes); }
    }
    prepare(stable, camera, 225, 310, camera.far);
    assert.notEqual(stable.stableReferences, references, 'Changing ground distance is observed even when camera far stays unchanged');
    references = stable.stableReferences;
    prepare(stable, camera, 300);
    assert.notEqual(stable.stableReferences, references, 'Leaving the reserved distance envelope rebuilds its reference');
  } finally { stable.dispose(); plain.dispose(); }
});
