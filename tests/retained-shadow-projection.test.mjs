import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StableShadowProjection } from '../src/experiments/StableShadowProjection.ts';
import { Atmosphere } from '../src/systems/Atmosphere.ts';

const direction = new THREE.Vector3(.48, -.58, .65).normalize();
const orientation = new THREE.Matrix4().lookAt(new THREE.Vector3(), direction, new THREE.Vector3(0, 1, 0));
const axisX = new THREE.Vector3().setFromMatrixColumn(orientation, 0);
const axisY = new THREE.Vector3().setFromMatrixColumn(orientation, 1);
const axisZ = new THREE.Vector3().setFromMatrixColumn(orientation, 2);
const native = { width: 900, height: 900, mapSize: 4096 };
const heights = [-18, 600];
function fixture(retainCoveredProjection = true) {
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight();
  light.shadow.camera.near = 1; light.shadow.camera.far = 10000;
  scene.add(light, light.target);
  const reference = new StableShadowProjection({ lightDirection: direction,
    referenceWidth: 1000, referenceHeight: 1000, minimumNativeWidth: 800, minimumNativeHeight: 800,
    nativeMapSize: 4096, maxTextureSize: 8192, depthAxisOrigin: 5000, near: 1, far: 10000,
    ...(retainCoveredProjection ? { retainCoveredProjection: true } : {}) });
  const move = (x, y) => {
    light.position.copy(axisX).multiplyScalar(x).addScaledVector(axisY, y).addScaledVector(axisZ, 200);
    light.target.position.copy(light.position).add(direction); scene.updateMatrixWorld(true);
  };
  move(100, 200);
  return { scene, light, reference, move };
}
function state(light) {
  return { position: light.position.toArray(), target: light.target.position.toArray(),
    projection: light.shadow.camera.projectionMatrix.toArray(), matrix: light.shadow.matrix.toArray(),
    mapSize: light.shadow.mapSize.toArray(), bias: light.shadow.bias, normalBias: light.shadow.normalBias,
    near: light.shadow.camera.near, far: light.shadow.camera.far };
}
function apply(f, projection = native, casterHeights = heights) {
  const result = f.reference.apply(f.light, projection, casterHeights);
  if (result.applied) f.light.shadow.updateMatrices(f.light);
  return result;
}
function checkCoverage(f, x, y, projection, guard = 0) {
  const centerX = f.light.position.dot(axisX), centerY = f.light.position.dot(axisY);
  for (const sign of [-1, 1]) {
    assert.ok(Math.abs(x + sign * projection.width / 2 - centerX) <= f.reference.width / 2 - guard * f.reference.texelWidth + 1e-9);
    assert.ok(Math.abs(y + sign * projection.height / 2 - centerY) <= f.reference.height / 2 - guard * f.reference.texelHeight + 1e-9);
  }
}

test('retained coverage keeps the exact projection through movement and changing native extents', () => {
  const f = fixture(); assert.equal(apply(f).applied, true);
  const original = state(f.light);
  for (let i = 0; i < 32; i++) {
    const x = 100 + Math.sin(i) * 6, y = 200 + Math.cos(i) * 7;
    const projection = { ...native, width: 900 + i % 5 * 20, height: 910 + i % 4 * 20 };
    f.move(x, y); assert.equal(apply(f, projection).applied, true);
    assert.deepEqual(state(f.light), original, 'No scroll, projection, density or depth change while all native corners fit');
    checkCoverage(f, x, y, projection, 2);
  }
});

test('two-texel guard and expanded FOV force grid-aligned recentering before coverage can escape', () => {
  const f = fixture(); assert.equal(apply(f).applied, true);
  const first = f.light.position.clone(), x = first.dot(axisX), y = first.dot(axisY);
  const margin = (f.reference.width - native.width) / 2;
  f.move(x + margin - 2.1 * f.reference.texelWidth, y);
  assert.equal(apply(f).applied, true); assert.deepEqual(f.light.position.toArray(), first.toArray());
  f.move(x + margin - f.reference.texelWidth, y);
  assert.equal(apply(f).applied, true); assert.notDeepEqual(f.light.position.toArray(), first.toArray());
  const shift = f.light.position.clone().sub(first).dot(axisX) / f.reference.texelWidth;
  assert.ok(Math.abs(shift - Math.round(shift)) < 1e-8);
  const second = f.light.position.clone(), nextX = second.dot(axisX) + 5;
  f.move(nextX, y); assert.equal(apply(f, { ...native, width: 1000 }).applied, true);
  assert.notDeepEqual(f.light.position.toArray(), second.toArray(), 'Expanded native coverage cannot use an insufficient old anchor');
  checkCoverage(f, nextX, y, { ...native, width: 1000 });
});

test('large movements recenter while default helper behavior still follows every native grid movement', () => {
  for (const enabled of [true, false]) {
    const f = fixture(enabled); assert.equal(apply(f).applied, true);
    const first = f.light.position.clone();
    const x = first.dot(axisX) + (enabled ? 500 : 3), y = first.dot(axisY) - (enabled ? 300 : 2);
    f.move(x, y); assert.equal(apply(f).applied, true);
    assert.notDeepEqual(f.light.position.toArray(), first.toArray()); checkCoverage(f, x, y, native);
    for (const [axis, texel] of [[axisX, f.reference.texelWidth], [axisY, f.reference.texelHeight]]) {
      const shift = f.light.position.clone().sub(first).dot(axis) / texel;
      assert.ok(Math.abs(shift - Math.round(shift)) < 1e-8);
    }
  }
});

test('crossing one native edge scrolls only that axis while the perpendicular coverage stays anchored', () => {
  const f = fixture(); assert.equal(apply(f).applied, true);
  let previous = f.light.position.clone();
  const poses = [
    [160, 212, native, axisX, axisY],
    [163, 260, native, axisY, axisX],
    [166, 265, { ...native, width: 1000 }, axisX, axisY],
  ];
  for (const [x, y, projection, movedAxis, retainedAxis] of poses) {
    f.move(x, y); assert.equal(apply(f, projection).applied, true);
    const delta = f.light.position.clone().sub(previous);
    assert.ok(Math.abs(delta.dot(movedAxis)) > 1, 'The escaped axis refreshes its native coverage');
    assert.ok(Math.abs(delta.dot(retainedAxis)) < 1e-10, 'The still-covered axis does not create a second strip');
    assert.ok(Math.abs(delta.dot(axisZ)) < 1e-10, 'The fixed depth origin is unchanged');
    checkCoverage(f, x, y, projection);
    previous = f.light.position.clone();
  }
});

test('every retained apply rechecks caster depth and failed applies never commit a different anchor', () => {
  const f = fixture(); assert.equal(apply(f).applied, true); const original = state(f.light);
  f.move(104, 203); let before = state(f.light);
  assert.deepEqual(apply(f, native, [-18, 100000]), { applied: false, reason: 'depth-range' });
  assert.deepEqual(state(f.light), before, 'A retained center still validates changed caster heights');
  f.move(900, 700); before = state(f.light);
  assert.deepEqual(apply(f, native, [-18, 100000]), { applied: false, reason: 'depth-range' });
  assert.deepEqual(state(f.light), before);
  f.move(104, 203); assert.equal(apply(f).applied, true); assert.deepEqual(state(f.light), original);
  const camera = f.light.shadow.camera, centerX = f.light.position.dot(axisX), centerY = f.light.position.dot(axisY);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const height of heights) {
    const x = centerX + sx * f.reference.width / 2, y = centerY + sy * f.reference.height / 2;
    const z = (height - axisX.y * x - axisY.y * y) / axisZ.y;
    const point = axisX.clone().multiplyScalar(x).addScaledVector(axisY, y).addScaledVector(axisZ, z).applyMatrix4(camera.matrixWorldInverse);
    assert.ok(-point.z >= camera.near && -point.z <= camera.far);
  }
});

test('retention never bypasses sun direction or native coverage fallback', () => {
  const f = fixture(); assert.equal(apply(f).applied, true); const original = state(f.light);
  f.move(102, 202); f.light.target.position.x += 1; f.scene.updateMatrixWorld(true);
  let before = state(f.light);
  assert.deepEqual(apply(f), { applied: false, reason: 'sun-direction' }); assert.deepEqual(state(f.light), before);
  f.move(102, 202); before = state(f.light);
  assert.deepEqual(apply(f, { ...native, width: 1001 }), { applied: false, reason: 'native-coverage' });
  assert.deepEqual(state(f.light), before);
  f.move(102, 202); assert.equal(apply(f).applied, true); assert.deepEqual(state(f.light), original);
});

test('Atmosphere retains covered cascade maps while current native rectangles and nearest shadows remain intact', () => {
  const oldWindow = globalThis.window, fixtures = [];
  try {
    for (const search of ['?cacheShadows=0', '?cacheShadows=1&middleShadowCache=1&wideShadowDepth=1']) {
      globalThis.window = { location: { search } };
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1920 / 900, .15, 6000);
      fixtures.push({ camera, atmosphere: new Atmosphere(scene, { capabilities: { maxTextureSize: 8192 }, shadowMap: { autoUpdate: true } }, camera) });
    }
  } finally { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; }
  let retained = 0, previous;
  try {
    for (let frame = 0; frame < 24; frame++) {
      for (const { camera, atmosphere } of fixtures) {
        camera.position.set(1400 + frame * .1, 150, 200 + frame * .07); camera.rotation.set(-.2, .7, 0, 'YXZ');
        camera.fov = 48 + Math.sin(frame / 5) * .1; camera.updateProjectionMatrix(); atmosphere.prepareRender();
        atmosphere.sunlight.lights.forEach(light => light.shadow.updateMatrices(light));
      }
      const [ordinary, cached] = fixtures.map(f => f.atmosphere);
      assert.deepEqual(state(cached.sunlight.lights[0]), state(ordinary.sunlight.lights[0]));
      const current = [];
      for (const index of [1, 2, 3]) {
        assert.equal(cached.canCacheShadowPass(index), true);
        const source = ordinary.sunlight.lights[index], stable = cached.sunlight.lights[index];
        const width = source.shadow.camera.right - source.shadow.camera.left, height = source.shadow.camera.top - source.shadow.camera.bottom;
        const right = new THREE.Vector3().setFromMatrixColumn(source.shadow.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(source.shadow.camera.matrixWorld, 1);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const point = source.getWorldPosition(new THREE.Vector3()).addScaledVector(right, sx * width / 2)
            .addScaledVector(up, sy * height / 2).applyMatrix4(stable.shadow.matrix);
          assert.ok(point.x >= -1e-9 && point.x <= 1 + 1e-9 && point.y >= -1e-9 && point.y <= 1 + 1e-9);
        }
        current.push(stable.shadow.matrix.toArray());
      }
      if (previous && JSON.stringify(current) === JSON.stringify(previous)) retained++;
      previous = current;
    }
    assert.equal(retained, 23, 'Covered movement reuses every static shadow matrix');
  } finally { for (const { atmosphere } of fixtures) atmosphere.dispose(); }
});
