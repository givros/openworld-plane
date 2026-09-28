import { CatmullRomCurve3, Vector3 } from 'three';
import { clamp, DEG, smooth } from '../game/types';
import type { FlightPhase, FlightState, GroundSampler } from '../game/types';
import { wheelSupportHeight } from './ManualFlightController';

const PHASES: readonly (readonly [number, FlightPhase])[] = [
  [0, 'anticipation'], [1.6, 'prop-spin-up'], [4.2, 'takeoff-roll'], [9.6, 'rotation'],
  [11, 'liftoff'], [13.4, 'climb'], [18.4, 'scenic-outbound'], [23.4, 'scenic-turn'],
  [29.4, 'return'], [33.9, 'descent'], [37.9, 'final-approach'], [41, 'touchdown'],
  [42.8, 'rollout'], [50.2, 'stopping'], [52.4, 'finale'], [55.2, 'complete'],
];
const ROUTE_TIMES = [11, 13.4, 18.4, 23.4, 29.4, 33.9, 37.9, 41];
const ROUTE_PROGRESS = [0, 0.060, 0.238, 0.425, 0.674, 0.839, 0.951, 1];
const TAKEOFF_END_Z = 47.3;
const TOUCHDOWN_Z = -96;

export class FlightSequence {
  readonly duration = 55.2;
  readonly state: FlightState;
  readonly route: CatmullRomCurve3;
  private readonly sampleGround: GroundSampler;
  private readonly tangent = new Vector3();
  private readonly ahead = new Vector3();
  private readonly behind = new Vector3();
  private readonly slopes = new Float64Array(ROUTE_TIMES.length);
  private readonly routeLength: number;
  private active = false;

  constructor(sampleGround: GroundSampler = () => 0) {
    this.sampleGround = sampleGround;
    const y = sampleGround(0, TAKEOFF_END_Z);
    this.route = new CatmullRomCurve3([
      new Vector3(0, y, TAKEOFF_END_Z), new Vector3(0, y + 16, 160),
      new Vector3(0, y + 50, 250), new Vector3(35, y + 78, 340),
      new Vector3(120, y + 96, 385), new Vector3(205, y + 108, 330),
      new Vector3(240, y + 110, 185), new Vector3(232, y + 108, 15),
      new Vector3(210, y + 102, -155), new Vector3(175, y + 90, -275),
      new Vector3(110, y + 78, -350), new Vector3(35, y + 64, -370),
      new Vector3(-25, y + 52, -335), new Vector3(-55, y + 42, -270),
      new Vector3(-32, y + 34, -215), new Vector3(-6, y + 24, -190),
      new Vector3(0, y + 15, -165), new Vector3(0, y + 6, -128),
      new Vector3(0, y, TOUCHDOWN_Z),
    ], false, 'centripetal');
    this.route.arcLengthDivisions = 900;
    this.route.updateArcLengths();
    this.routeLength = this.route.getLength();
    for (let i = 1; i < ROUTE_TIMES.length - 1; i++) {
      const before = (ROUTE_PROGRESS[i] - ROUTE_PROGRESS[i - 1]) / (ROUTE_TIMES[i] - ROUTE_TIMES[i - 1]);
      const after = (ROUTE_PROGRESS[i + 1] - ROUTE_PROGRESS[i]) / (ROUTE_TIMES[i + 1] - ROUTE_TIMES[i]);
      this.slopes[i] = 2 * before * after / (before + after);
    }
    this.slopes[0] = 43 / this.routeLength;
    this.slopes[this.slopes.length - 1] = 25 / this.routeLength;
    this.state = {
      position: new Vector3(), yaw: 0, pitch: 0, bank: 0,
      speed: 0, verticalSpeed: 0, throttle: 0, rpm: 720,
      flightPathAngle: 0, angleOfAttack: 0, stallSeverity: 0,
      grounded: true, crashed: false, phase: 'anticipation', elapsed: 0,
      altitude: 0, pitchRate: 0, rollRate: 0, yawRate: 0,
      landings: 0, takeoffs: 0,
    };
    this.reset();
  }

  get progress(): number { return this.state.elapsed / this.duration; }

  start(): void { this.reset(); this.active = true; }

  reset(): void {
    const s = this.state;
    s.position.set(0, this.sampleGround(0, -112), -112);
    s.elapsed = s.yaw = s.pitch = s.bank = s.speed = s.verticalSpeed = s.throttle = 0;
    s.flightPathAngle = s.angleOfAttack = s.stallSeverity = 0;
    s.pitchRate = s.rollRate = s.yawRate = s.altitude = 0;
    s.landings = s.takeoffs = 0;
    s.rpm = 720;
    s.grounded = true;
    s.crashed = false;
    s.phase = 'anticipation';
    this.active = false;
  }

  update(dt: number): void {
    if (!this.active || !Number.isFinite(dt)) return;
    const s = this.state;
    const previousYaw = s.yaw, previousPitch = s.pitch, previousBank = s.bank;
    const actualDelta = Math.min(Math.max(0, dt), this.duration - s.elapsed);
    s.elapsed = Math.min(this.duration, s.elapsed + actualDelta);
    const t = s.elapsed;
    for (let i = PHASES.length - 1; i >= 0; i--) {
      if (t + 1e-9 >= PHASES[i][0]) { s.phase = PHASES[i][1]; break; }
    }
    if (t < 11) this.takeoff(t);
    else if (t < 41) this.flight(t);
    else this.landing(t);
    if (actualDelta > 0) {
      s.pitchRate = (s.pitch - previousPitch) / actualDelta;
      s.rollRate = (s.bank - previousBank) / actualDelta;
      s.yawRate = Math.atan2(Math.sin(s.yaw - previousYaw), Math.cos(s.yaw - previousYaw)) / actualDelta;
    }
    s.rpm = 720 + s.throttle * 1780;
    s.altitude = Math.max(0, s.position.y - this.sampleGround(s.position.x, s.position.z));
    if (t >= this.duration) this.active = false;
  }

  private takeoff(t: number): void {
    const s = this.state;
    s.grounded = true;
    s.bank = s.yaw = s.flightPathAngle = s.verticalSpeed = 0;
    s.throttle = t < 1.6 ? 0 : smooth(1.6, 4.2, t);
    s.pitch = 0;
    let z = -112;
    if (t >= 4.2 && t < 9.6) {
      const elapsed = t - 4.2;
      const acceleration = 38 / 5.4;
      s.speed = acceleration * elapsed;
      z += 0.5 * acceleration * elapsed * elapsed;
    } else if (t >= 9.6) {
      const elapsed = t - 9.6;
      const acceleration = 5 / 1.4;
      s.speed = 38 + acceleration * elapsed;
      z = -9.4 + 38 * elapsed + 0.5 * acceleration * elapsed * elapsed;
      s.pitch = smooth(9.6, 11, t) * 9 * DEG;
    } else s.speed = 0;
    s.position.set(0, wheelSupportHeight(this.sampleGround, 0, z, 0, s.pitch, 0), z);
  }

  /** Monotone Hermite timing keeps speed continuous at cinematic phase boundaries. */
  private routeProgress(t: number): number {
    let i = 0;
    while (i < ROUTE_TIMES.length - 2 && t > ROUTE_TIMES[i + 1]) i++;
    const width = ROUTE_TIMES[i + 1] - ROUTE_TIMES[i];
    const u = clamp((t - ROUTE_TIMES[i]) / width);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ROUTE_PROGRESS[i]
      + (u3 - 2 * u2 + u) * width * this.slopes[i]
      + (-2 * u3 + 3 * u2) * ROUTE_PROGRESS[i + 1]
      + (u3 - u2) * width * this.slopes[i + 1];
  }

  private flight(t: number): void {
    const s = this.state;
    const u = this.routeProgress(t);
    this.route.getPointAt(u, s.position);
    this.route.getPointAt(clamp(u - 0.001), this.behind);
    this.route.getPointAt(clamp(u + 0.001), this.ahead);
    this.tangent.subVectors(this.ahead, this.behind).normalize();
    s.yaw = Math.atan2(this.tangent.x, this.tangent.z);
    s.flightPathAngle = Math.atan2(this.tangent.y, Math.hypot(this.tangent.x, this.tangent.z));
    const timingBefore = Math.max(11, t - 0.01), timingAfter = Math.min(41, t + 0.01);
    s.speed = this.routeLength * (this.routeProgress(timingAfter) - this.routeProgress(timingBefore)) / (timingAfter - timingBefore);
    s.verticalSpeed = s.speed * Math.sin(s.flightPathAngle);
    s.pitch = clamp(s.flightPathAngle + 2.4 * DEG, -4 * DEG, 16 * DEG);
    if (t < 11.5) s.pitch = 9 * DEG + (s.pitch - 9 * DEG) * smooth(11, 11.5, t);
    if (t > 37.9) s.pitch += smooth(37.9, 41, t) * (3 * DEG - s.pitch);
    this.route.getPointAt(clamp(u + 0.003), this.ahead);
    this.ahead.sub(s.position);
    const aheadYaw = Math.atan2(this.ahead.x, this.ahead.z);
    const yawDelta = Math.atan2(Math.sin(aheadYaw - s.yaw), Math.cos(aheadYaw - s.yaw));
    const yawRate = yawDelta * s.speed / Math.max(0.001, this.routeLength * 0.0015);
    s.bank = clamp(Math.atan(-yawRate * s.speed / 9.81), -38 * DEG, 38 * DEG);
    s.bank *= smooth(11, 13.4, t) * (1 - smooth(36.8, 39.2, t));
    const wheelHeight = wheelSupportHeight(this.sampleGround, s.position.x, s.position.z, s.yaw, s.pitch, s.bank);
    const lowAltitudeOffset = (1 - smooth(0, 4, s.position.y)) * Math.max(0, wheelHeight);
    s.position.y += lowAltitudeOffset;
    s.throttle = t < 33.9 ? 0.84 : 0.84 + (0.16 - 0.84) * smooth(33.9, 41, t);
    s.angleOfAttack = s.pitch - s.flightPathAngle;
    s.stallSeverity = 0;
    s.grounded = false;
    s.takeoffs = 1;
  }

  private landing(t: number): void {
    const s = this.state;
    s.grounded = true;
    s.takeoffs = s.landings = 1;
    s.bank = s.yaw = s.flightPathAngle = s.verticalSpeed = s.angleOfAttack = s.stallSeverity = 0;
    s.pitch = 3 * DEG * (1 - smooth(41, 42.8, t));
    s.throttle = 0.16 * (1 - smooth(41, 44.6, t));
    let distance = 0;
    if (t < 42.8) {
      const elapsed = t - 41;
      s.speed = 25 - (1 / 1.8) * elapsed;
      distance = 25 * elapsed - 0.5 / 1.8 * elapsed * elapsed;
    } else if (t < 50.2) {
      const elapsed = t - 42.8;
      const coastDuration = 4.729113924050633;
      const brakingTime = Math.max(0, elapsed - coastDuration);
      const acceleration = (24 - 4.25) / (7.4 - coastDuration);
      s.speed = 24 - acceleration * brakingTime;
      distance = 44.1 + 24 * elapsed - 0.5 * acceleration * brakingTime * brakingTime;
    } else if (t < 52.4) {
      const elapsed = t - 50.2;
      const acceleration = 4.25 / 2.2;
      s.speed = 4.25 - acceleration * elapsed;
      distance = 195.325 + 4.25 * elapsed - 0.5 * acceleration * elapsed * elapsed;
    } else { s.speed = 0; distance = 200; }
    const z = TOUCHDOWN_Z + distance;
    s.position.set(0, wheelSupportHeight(this.sampleGround, 0, z, 0, s.pitch, 0), z);
  }
}
