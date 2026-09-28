import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderDistanceController } from '../src/core/RenderDistanceController.ts';

function runner(options) {
  const controller = new RenderDistanceController(options); let now = 0;
  const step = (duration = 16, fields = {}) => {
    now += duration;
    return controller.update({ nowMs: now, frameDurationMs: duration, rendered: true, ready: true, pendingLoads: 0, ...fields });
  };
  const frames = (count, duration, fields) => { for (let i = 0; i < count; i++) step(duration, fields); };
  return { controller, step, frames, get now() { return now; } };
}

test('automatic visibility starts at 100m with a 100m floor and 30fps target', () => {
  const { controller } = runner({ initialDistance: 100 });
  assert.equal(controller.distance, 100); assert.equal(controller.targetDistance, 100);
  assert.equal(controller.minimumDistance, 100); assert.equal(controller.targetFps, 30);
});

test('invalid configuration is rejected and initial distance is bounded', () => {
  for (const options of [{ targetFps: 0 }, { minimumDistance: 400 }, { recoveryMs: -1 }, { initialDistance: NaN }])
    assert.throws(() => new RenderDistanceController(options));
  assert.equal(new RenderDistanceController({ initialDistance: 900 }).distance, 300);
});

test('loading, pending requests and non-rendered RAF frames cannot lower distance', () => {
  const r = runner();
  r.frames(50, 500, { ready: false });
  r.frames(50, 500, { pendingLoads: 1 });
  r.frames(50, 500, { initialLoad: true });
  r.frames(50, 500, { rendered: false });
  assert.equal(r.controller.distance, 300); assert.equal(r.controller.diagnostics.decisions, 0);
  assert.equal(r.controller.diagnostics.acceptedFrames, 0);
});

test('post-loading recovery excludes the first expensive ready frames', () => {
  const r = runner(); r.step(500, { ready: false }); r.frames(9, 100);
  assert.equal(r.controller.diagnostics.acceptedFrames, 0);
  r.step(100); assert.equal(r.controller.diagnostics.acceptedFrames, 1);
  assert.equal(r.controller.targetDistance, 300);
});

test('one isolated long rendered frame is retained but does not trigger a reduction', () => {
  const r = runner({ recoveryMs: 0 }); r.frames(90, 16); r.step(1500); r.frames(90, 16);
  assert.equal(r.controller.targetDistance, 300); assert.equal(r.controller.diagnostics.decisions, 0);
});

test('sustained slow actual frames lower the target and distance smoothly', () => {
  const r = runner({ recoveryMs: 0 }); let previous = r.controller.distance;
  for (let i = 0; i < 120; i++) {
    const distance = r.step(50);
    assert.ok(previous - distance <= 3 + 1e-9, 'at most 60m/s descent');
    assert.ok(distance <= previous); previous = distance;
  }
  assert.ok(r.controller.targetDistance < 300); assert.ok(r.controller.distance < 300);
  assert.ok(r.controller.distance >= 100);
});

test('severe overload reaches but never crosses the minimum without filtering slow frames', () => {
  const r = runner({ recoveryMs: 0 }); r.frames(180, 500);
  assert.equal(r.controller.targetDistance, 100); assert.equal(r.controller.distance, 100);
  assert.equal(r.controller.diagnostics.acceptedFrames, 180);
});

test('cooldown prevents repeated target cuts within 2.5 seconds', () => {
  const r = runner({ recoveryMs: 0 });
  for (let i = 0; i < 40 && r.controller.diagnostics.decisions === 0; i++) r.step(50);
  assert.equal(r.controller.diagnostics.decisions, 1);
  r.frames(40, 50); assert.equal(r.controller.diagnostics.decisions, 1);
});

test('stable headroom recovers distance slowly while respecting the automatic ceiling', () => {
  const r = runner({ recoveryMs: 0, initialDistance: 180 }); r.frames(240, 16);
  assert.equal(r.controller.targetDistance, 180);
  r.frames(30, 16); assert.ok(r.controller.targetDistance > 180);
  let previous = r.controller.distance;
  for (let i = 0; i < 6000; i++) {
    const distance = r.step(16); assert.ok(distance - previous <= .192 + 1e-9); previous = distance;
    assert.ok(distance <= 300);
  }
  assert.equal(r.controller.targetDistance, 300);
});

test('hysteresis holds distance near the frame budget instead of oscillating', () => {
  const r = runner({ recoveryMs: 0, initialDistance: 200 });
  for (let i = 0; i < 600; i++) r.step(i % 2 ? 31 : 35);
  assert.equal(r.controller.targetDistance, 200); assert.equal(r.controller.diagnostics.decisions, 0);
});

test('manual override freezes the exact requested distance until released', () => {
  const r = runner({ recoveryMs: 0 }); r.controller.setOverride(600); r.frames(100, 500);
  assert.equal(r.controller.distance, 600); assert.equal(r.controller.targetDistance, 600);
  assert.equal(r.controller.diagnostics.decisions, 0);
  r.controller.setOverride(null); assert.equal(r.controller.targetDistance, 300);
  assert.equal(r.step(16), 599.04);
  for (const distance of [99, 16001, NaN]) assert.throws(() => r.controller.setOverride(distance));
});

test('invalid timestamps and durations cannot contribute to a decision', () => {
  const r = runner({ recoveryMs: 0 }); r.step();
  for (const fields of [{ nowMs: -1 }, { nowMs: NaN }, { frameDurationMs: 0 }, { frameDurationMs: Infinity }, { pendingLoads: -1 }])
    r.step(16, fields);
  assert.equal(r.controller.diagnostics.decisions, 0); assert.equal(r.controller.distance, 300);
  assert.equal(r.controller.diagnostics.skippedFrames, 5);
});
