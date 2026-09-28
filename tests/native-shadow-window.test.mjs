import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/systems/Atmosphere.ts';
import { captureNativeShadowWindow, fixedSunBasis, shadowWorldSample, packNativeShadowParameters, worldDepthToRGBA8Bytes } from '../src/experiments/NativeShadowWindow.ts';
import { ToroidalShadowDepthPlanner, worldLightDepthToShadowDepth } from '../src/experiments/ToroidalShadowDepthPlanner.ts';

const revisions = { sourceIdentity: 'exact-static-source', geometryRevision: 1, materialRevision: 1, casterPolicyRevision: 'all-opaque-double-side-static', projectionRevision: '48deg-1440x900' };
const bounds = [-20000, -18, -20000, 20000, 331.649, 20000], basis = fixedSunBasis([.48, -.58, .65]);
function setup() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1.6, .15, 16000);
  const atmosphere = new Atmosphere(scene, { shadowMap: { autoUpdate: true } }, camera);
  return { scene, camera, atmosphere, lights: atmosphere.sunlight.lights };
}
function prepare(fixture, position, target) {
  fixture.camera.position.fromArray(position); fixture.camera.lookAt(new THREE.Vector3(...target)); fixture.atmosphere.prepareRender();
  for (const light of fixture.lights) light.shadow.updateMatrices(light);
}

test('all four native 4096 CSM sample grids agree with globally anchored bottom-left pixel centres across moving poses', () => {
  const f = setup(); let checked = 0;
  try {
    for (let pose = 0; pose < 12; pose++) {
      prepare(f, [-535 + pose * 112.5, 150 + pose * 13, -235 + pose * 89.1], [-330 + pose * 98, 15, 20 + pose * 75]);
      for (const light of f.lights) {
        const snapshot = captureNativeShadowWindow(light, basis, bounds, revisions), camera = light.shadow.camera;
        assert.equal(snapshot.identity.mapSize, 4096); assert.equal(snapshot.shadowTargetSamples, 0); assert.equal(snapshot.rasterSamples, 1);
        const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        for (const px of [0, 2047, 4095]) for (const py of [0, 2048, 4095]) for (const fraction of [.05, .5, .95]) {
          const axisDepth = snapshot.lightCamera.axisOrigin + camera.near + fraction * (camera.far - camera.near);
          const point = new THREE.Vector3(...shadowWorldSample(snapshot, snapshot.window.x + px, snapshot.window.y + py, axisDepth)).applyMatrix4(projection);
          const rasterX = (point.x + 1) * 2048, rasterY = (point.y + 1) * 2048;
          assert.ok(Math.abs(rasterX - (px + .5)) < 2e-7); assert.ok(Math.abs(rasterY - (py + .5)) < 2e-7);
          assert.ok(Math.abs((point.z + 1) * .5 - fraction) < 1e-11); checked++;
        }
      }
    }
    assert.equal(checked, 1296);
  } finally { f.atmosphere.dispose(); }
});

test('light-axis camera translation reuses the complete cached grid while current depth conversion changes', () => {
  const f = setup(), planners = f.lights.map(() => new ToroidalShadowDepthPlanner());
  try {
    const position = [-535, 150, -235], target = [-330, 15, 20]; prepare(f, position, target);
    const first = f.lights.map(light => captureNativeShadowWindow(light, basis, bounds, revisions));
    first.forEach((s, i) => { const p = planners[i].plan([(s.window.x + 2048) * s.identity.texelScale[0], (s.window.y + 2048) * s.identity.texelScale[1]], s.identity); planners[i].beginUpdates(p); p.updates.forEach(u => planners[i].acknowledgeUpdate(p, u.id)); planners[i].commit(p); });
    const delta = basis.slice(6).map(value => value * 12); prepare(f, position.map((v, i) => v + delta[i]), target.map((v, i) => v + delta[i]));
    for (let i = 0; i < 4; i++) {
      const s = captureNativeShadowWindow(f.lights[i], basis, bounds, revisions), p = planners[i].plan([(s.window.x + 2048) * s.identity.texelScale[0], (s.window.y + 2048) * s.identity.texelScale[1]], s.identity);
      assert.equal(p.requiredTexels, 0); assert.equal(p.reusedTexels, 4096 ** 2);
      assert.ok(Math.abs(s.lightCamera.axisOrigin - first[i].lightCamera.axisOrigin - 12) < 1e-9);
      const cachedWorldDepth = 0, difference = worldLightDepthToShadowDepth(cachedWorldDepth, s.lightCamera) - worldLightDepthToShadowDepth(cachedWorldDepth, first[i].lightCamera);
      assert.ok(Math.abs(difference + 12 / (s.lightCamera.far - s.lightCamera.near)) < 1e-12);
      assert.equal(s.nearPlaneCanClipGlobalCasters, true); // explicitly requires the guarded re-query path
    }
  } finally { f.atmosphere.dispose(); }
});

test('native cbuffer preserves exact signed world rectangles and float depth bit transport', () => {
  const f = setup();
  try {
    prepare(f, [-535, 150, -235], [-330, 15, 20]); const s = captureNativeShadowWindow(f.lights[0], basis, bounds, revisions);
    const planner = new ToroidalShadowDepthPlanner(), p = planner.plan([(s.window.x + 2048) * s.identity.texelScale[0], (s.window.y + 2048) * s.identity.texelScale[1]], s.identity);
    for (const update of p.updates) {
      const bytes = packNativeShadowParameters(s, update, 0), f32 = new Float32Array(bytes), i32 = new Int32Array(bytes), u32 = new Uint32Array(bytes);
      assert.equal(bytes.byteLength, 112); assert.deepEqual([...i32.slice(16, 20)], [update.world.x, update.world.y, update.world.width, update.world.height]);
      assert.deepEqual([...u32.slice(20, 24)], [update.destination.x, update.destination.y, 4096, 0]); assert.equal(f32[3], Math.fround(s.identity.texelScale[0]));
    }
    const values = new Float32Array([0, -0, -.125, .1234567, 10000.125, Infinity]);
    assert.deepEqual(worldDepthToRGBA8Bytes(values), new Uint8Array(values.buffer));
    assert.throws(() => packNativeShadowParameters(s, { world: { x: -1, y: 0, width: 2, height: 1 }, destination: { x: 4095, y: 0, width: 2, height: 1 } }, 0), /toroidal/);
    f.lights[0].shadow.mapSize.set(2048, 2048); assert.throws(() => captureNativeShadowWindow(f.lights[0], basis, bounds, revisions), /4096/);
  } finally { f.atmosphere.dispose(); }
});
