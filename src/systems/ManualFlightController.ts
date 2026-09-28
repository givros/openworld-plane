import { Vector3 } from 'three';
import { clamp, damp, DEG, smooth } from '../game/types';
import type { Controls, FlightState, GroundSampler } from '../game/types';

const FIXED_STEP = 1 / 120;
const WHEELS = [
  [-1.76, 0.52, 0.72, 0.52],
  [1.76, 0.52, 0.72, 0.52],
  [0, 0.20, -4.67, 0.20],
] as const;

/** Root height for the lowest wheel to touch its actual terrain sample. */
export function wheelSupportHeight(sampleGround: GroundSampler, x: number, z: number, yaw: number, pitch: number, bank: number): number {
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sb = Math.sin(bank), cb = Math.cos(bank);
  let height = -Infinity;
  for (let i = 0; i < WHEELS.length; i++) {
    const wheel = WHEELS[i];
    const bx = wheel[0] * cb - wheel[1] * sb;
    const by = wheel[0] * sb + wheel[1] * cb;
    const pz = wheel[2] * cp - by * sp;
    const worldY = by * cp + wheel[2] * sp;
    const terrain = sampleGround(x + bx * cy + pz * sy, z - bx * sy + pz * cy);
    height = Math.max(height, terrain - worldY + wheel[3]);
  }
  return height;
}

/** Fixed-step authored aerodynamics; aircraft geometry has no rigid-body dependency. */
export class ManualFlightController {
  readonly state: FlightState;
  private readonly sampleGround: GroundSampler;
  private accumulator = 0;
  private active = false;
  private guard = 0;
  private separationGuard = 0;
  private touchdownTime = 0;
  private airborneTime = 0;

  constructor(sampleGround: GroundSampler) {
    this.sampleGround = sampleGround;
    this.state = {
      position: new Vector3(), yaw: 0, pitch: 0, bank: 0,
      speed: 0, verticalSpeed: 0, throttle: 0, rpm: 720,
      flightPathAngle: 0, angleOfAttack: 0, stallSeverity: 0,
      grounded: true, crashed: false, phase: 'manual-ready', elapsed: 0,
      altitude: 0, pitchRate: 0, rollRate: 0, yawRate: 0,
      landings: 0, takeoffs: 0,
    };
    this.reset();
  }

  get contactGuard(): number { return this.guard; }
  get liftoffGuard(): number { return this.separationGuard; }

  start(): void {
    this.reset();
    this.active = true;
  }

  reset(): void {
    const s = this.state;
    s.position.set(0, this.sampleGround(0, -112), -112);
    s.yaw = s.pitch = s.bank = s.speed = s.verticalSpeed = s.throttle = 0;
    s.flightPathAngle = s.angleOfAttack = s.stallSeverity = 0;
    s.pitchRate = s.rollRate = s.yawRate = s.elapsed = s.altitude = 0;
    s.landings = s.takeoffs = 0;
    s.rpm = 720;
    s.grounded = true;
    s.crashed = false;
    s.phase = 'manual-ready';
    this.accumulator = this.guard = this.separationGuard = this.touchdownTime = this.airborneTime = 0;
    this.active = false;
  }

  update(dt: number, controls: Controls): void {
    if (!this.active || this.state.crashed || !Number.isFinite(dt)) return;
    this.accumulator += clamp(dt, 0, 0.12);
    while (this.accumulator + 1e-12 >= FIXED_STEP) {
      this.step(FIXED_STEP, controls);
      this.accumulator -= FIXED_STEP;
      if (this.state.crashed) { this.accumulator = 0; break; }
    }
  }

  private step(dt: number, controls: Controls): void {
    const s = this.state;
    s.elapsed += dt;
    this.guard = Math.max(0, this.guard - dt);
    this.touchdownTime = Math.max(0, this.touchdownTime - dt);
    const throttleInput = clamp(controls.throttle, -1, 1);
    s.throttle = clamp(s.throttle + throttleInput * (throttleInput > 0 ? 0.48 : 0.62) * dt);
    s.rpm = damp(s.rpm, 720 + s.throttle * 1780, 3.6, dt);
    if (s.grounded) this.updateGround(dt, controls);
    else this.updateAir(dt, controls);
    s.altitude = Math.max(0, s.position.y - this.sampleGround(s.position.x, s.position.z));
  }

  private updateGround(dt: number, controls: Controls): void {
    const s = this.state;
    const efficiency = 1 - 0.28 * clamp(s.speed / 78);
    const drag = s.speed * s.speed * 0.0028;
    const resistance = s.speed > 0 ? 0.58 + drag : 0;
    s.speed = clamp(s.speed + (s.throttle * 13.2 * efficiency - resistance - (controls.brake ? 17.5 : 0)) * dt, 0, 58);
    const steeringAuthority = smooth(1.5, 19, s.speed) * 0.72;
    const steerTarget = -(clamp(controls.roll, -1, 1) * 0.58 + clamp(controls.rudder, -1, 1) * 0.42) * steeringAuthority;
    s.yawRate = damp(s.yawRate, steerTarget, 5.2, dt);
    s.yaw += s.yawRate * dt;
    const authority = smooth(15, 31, s.speed);
    const pitchTarget = clamp(controls.pitch, -1, 1) * 24 * DEG * authority - s.pitch * 1.65;
    s.pitchRate = damp(s.pitchRate, pitchTarget, 3.4, dt);
    s.pitch = clamp(s.pitch + s.pitchRate * dt, 0, 12.5 * DEG);
    s.rollRate = damp(s.rollRate, -s.bank * 4.2, 5.8, dt);
    s.bank = clamp(s.bank + s.rollRate * dt, -8 * DEG, 8 * DEG);
    s.position.x += Math.sin(s.yaw) * s.speed * dt;
    s.position.z += Math.cos(s.yaw) * s.speed * dt;
    s.position.y = wheelSupportHeight(this.sampleGround, s.position.x, s.position.z, s.yaw, s.pitch, s.bank);
    s.verticalSpeed = s.flightPathAngle = s.angleOfAttack = s.stallSeverity = 0;

    if (this.propellerClearance() < -0.002) { this.crash(); return; }
    if (s.throttle >= 0.5 && s.speed >= 29 && s.pitch > 5 * DEG && this.guard <= 1e-10) {
      s.grounded = false;
      s.phase = 'liftoff';
      s.takeoffs++;
      s.flightPathAngle = 1.2 * DEG;
      s.verticalSpeed = s.speed * Math.sin(s.flightPathAngle);
      s.position.y += 0.08;
      this.separationGuard = 0.22;
      this.airborneTime = 0;
      return;
    }
    if (s.speed < 0.75 && s.throttle < 0.04) {
      s.speed = 0;
      s.phase = 'manual-ready';
    } else if (this.touchdownTime > 0) s.phase = 'touchdown';
    else if (s.landings > 0 && (s.throttle < 0.5 || controls.brake)) s.phase = 'rollout';
    else s.phase = s.pitch > 3 * DEG && s.speed > 23 ? 'rotation' : 'takeoff-roll';
  }

  private updateAir(dt: number, controls: Controls): void {
    const s = this.state;
    this.airborneTime += dt;
    const speedAuthority = 0.18 + 0.82 * smooth(16, 43, s.speed);
    const pitchTarget = clamp(controls.pitch, -1, 1) * 34 * DEG * speedAuthority
      + (2.4 * DEG - s.pitch) * 0.34 - s.stallSeverity * 12 * DEG;
    const rollTarget = clamp(controls.roll, -1, 1) * 78 * DEG * speedAuthority - s.bank * 0.42;
    s.pitchRate = damp(s.pitchRate, pitchTarget, 2.25, dt);
    s.rollRate = damp(s.rollRate, rollTarget, 2.55, dt);
    s.pitch = clamp(s.pitch + s.pitchRate * dt, -22 * DEG, 27 * DEG);
    s.bank = clamp(s.bank + s.rollRate * dt, -52 * DEG, 52 * DEG);
    s.angleOfAttack = clamp(s.pitch - s.flightPathAngle, -35 * DEG, 35 * DEG);
    const angleStall = smooth(14 * DEG, 24 * DEG, Math.abs(s.angleOfAttack));
    const lowSpeedStall = 1 - smooth(20, 30, s.speed);
    s.stallSeverity = 1 - (1 - angleStall) * (1 - lowSpeedStall);
    const linearCl = 0.18 + 4.4 * s.angleOfAttack;
    const separatedCl = Math.sign(linearCl) * (0.72 + (0.38 - 0.72) * angleStall);
    const liftCoefficient = linearCl + (separatedCl - linearCl) * angleStall;
    const dynamicPressure = s.speed * s.speed * 0.018;
    const lift = dynamicPressure * liftCoefficient;
    const dragCoefficient = 0.032 + 0.052 * liftCoefficient * liftCoefficient + angleStall * 0.24;
    const drag = dynamicPressure * dragCoefficient;
    const thrust = s.throttle * 10.8 * (1 - 0.48 * clamp(s.speed / 78));
    const tangentialAcceleration = thrust - drag - 9.81 * Math.sin(s.flightPathAngle);
    s.speed = clamp(s.speed + tangentialAcceleration * dt, 11, 78);
    const pathRate = (lift * Math.cos(s.bank) - 9.81 * Math.cos(s.flightPathAngle)) / Math.max(s.speed, 14);
    s.flightPathAngle = clamp(s.flightPathAngle + pathRate * dt, -38 * DEG, 30 * DEG);
    const horizontalSpeed = s.speed * Math.cos(s.flightPathAngle);
    const coordinatedTurn = -9.81 * Math.tan(s.bank) * (1 - s.stallSeverity * 0.6) / Math.max(horizontalSpeed, 14);
    const rudderTurn = -clamp(controls.rudder, -1, 1) * 19 * DEG * speedAuthority;
    s.yawRate = damp(s.yawRate, coordinatedTurn + rudderTurn, 3.5, dt);
    s.yaw += s.yawRate * dt;
    s.verticalSpeed = s.speed * Math.sin(s.flightPathAngle);
    s.position.x += Math.sin(s.yaw) * horizontalSpeed * dt;
    s.position.z += Math.cos(s.yaw) * horizontalSpeed * dt;
    s.position.y += s.verticalSpeed * dt;
    const supportHeight = wheelSupportHeight(this.sampleGround, s.position.x, s.position.z, s.yaw, s.pitch, s.bank);
    if (this.separationGuard > 0) {
      this.separationGuard = Math.max(0, this.separationGuard - dt);
      s.position.y = Math.max(s.position.y, supportHeight + 0.06);
    } else if (s.position.y <= supportHeight) {
      if (this.safeTouchdown()) {
        this.touchDown();
        s.position.y = wheelSupportHeight(this.sampleGround, s.position.x, s.position.z, s.yaw, s.pitch, s.bank);
      } else { this.crash(); return; }
    }
    if (this.propellerClearance() < -0.002) { this.crash(); return; }
    if (!s.grounded) s.phase = this.airborneTime < 0.9 ? 'liftoff' : 'flight';
  }

  private safeTouchdown(): boolean {
    const s = this.state;
    const x = s.position.x, z = s.position.z;
    const slopeX = (this.sampleGround(x + 3, z) - this.sampleGround(x - 3, z)) / 6;
    const slopeZ = (this.sampleGround(x, z + 3) - this.sampleGround(x, z - 3)) / 6;
    const slope = Math.atan(Math.hypot(slopeX, slopeZ));
    const onRunway = Math.abs(x) <= 12 && Math.abs(z) <= 180;
    const runwayAlignment = Math.acos(Math.min(1, Math.abs(Math.cos(s.yaw))));
    return s.verticalSpeed >= -5.2 && s.speed >= 10 && s.speed <= 56
      && Math.abs(s.bank) <= 18 * DEG && s.pitch >= -5 * DEG && s.pitch <= 16 * DEG
      && slope <= 8 * DEG && (!onRunway || runwayAlignment <= 42 * DEG);
  }

  private touchDown(): void {
    const s = this.state;
    s.speed *= Math.cos(s.flightPathAngle);
    s.flightPathAngle = s.verticalSpeed = s.angleOfAttack = s.stallSeverity = 0;
    s.pitchRate *= 0.18;
    s.rollRate *= 0.16;
    s.yawRate *= 0.35;
    s.bank *= 0.28;
    s.pitch = Math.max(0, s.pitch * 0.58);
    s.grounded = true;
    s.phase = 'touchdown';
    s.landings++;
    this.guard = 0.20;
    this.touchdownTime = 0.9;
    this.separationGuard = 0;
  }

  /** Samples the entire safety disc as well as its exact lowest point. */
  propellerClearance(): number {
    const s = this.state;
    const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    const sp = Math.sin(s.pitch), cp = Math.cos(s.pitch);
    const sb = Math.sin(s.bank), cb = Math.cos(s.bank);
    let clearance = Infinity;
    for (let i = 0; i <= 16; i++) {
      const angle = i === 16 ? -Math.PI / 2 - s.bank : i * Math.PI / 8;
      const localX = Math.cos(angle) * 1.86;
      const localY = 2.42 + Math.sin(angle) * 1.86;
      const bx = localX * cb - localY * sb;
      const by = localX * sb + localY * cb;
      const pz = 4.34 * cp - by * sp;
      const worldX = s.position.x + bx * cy + pz * sy;
      const worldZ = s.position.z - bx * sy + pz * cy;
      const worldY = s.position.y + by * cp + 4.34 * sp;
      clearance = Math.min(clearance, worldY - this.sampleGround(worldX, worldZ));
    }
    return clearance;
  }

  private crash(): void {
    const s = this.state;
    s.crashed = true;
    s.grounded = true;
    s.phase = 'crashed';
    s.speed = s.verticalSpeed = s.throttle = s.rpm = 0;
    s.pitchRate = s.rollRate = s.yawRate = 0;
    s.position.y = Math.max(s.position.y, this.sampleGround(s.position.x, s.position.z));
  }
}
