import type { Vector3 } from 'three';

export type FlightPhase = 'inspection' | 'manual-ready' | 'takeoff-roll' | 'rotation' | 'liftoff' | 'flight' | 'touchdown' | 'rollout' | 'crashed' | 'anticipation' | 'prop-spin-up' | 'climb' | 'scenic-outbound' | 'scenic-turn' | 'return' | 'descent' | 'final-approach' | 'stopping' | 'finale' | 'complete';
export type GameMode = 'inspection' | 'manual' | 'autopilot';
export interface Controls { throttle: number; pitch: number; roll: number; rudder: number; brake: boolean; }
export interface FlightState {
  position: Vector3; yaw: number; pitch: number; bank: number;
  speed: number; verticalSpeed: number; throttle: number; rpm: number;
  flightPathAngle: number; angleOfAttack: number; stallSeverity: number;
  grounded: boolean; crashed: boolean; phase: FlightPhase; elapsed: number;
  altitude: number; pitchRate: number; rollRate: number; yawRate: number;
  landings: number; takeoffs: number;
}
export type GroundSampler = (x: number, z: number) => number;
export const DEG = Math.PI / 180;
export const clamp = (v: number, a = 0, b = 1): number => Math.max(a, Math.min(b, v));
export const smooth = (a: number, b: number, v: number): number => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
export const damp = (a: number, b: number, rate: number, dt: number): number => a + (b - a) * (1 - Math.exp(-rate * dt));
