import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/systems/Atmosphere.ts';
import { landscapeVisibility } from '../src/systems/LandscapeVisibility.ts';

function fixture(wide = true, maxTextureSize = 16384, aspect = 1.6) {
  const saved = globalThis.window;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, aspect, .15, 6000);
  const renderer = { capabilities: { maxTextureSize, reversedDepthBuffer: false }, shadowMap: { autoUpdate: true } };
  let atmosphere;
  try {
    globalThis.window = { location: { search: `?cacheShadows=1${wide ? '' : '&wideShadowDepth=0'}` } };
    atmosphere = new Atmosphere(scene, renderer, camera);
  } finally { if (saved === undefined) delete globalThis.window; else globalThis.window = saved; }
  return { scene, camera, atmosphere };
}

function prepare(f, position, yaw = 0, pitch = 0, fov = 48) {
  const { camera, atmosphere } = f;
  camera.position.set(...position); camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.fov = fov; camera.far = landscapeVisibility(6000, Math.max(0, position[1])).cameraFar; camera.updateProjectionMatrix();
  atmosphere.setViewDistance(camera.far, 6000, Math.max(0, position[1]));
  atmosphere.prepareRender();
}

test('wide far shadow depth stays cacheable across all regions, flight headings and ordinary climbs', () => {
  const f = fixture();
  const positions = [[0, 0], [1600, 0], [0, 1600], [1600, 1600], [-800, -800], [2400, 2400]];
  try {
    let checked = 0;
    for (const [x, z] of positions) for (const altitude of [30, 150, 600])
      for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) for (const pitch of [-.6, 0, .6]) for (const fov of [43, 52]) {
        prepare(f, [x, altitude, z], yaw, pitch, fov);
        for (const index of [2, 3]) {
          assert.equal(f.atmosphere.canCacheShadowPass(index), true, JSON.stringify({ index, x, z, altitude, yaw, pitch, fov }));
          const shadow = f.atmosphere.sunlight.lights[index].shadow;
          assert.equal(shadow.camera.far, 65536);
          assert.ok(Math.abs(shadow.bias * (shadow.camera.far - shadow.camera.near) - ([-.00004, -.00012][index - 2] * 9999)) < 1e-12);
          assert.equal(shadow.normalBias, [.15, .45][index - 2]);
          assert.ok((shadow.camera.right - shadow.camera.left) / shadow.mapSize.x <= f.atmosphere.nativeShadowExtents[index] / 4096 + 1e-12);
          const centerDepth = f.atmosphere.sunlight.lights[index].position.dot(f.atmosphere.sunlight.lightDirection.clone().negate());
          assert.ok(Math.abs(centerDepth - 32768) < 1e-8);
        }
        checked++;
      }
    assert.equal(checked, 432);
  } finally { f.atmosphere.dispose(); }
});

test('wide depth leaves near cascades and native fallback bias and depth unchanged', () => {
  const f = fixture(), plain = fixture(false), limited = fixture(true, 4096);
  try {
    for (const current of [f, plain, limited]) prepare(current, [1600, 150, 0], 1, -.1);
    assert.equal(f.atmosphere.canCacheShadowPass(3), true);
    assert.equal(plain.atmosphere.canCacheShadowPass(3), false, 'The old fixed +/-5 km depth reference cannot hold this complete-map rectangle');
    for (const index of [0, 1]) {
      const actual = f.atmosphere.sunlight.lights[index].shadow, expected = plain.atmosphere.sunlight.lights[index].shadow;
      assert.deepEqual(actual.camera.projectionMatrix.toArray(), expected.camera.projectionMatrix.toArray());
      assert.equal(actual.bias, expected.bias); assert.equal(actual.normalBias, expected.normalBias);
    }
    for (const index of [2, 3]) {
      const fallback = limited.atmosphere.sunlight.lights[index].shadow;
      assert.equal(limited.atmosphere.canCacheShadowPass(index), false);
      assert.equal(fallback.camera.near, 1); assert.equal(fallback.camera.far, 10000);
      assert.equal(fallback.bias, [-.00004, -.00012][index - 2]); assert.equal(fallback.normalBias, [.15, .45][index - 2]);
      assert.deepEqual(fallback.mapSize.toArray(), [4096, 4096]);
    }
  } finally { f.atmosphere.dispose(); plain.atmosphere.dispose(); limited.atmosphere.dispose(); }
});

test('both native far depth targets upgrade once to Float32 while preserving PCF sampling and dimensions', () => {
  const f = fixture();
  try {
    prepare(f, [1600, 150, 0]);
    for (const index of [2, 3]) {
    const shadow = f.atmosphere.sunlight.lights[index].shadow;
    const map = new THREE.WebGLRenderTarget(shadow.mapSize.x, shadow.mapSize.y);
    map.depthTexture = new THREE.DepthTexture(map.width, map.height, THREE.UnsignedIntType);
    map.depthTexture.compareFunction = THREE.LessEqualCompare;
    map.depthTexture.minFilter = THREE.LinearFilter; map.depthTexture.magFilter = THREE.LinearFilter;
    shadow.map = map;
    let disposals = 0; map.addEventListener('dispose', () => disposals++);
    prepare(f, [1600, 150, 0]);
    assert.equal(shadow.map, map); assert.equal(map.depthTexture.type, THREE.FloatType);
    assert.equal(map.depthTexture.compareFunction, THREE.LessEqualCompare);
    assert.equal(map.depthTexture.minFilter, THREE.LinearFilter); assert.equal(map.depthTexture.magFilter, THREE.LinearFilter);
    assert.deepEqual([map.width, map.height], shadow.mapSize.toArray());
    assert.equal(disposals, 1);
    prepare(f, [1600, 150, 0]);
    assert.equal(disposals, 1, 'Stable frames must not reallocate the target');
    }
  } finally { f.atmosphere.dispose(); }
});

test('1920 by 900 Azure Port views keep both far cascades cacheable without reducing density', () => {
  const wide = fixture(true, 8192, 1920 / 900), oldDepth = fixture(false, 8192, 1920 / 900);
  let checked = 0, oldMiddleRejected = 0;
  try {
    for (const [x, z] of [[1600, 0], [1719, -61], [1860, 60], [1440, 220]])
      for (const altitude of [70, 150, 360]) for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5])
        for (const fov of [43, 48, 52]) {
          prepare(wide, [x, altitude, z], yaw, -.15, fov);
          prepare(oldDepth, [x, altitude, z], yaw, -.15, fov);
          if (!oldDepth.atmosphere.canCacheShadowPass(2)) oldMiddleRejected++;
          for (const index of [2, 3]) {
            assert.equal(wide.atmosphere.canCacheShadowPass(index), true, JSON.stringify({ index, x, z, altitude, yaw, fov }));
            const shadow = wide.atmosphere.sunlight.lights[index].shadow;
            assert.ok((shadow.camera.right - shadow.camera.left) / shadow.mapSize.x <= wide.atmosphere.nativeShadowExtents[index] / 4096 + 1e-12);
            assert.equal(shadow.camera.near, 1); assert.equal(shadow.camera.far, 65536);
            assert.ok(Math.abs(shadow.bias * 65535 - [-.00004, -.00012][index - 2] * 9999) < 1e-12);
            assert.ok(shadow.mapSize.x <= 8192);
          }
          checked++;
        }
    assert.equal(checked, 144); assert.ok(oldMiddleRejected > 0, 'Reproduces the former cascade-2 depth rejection on wide desktop views');
  } finally { wide.atmosphere.dispose(); oldDepth.atmosphere.dispose(); }
});
