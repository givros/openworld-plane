import assert from 'node:assert/strict';
import test from 'node:test';
import { ManualFlightController } from '../src/systems/ManualFlightController.ts';
import { PilotInput } from '../src/systems/PilotInput.ts';
import { FlightSequence } from '../src/systems/FlightSequence.ts';
const DEG = Math.PI / 180;
const neutral = { throttle: 0, pitch: 0, roll: 0, rudder: 0, brake: false };
const limit = (n, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, n));
const step = (controller, seconds, controls = neutral) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) controller.update(1 / 120, controls);
};
function controller() { const c = new ManualFlightController(() => 0); c.start(); return c; }
function airborne(c, options = {}) {
  c.state.position.set(0, 100, 0);
  Object.assign(c.state, { grounded: false, phase: 'flight', speed: 40, throttle: 0.3, pitch: 3 * DEG, flightPathAngle: 0, ...options });
  return c;
}
function takeoff(c) {
  for (let i = 0; i < 120 * 20 && c.state.grounded && !c.state.crashed; i++) {
    c.update(1 / 120, { ...neutral, throttle: 1, pitch: 1 });
  }
  assert.equal(c.state.crashed, false, 'takeoff must not cause a propeller strike');
  assert.equal(c.state.grounded, false, 'sustained power and pull must take off');
  assert.ok(c.state.speed >= 29);
  assert.ok(c.state.throttle >= 0.5);
}
function flyByInstruments(c, seconds, sinkRate, speedTarget = 36) {
  for (let i = 0; i < seconds * 120 && !c.state.grounded && !c.state.crashed; i++) {
    const s = c.state;
    const desiredSink = sinkRate < 0 && s.altitude < 2.6 ? -0.8 : sinkRate;
    const path = Math.asin(limit(desiredSink / Math.max(20, s.speed), -0.2, 0.2));
    const liftPitch = (9.81 / (s.speed * s.speed * 0.018) - 0.18) / 4.4;
    const targetPitch = limit(path + liftPitch, -4 * DEG, 13 * DEG);
    const authority = 0.18 + 0.82 * (() => { const t = limit((s.speed - 16) / 27, 0, 1); return t * t * (3 - 2 * t); })();
    const desiredPitchRate = (targetPitch - s.pitch) * 3.6 - s.pitchRate * 0.7;
    const pitch = limit((desiredPitchRate - (2.4 * DEG - s.pitch) * 0.34) / (34 * DEG * authority));
    const drag = s.speed * s.speed * 0.018 * (0.032 + 0.052 * (0.18 + 4.4 * liftPitch) ** 2);
    const maintainPower = (drag + 9.81 * Math.sin(path)) / (10.8 * (1 - 0.48 * s.speed / 78));
    const throttleTarget = limit(maintainPower + (speedTarget - s.speed) * 0.035, 0, 1);
    const throttle = Math.abs(throttleTarget - s.throttle) > 0.004 ? Math.sign(throttleTarget - s.throttle) : 0;
    c.update(1 / 120, { ...neutral, pitch, throttle });
  }
}

test('ground steering, airborne banks, rudder, and elevator match the pilot view', () => {
  for (const direction of [-1, 1]) {
    const ground = controller();
    Object.assign(ground.state, { speed: 15, throttle: 0.3 });
    step(ground, 0.5, { ...neutral, roll: direction });
    assert.ok(ground.state.yaw * direction < 0, `ground steering ${direction}`);
    const air = airborne(controller());
    step(air, 0.5, { ...neutral, roll: direction });
    assert.ok(air.state.bank * direction > 0, `visual bank ${direction}`);
    const rudder = airborne(controller());
    step(rudder, 0.5, { ...neutral, rudder: direction });
    assert.ok(rudder.state.yaw * direction < 0, `rudder ${direction}`);
    const elevator = airborne(controller());
    const originalPitch = elevator.state.pitch;
    step(elevator, 0.5, { ...neutral, pitch: direction });
    assert.ok((elevator.state.pitch - originalPitch) * direction > 0, `elevator ${direction}`);
  }
});

test('parked wheels and the full propeller safety disc have exact clearance', () => {
  const c = controller();
  assert.deepEqual(c.state.position.toArray(), [0, 0, -112]);
  assert.ok(Math.abs(c.propellerClearance() - 0.56) < 1e-12);
  step(c, 2);
  assert.equal(c.state.position.y, 0);
  assert.equal(c.state.phase, 'manual-ready');
});

test('power below 50% cannot launch, even above takeoff speed', () => {
  const c = controller();
  Object.assign(c.state, { speed: 34, throttle: 0.49, pitch: 8 * DEG });
  step(c, 0.5, { ...neutral, pitch: 1 });
  assert.equal(c.state.grounded, true);
  assert.equal(c.state.takeoffs, 0);
});

test('takeoff, controlled flight, landing, full stop, and a second takeoff need no reset', () => {
  const c = controller();
  takeoff(c);
  flyByInstruments(c, 12, 2.2);
  assert.ok(c.state.altitude > 15, `climb altitude: ${c.state.altitude}`);
  flyByInstruments(c, 70, -1.8, 33);
  assert.equal(c.state.crashed, false, 'controlled approach is safe');
  assert.equal(c.state.grounded, true, `approach altitude: ${c.state.altitude}`);
  assert.equal(c.state.landings, 1);
  step(c, 10, { ...neutral, throttle: -1, brake: true });
  assert.equal(c.state.speed, 0);
  assert.equal(c.state.phase, 'manual-ready');
  const elapsedAtStop = c.state.elapsed;
  takeoff(c);
  assert.ok(c.state.elapsed > elapsedAtStop);
  assert.equal(c.state.takeoffs, 2);
  assert.equal(c.state.landings, 1);
});

test('the anti-bounce guard blocks launch for 0.20 seconds then permits touch-and-go', () => {
  const c = airborne(controller(), { speed: 36, throttle: 0.82, pitch: 8 * DEG, flightPathAngle: -2.5 * DEG });
  c.state.position.set(0, 0.69, -80);
  for (let i = 0; i < 240 && !c.state.grounded; i++) c.update(1 / 120, neutral);
  assert.equal(c.state.crashed, false);
  assert.equal(c.state.grounded, true);
  assert.equal(c.state.landings, 1);
  assert.ok(c.contactGuard > 0.19);
  step(c, 0.175, { ...neutral, pitch: 1 });
  assert.equal(c.state.grounded, true, 'wheel contact must persist throughout the guard');
  for (let i = 0; i < 120 && c.state.grounded; i++) c.update(1 / 120, { ...neutral, pitch: 1 });
  assert.equal(c.state.crashed, false);
  assert.equal(c.state.grounded, false, 'holding power and pull relaunches after the guard');
  assert.equal(c.state.takeoffs, 1);
  assert.ok(c.liftoffGuard > 0);
});

test('a hard impact is terminal and reset restores the parked aircraft', () => {
  const c = airborne(controller(), { speed: 39, pitch: 0, flightPathAngle: -14 * DEG });
  c.state.position.y = 0.08;
  step(c, 0.1);
  assert.equal(c.state.crashed, true);
  assert.equal(c.state.phase, 'crashed');
  const position = c.state.position.clone();
  step(c, 8, { ...neutral, throttle: 1, pitch: 1 });
  assert.equal(c.state.phase, 'crashed');
  assert.equal(c.state.speed, 0);
  assert.deepEqual(c.state.position, position);
  c.reset();
  assert.equal(c.state.crashed, false);
  assert.deepEqual(c.state.position.toArray(), [0, 0, -112]);
});

test('genuine propeller strikes use terrain beneath the disc, not beneath the root', () => {
  const c = new ManualFlightController((x, z) => Math.abs(x) < 2 && z > -108 ? 1.3 : 0);
  c.start();
  assert.ok(c.propellerClearance() < 0);
  c.update(1 / 120, neutral);
  assert.equal(c.state.crashed, true);
});

test('flat off-runway landings work while steep terrain and misaligned runway impacts fail', () => {
  const offRunway = airborne(controller(), { speed: 31, pitch: 2 * DEG, flightPathAngle: -3 * DEG, yaw: Math.PI / 2 });
  offRunway.state.position.set(60, 0.18, -80);
  step(offRunway, 0.25);
  assert.equal(offRunway.state.crashed, false);
  assert.equal(offRunway.state.landings, 1);
  const misaligned = airborne(controller(), { speed: 31, pitch: 2 * DEG, flightPathAngle: -3 * DEG, yaw: Math.PI / 2 });
  misaligned.state.position.set(0, 0.18, -80);
  step(misaligned, 0.25);
  assert.equal(misaligned.state.crashed, true);
  const slope = new ManualFlightController((x) => x * 0.3);
  slope.start();
  airborne(slope, { speed: 31, pitch: 2 * DEG, flightPathAngle: -3 * DEG });
  slope.state.position.set(60, 18.55, 400);
  step(slope, 0.25);
  assert.equal(slope.state.crashed, true);
});

test('fixed timesteps are deterministic across render rates and clamp long frames', () => {
  const one = controller(), two = controller();
  const input = { ...neutral, throttle: 1, pitch: 1 };
  for (let i = 0; i < 360; i++) one.update(1 / 60, input);
  for (let i = 0; i < 180; i++) two.update(1 / 30, input);
  assert.deepEqual(one.state, two.state);
  const elapsed = one.state.elapsed;
  one.update(6, input);
  assert.ok(one.state.elapsed - elapsed <= 0.121);
});

test('held input clears on blur, hidden document, disabling, and disposal', () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const fakeWindow = new EventTarget(), fakeDocument = new EventTarget();
  fakeDocument.hidden = false;
  fakeDocument.body = {};
  fakeDocument.activeElement = null;
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  const input = new PilotInput({ tabIndex: 0, focus() {} });
  function key(code, type = 'keydown') {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { code, ctrlKey: false, altKey: false, metaKey: false });
    fakeWindow.dispatchEvent(event);
  }
  try {
    key('KeyW'); key('ArrowDown'); key('ArrowRight'); key('KeyL'); key('Space');
    assert.deepEqual(input.controls, { throttle: 1, pitch: 1, roll: 1, rudder: 1, brake: true });
    fakeWindow.dispatchEvent(new Event('blur'));
    assert.deepEqual(input.controls, neutral);
    key('KeyQ'); key('KeyJ'); key('ArrowUp'); key('KeyS');
    assert.deepEqual(input.controls, { throttle: -1, pitch: -1, roll: -1, rudder: -1, brake: false });
    fakeDocument.hidden = true;
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(input.controls, neutral);
    fakeDocument.hidden = false;
    key('KeyZ');
    input.enabled = false;
    assert.deepEqual(input.controls, neutral);
    key('KeyW');
    assert.deepEqual(input.controls, neutral);
    input.enabled = true;
    key('KeyW');
    input.dispose(); input.dispose();
    assert.deepEqual(input.controls, neutral);
    key('KeyW');
    assert.deepEqual(input.controls, neutral);
  } finally {
    input.dispose();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test('autopilot visits every authored phase, ends at the runway target, and never loops', () => {
  const sequence = new FlightSequence(() => 0);
  sequence.start();
  const phases = new Set([sequence.state.phase]);
  let maximumAltitude = 0;
  let previous = sequence.state.position.clone();
  let maximumStep = 0;
  for (let i = 0; i < 55.2 * 120 + 1; i++) {
    sequence.update(1 / 120);
    phases.add(sequence.state.phase);
    maximumAltitude = Math.max(maximumAltitude, sequence.state.altitude);
    maximumStep = Math.max(maximumStep, previous.distanceTo(sequence.state.position));
    previous.copy(sequence.state.position);
    assert.ok(Number.isFinite(sequence.state.speed));
  }
  assert.equal(phases.size, 16);
  assert.ok(maximumAltitude >= 109);
  assert.ok(maximumStep < 1, `cinematic discontinuity: ${maximumStep} units/frame`);
  assert.equal(sequence.route.closed, false);
  assert.equal(sequence.route.curveType, 'centripetal');
  assert.equal(sequence.route.arcLengthDivisions, 900);
  assert.equal(sequence.state.phase, 'complete');
  assert.equal(sequence.progress, 1);
  assert.deepEqual(sequence.state.position.toArray(), [0, 0, 104]);
  assert.equal(sequence.state.speed, 0);
  sequence.update(100);
  assert.equal(sequence.state.phase, 'complete');
  assert.deepEqual(sequence.state.position.toArray(), [0, 0, 104]);
});
