import test from 'node:test';
import assert from 'node:assert/strict';
import { ToroidalShadowDepthPlanner, StaleShadowWindowPlanError, positiveShadowModulo, worldLightDepthToShadowDepth, shadowDepthToWorldLightDepth } from '../src/experiments/ToroidalShadowDepthPlanner.ts';

const identity = (size = 7) => ({ sourceIdentity: 'exact-world-sha256', geometryRevision: 1, materialRevision: 1, casterPolicyRevision: 'opaque-static-all-casters-v1', projectionRevision: 'fov48-1440x900', sunBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1], texelScale: [.25, .5], mapSize: size });
const centerForOrigin = (x, y, key) => [(x + key.mapSize / 2) * key.texelScale[0], (y + key.mapSize / 2) * key.texelScale[1]];
const finish = (planner, plan) => {
  if (plan.updates.length) { planner.beginUpdates(plan); for (const update of plan.updates) planner.acknowledgeUpdate(plan, update.id); }
  return planner.commit(plan);
};
const points = rect => {
  const result = new Set();
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) result.add(`${x},${y}`);
  return result;
};

test('the 4096 shadow window retains exact texel density and updates only two exposed strips', () => {
  const planner = new ToroidalShadowDepthPlanner(), key = identity(4096);
  const first = planner.plan([0, 0], key);
  assert.deepEqual(first.window, { x: -2048, y: -2048, width: 4096, height: 4096 });
  assert.equal(first.requiredTexels, 4096 ** 2); finish(planner, first);
  const moved = planner.plan([3 * .25, -2 * .5], key);
  assert.equal(moved.reason, 'shift'); assert.equal(moved.exposedWorldRectangles.length, 2);
  assert.equal(moved.requiredTexels, 3 * 4096 + (4096 - 3) * 2);
  assert.equal(moved.reusedTexels, (4096 - 3) * (4096 - 2));
  assert.deepEqual(moved.identity.texelScale, [.25, .5]);
  assert.ok(moved.updates.length <= 8);
});

test('random positive/negative moves and teleports cover every newly required texel exactly once', () => {
  let randomState = 739391;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  for (const size of [3, 7, 12]) {
    const planner = new ToroidalShadowDepthPlanner(), key = identity(size), cache = new Float64Array(size * size).fill(NaN);
    let previous = null, x = -27, y = -18;
    for (let frame = 0; frame < 750; frame++) {
      const invalidated = frame % 47 === 0;
      if (invalidated) key.geometryRevision++;
      if (frame % 19 === 0) { x = Math.floor(random() * 401) - 200; y = Math.floor(random() * 401) - 200; }
      else { x += Math.floor(random() * 11) - 5; y += Math.floor(random() * 11) - 5; }
      const plan = planner.plan(centerForOrigin(x, y, key), key);
      assert.deepEqual(plan.window, { x, y, width: size, height: size });
      const expected = points(plan.window), prior = previous && !invalidated ? points(previous) : new Set();
      for (const point of prior) expected.delete(point);
      const covered = new Set();
      if (plan.updates.length) {
        planner.beginUpdates(plan); assert.equal(planner.committedWindow, null);
        assert.throws(() => planner.commit(plan), /incomplete/);
      }
      for (const update of [...plan.updates].reverse()) {
        const { world, destination } = update;
        assert.equal(world.width, destination.width); assert.equal(world.height, destination.height);
        assert.ok(destination.x >= 0 && destination.y >= 0 && destination.x + destination.width <= size && destination.y + destination.height <= size);
        for (let dy = 0; dy < world.height; dy++) for (let dx = 0; dx < world.width; dx++) {
          const wx = world.x + dx, wy = world.y + dy, point = `${wx},${wy}`, px = destination.x + dx, py = destination.y + dy;
          assert.equal(px, ((wx % size) + size) % size); assert.equal(py, ((wy % size) + size) % size);
          assert.ok(!covered.has(point), `Duplicate update at ${point}`); covered.add(point);
          cache[py * size + px] = key.geometryRevision * 1e7 + wx * 8192 + wy;
        }
        planner.acknowledgeUpdate(plan, update.id);
      }
      assert.deepEqual(covered, expected);
      assert.equal(plan.requiredTexels, expected.size); assert.equal(plan.reusedTexels, size * size - expected.size);
      assert.ok(plan.exposedWorldRectangles.length <= 2);
      planner.commit(plan);
      for (const point of points(plan.window)) {
        const [wx, wy] = point.split(',').map(Number), px = ((wx % size) + size) % size, py = ((wy % size) + size) % size;
        assert.equal(cache[py * size + px], key.geometryRevision * 1e7 + wx * 8192 + wy, `Stale cached world depth at ${point}`);
      }
      previous = plan.window;
    }
  }
});

test('cache keys invalidate every geometry/material/policy/sun/scale/projection dependency', () => {
  const changes = [
    key => { key.sourceIdentity = 'other-world'; }, key => { key.geometryRevision++; }, key => { key.materialRevision++; },
    key => { key.casterPolicyRevision = 'changed-static-caster-policy'; }, key => { key.projectionRevision = 'fov62-1920x1080'; },
    key => { key.sunBasis = [0, 1, 0, -1, 0, 0, 0, 0, 1]; }, key => { key.texelScale = [.5, .5]; }, key => { key.mapSize = 9; },
  ];
  for (const change of changes) {
    const planner = new ToroidalShadowDepthPlanner(), key = identity(); finish(planner, planner.plan([0, 0], key));
    change(key); assert.equal(planner.canReuse(key), false);
    const plan = planner.plan([0, 0], key); assert.equal(plan.reason, 'identity-change');
    assert.equal(plan.requiredTexels, key.mapSize ** 2); assert.equal(plan.reusedTexels, 0);
  }
});

test('stale plans and incomplete updates cannot commit or race later toroidal writes', () => {
  const planner = new ToroidalShadowDepthPlanner(), key = identity();
  const a = planner.plan([0, 0], key), b = planner.plan([1, 1], key);
  assert.throws(() => planner.beginUpdates(a), StaleShadowWindowPlanError);
  assert.throws(() => planner.commit(a), StaleShadowWindowPlanError);
  assert.throws(() => planner.acknowledgeUpdate(b, 0), /must begin/);
  planner.beginUpdates(b);
  assert.throws(() => planner.plan([2, 2], key), /in flight/);
  assert.throws(() => planner.commit(b), /incomplete/);
  planner.acknowledgeUpdate(b, b.updates[0].id);
  planner.invalidate(); assert.equal(planner.committedWindow, null);
  assert.throws(() => planner.commit(b), StaleShadowWindowPlanError);
  assert.throws(() => planner.acknowledgeUpdate(b, 0), StaleShadowWindowPlanError);
  assert.throws(() => planner.plan([2, 2], key), /in flight/);
  // The caller has now observed completion of the abandoned GPU work.
  planner.discardCompletedUpdate(b);
  const c = planner.plan([2, 2], key); assert.equal(c.reason, 'invalidated'); assert.equal(c.requiredTexels, key.mapSize ** 2);
  finish(planner, c); assert.ok(planner.canReuse(key));
  assert.throws(() => planner.commit(c), StaleShadowWindowPlanError);
});

test('changing light camera Z/near/far reuses stored world-axis depths and converts with the current camera', () => {
  const planner = new ToroidalShadowDepthPlanner(), key = identity(); finish(planner, planner.plan([2, -3], key));
  const storedWorldDepth = Math.fround(86.3125);
  const cameras = [{ axisOrigin: -20, near: .5, far: 200 }, { axisOrigin: 40, near: 2, far: 130 }, { axisOrigin: -110, near: 10, far: 500 }];
  const depths = cameras.map(camera => {
    const unchanged = planner.plan([2, -3], key); assert.equal(unchanged.requiredTexels, 0); assert.equal(unchanged.reason, 'unchanged'); planner.commit(unchanged);
    const depth = worldLightDepthToShadowDepth(storedWorldDepth, camera);
    assert.equal(depth, (storedWorldDepth - camera.axisOrigin - camera.near) / (camera.far - camera.near));
    assert.ok(Math.abs(shadowDepthToWorldLightDepth(depth, camera) - storedWorldDepth) < 1e-12);
    return depth;
  });
  assert.equal(new Set(depths).size, 3);
  // Preserve evidence of clipping differences; this helper does not hide them.
  assert.ok(worldLightDepthToShadowDepth(0, { axisOrigin: 20, near: 1, far: 50 }) < 0);
  assert.ok(worldLightDepthToShadowDepth(100, { axisOrigin: 0, near: 1, far: 50 }) > 1);
});

test('identity snapshots cannot mutate and invalid numeric grids are rejected', () => {
  const planner = new ToroidalShadowDepthPlanner(), key = identity(), plan = planner.plan([0, 0], key);
  key.texelScale[0] = 4; key.sunBasis[0] = 0; key.geometryRevision = 3;
  assert.deepEqual(plan.identity.texelScale, [.25, .5]); assert.equal(plan.identity.sunBasis[0], 1); assert.equal(plan.identity.geometryRevision, 1);
  assert.throws(() => { plan.window.x = 99; }, TypeError);
  assert.throws(() => planner.plan([0, 0], { ...identity(), texelScale: [0, 1] }), /Texel scale/);
  assert.throws(() => planner.plan([0, 0], { ...identity(), sunBasis: [1, 0, 0, 1, 0, 0, 0, 0, 1] }), /orthonormal/);
  assert.throws(() => planner.plan([Number.MAX_SAFE_INTEGER, 0], identity()), /safe integer/);
  assert.equal(positiveShadowModulo(-8, 7), 6); assert.equal(Object.is(positiveShadowModulo(-7, 7), -0), false);
});
