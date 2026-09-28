import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/systems/Atmosphere.ts';

function fixture(search, maxTextureSize = 8192) {
  const previous = globalThis.window;
  globalThis.window = { location: { search } };
  try {
    const camera = new THREE.PerspectiveCamera(48, 1.6, .15, 6000), scene = new THREE.Scene();
    const renderer = { capabilities: { maxTextureSize }, shadowMap: { autoUpdate: true } };
    return { scene, camera, atmosphere: new Atmosphere(scene, renderer, camera) };
  } finally {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
}
function prepare(f, x, y, z, yaw, fov = 48) {
  f.camera.position.set(x, y, z); f.camera.rotation.set(-.2, yaw, 0, 'YXZ');
  f.camera.fov = fov; f.camera.updateProjectionMatrix(); f.atmosphere.prepareRender();
  f.atmosphere.sunlight.lights.forEach(light => light.shadow.updateMatrices(light));
}
function state(light) {
  return { projection: light.shadow.camera.projectionMatrix.toArray(), matrix: light.shadow.matrix.toArray(),
    position: light.position.toArray(), target: light.target.position.toArray(), mapSize: light.shadow.mapSize.toArray(),
    bias: light.shadow.bias, normalBias: light.shadow.normalBias, near: light.shadow.camera.near, far: light.shadow.camera.far };
}

test('middle shadow cache is enabled by default, can be disabled, and keeps the closest cascade native', () => {
  const ordinary = fixture('?cacheShadows=1&middleShadowCache=0'), enabled = fixture('');
  try {
    assert.deepEqual(ordinary.atmosphere.cacheableShadowPassIndices, [2, 3]);
    assert.deepEqual(enabled.atmosphere.cacheableShadowPassIndices, [1, 2, 3]);
    prepare(ordinary, 100, 180, 50, .7); prepare(enabled, 100, 180, 50, .7);
    assert.equal(ordinary.atmosphere.canCacheShadowPass(1), false);
    assert.equal(enabled.atmosphere.canCacheShadowPass(0), false);
    assert.equal(enabled.atmosphere.canCacheShadowPass(1), true);
    assert.deepEqual(state(enabled.atmosphere.sunlight.lights[0]), state(ordinary.atmosphere.sunlight.lights[0]));
  } finally { ordinary.atmosphere.dispose(); enabled.atmosphere.dispose(); }
});

test('32 island flight poses retain middle-cascade coverage, native texel density, bias and depth', () => {
  const native = fixture('?cacheShadows=0'), cached = fixture('?cacheShadows=1&middleShadowCache=1');
  let checked = 0;
  try {
    for (const [x, z] of [[-600, -600], [-600, 2000], [2000, -600], [2000, 2000], [400, 400], [1500, 300], [0, 1500], [1600, 1600]]) {
      for (let view = 0; view < 4; view++) {
        const yaw = view * Math.PI / 2, y = 80 + view * 60, fov = [43, 48, 52, 48][view];
        prepare(native, x, y, z, yaw, fov); prepare(cached, x, y, z, yaw, fov);
        const original = native.atmosphere.sunlight.lights[1], stable = cached.atmosphere.sunlight.lights[1];
        assert.equal(cached.atmosphere.canCacheShadowPass(1), true, `cache eligibility at ${x},${y},${z},${yaw}`);
        assert.equal(cached.atmosphere.canCacheShadowPass(0), false);
        const nativeWidth = original.shadow.camera.right - original.shadow.camera.left;
        const stableWidth = stable.shadow.camera.right - stable.shadow.camera.left;
        assert.ok(stableWidth >= nativeWidth);
        assert.ok(stableWidth / stable.shadow.mapSize.x <= nativeWidth / 4096 + 1e-12);
        assert.ok(stable.shadow.mapSize.x <= 8192);
        assert.equal(stable.shadow.bias, original.shadow.bias); assert.equal(stable.shadow.normalBias, original.shadow.normalBias);
        assert.equal(stable.shadow.camera.near, original.shadow.camera.near); assert.equal(stable.shadow.camera.far, original.shadow.camera.far);
        assert.deepEqual(state(cached.atmosphere.sunlight.lights[0]), state(native.atmosphere.sunlight.lights[0]));
        // Corners with nonzero CSM transition weight just beyond 450 m remain in this map.
        const depth = 450 + .25 * (450 / 6000) ** 2 * 6000 * .4;
        for (const horizontal of [-1, 1]) for (const vertical of [-1, 1]) {
          const point = new THREE.Vector3(horizontal * depth * Math.tan(fov * Math.PI / 360) * 1.6,
            vertical * depth * Math.tan(fov * Math.PI / 360), -depth)
            .applyMatrix4(cached.camera.matrixWorld).applyMatrix4(stable.shadow.matrix);
          assert.ok(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
        }
        checked++;
      }
    }
    assert.equal(checked, 32);
  } finally { native.atmosphere.dispose(); cached.atmosphere.dispose(); }
});

test('middle cache returns to exact native projection when texture or coverage limits reject it', () => {
  for (const [limit, fov] of [[4096, 48], [8192, 80]]) {
    const native = fixture('?cacheShadows=0', limit), cached = fixture('?cacheShadows=1&middleShadowCache=1', limit);
    try {
      prepare(native, 100, 150, 200, 1.1, fov); prepare(cached, 100, 150, 200, 1.1, fov);
      assert.equal(cached.atmosphere.canCacheShadowPass(1), false);
      assert.deepEqual(state(cached.atmosphere.sunlight.lights[1]), state(native.atmosphere.sunlight.lights[1]));
      assert.deepEqual(cached.atmosphere.sunlight.lights[1].shadow.mapSize.toArray(), [4096, 4096]);
    } finally { native.atmosphere.dispose(); cached.atmosphere.dispose(); }
  }
});

test('middle projection resets before every apply and can fall back after a previously cached view', () => {
  const native = fixture('?cacheShadows=0'), cached = fixture('?cacheShadows=1&middleShadowCache=1');
  try {
    prepare(cached, 100, 150, 200, 1.1, 48);
    const firstProjection = cached.atmosphere.sunlight.lights[1].shadow.camera.projectionMatrix.toArray();
    assert.equal(cached.atmosphere.canCacheShadowPass(1), true);
    prepare(cached, 102, 151, 202, 1.11, 48);
    assert.deepEqual(cached.atmosphere.sunlight.lights[1].shadow.camera.projectionMatrix.toArray(), firstProjection);
    prepare(native, 102, 151, 202, 1.11, 80); prepare(cached, 102, 151, 202, 1.11, 80);
    assert.equal(cached.atmosphere.canCacheShadowPass(1), false);
    assert.deepEqual(state(cached.atmosphere.sunlight.lights[1]), state(native.atmosphere.sunlight.lights[1]));
  } finally { native.atmosphere.dispose(); cached.atmosphere.dispose(); }
});
