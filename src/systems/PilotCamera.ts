import * as THREE from 'three';
import { clamp, damp, type FlightState } from '../game/types';
export class PilotCamera {
  private readonly desired = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();
  private ready = false;
  constructor(private readonly camera: THREE.PerspectiveCamera) {}
  reset(): void { this.ready = false; }
  update(dt: number, state: FlightState): void {
    const t = clamp(state.speed / 78), s = Math.sin(state.yaw), c = Math.cos(state.yaw);
    const back = 17 + t*7, side = state.grounded ? 4.2 : 2.1, height=5.6+t*2.6;
    this.desired.set(state.position.x - s*back-c*side, state.position.y+height, state.position.z-c*back+s*side);
    this.target.set(state.position.x+s*(12+t*12), state.position.y+2.1+Math.max(0,state.pitch)*5, state.position.z+c*(12+t*12));
    this.camera.position.lerp(this.desired,this.ready ? 1-Math.exp(-5.2*dt):1);
    this.smoothTarget.lerp(this.target,this.ready ? 1-Math.exp(-7.2*dt):1);
    this.camera.up.set(0,1,0); this.camera.lookAt(this.smoothTarget);
    this.camera.fov=this.ready?damp(this.camera.fov,43+t*9,4.5,dt):43+t*9;
    this.camera.updateProjectionMatrix(); this.ready=true;
  }
}
