import * as THREE from 'three';
import { damp, type FlightState } from '../game/types';
const SHOTS = [
  [0,19,8.5,23,0,2.3,1,42], [4.2,21,6.2,13,0,2.2,5,38], [9.6,-22,7,-10,0,2.4,8,40],
  [13.4,0,10,-27,0,3,12,45], [18.4,42,24,-38,0,3,12,48], [23.4,-19,4.8,2.2,0,2.35,.4,44],
  [29.4,4,20,-34,0,3,14,47], [37.9,23,7.6,31,0,2.35,4,42], [41,-21,5.1,18,0,2.1,5,39],
  [42.8,21,5.6,-10,0,2.15,7,39], [52.4,20.5,8.8,24,0,2.3,1,39],
];
export class CinematicCamera {
  shot = 'inspection';
  private readonly desired = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();
  private ready = false;
  constructor(private readonly camera: THREE.PerspectiveCamera) {}
  reset(): void { this.ready = false; }
  update(dt: number, state: FlightState): void {
    let idx=0; for(let i=1;i<SHOTS.length;i++) if(state.elapsed>=SHOTS[i][0])idx=i;
    const a=SHOTS[idx],s=Math.sin(state.yaw),c=Math.cos(state.yaw);
    this.desired.set(a[1]*c+a[3]*s,a[2],a[3]*c-a[1]*s).add(state.position);
    this.target.set(a[4]*c+a[6]*s,a[5],a[6]*c-a[4]*s).add(state.position);
    this.camera.position.lerp(this.desired,this.ready?1-Math.exp(-2.2*dt):1);
    this.smoothTarget.lerp(this.target,this.ready?1-Math.exp(-4*dt):1);
    this.camera.up.set(0,1,0);this.camera.lookAt(this.smoothTarget);
    this.camera.fov=this.ready?damp(this.camera.fov,a[7],3,dt):a[7];this.camera.updateProjectionMatrix();this.ready=true;
    this.shot=['inspection','runway-side','rotation-track','chase-climb','wide-scenic','wing-side','aerial-chase','approach','touchdown','rollout','final-hero'][idx];
  }
}
