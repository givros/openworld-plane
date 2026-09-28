import * as THREE from 'three';
import { clamp, damp } from '../game/types';

export class InspectionCamera {
  enabled = true;
  preset = 'front';
  private distance = 26;
  private polar = 1.42;
  private azimuth = 1.1;
  private targetDistance = 26;
  private targetPolar = 1.42;
  private targetAzimuth = 1.1;
  private readonly pan = new THREE.Vector3();
  private readonly targetPan = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private drag = false;
  private panning = false;
  private x = 0;
  private y = 0;
  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly element: HTMLCanvasElement) {
    element.addEventListener('pointerdown', this.down); element.addEventListener('pointermove', this.move);
    element.addEventListener('pointerup', this.up); element.addEventListener('pointercancel', this.up);
    element.addEventListener('lostpointercapture', this.up); element.addEventListener('wheel', this.wheel, { passive: false });
    element.addEventListener('contextmenu', this.menu);
  }
  private readonly menu = (e: Event): void => { if (this.enabled) e.preventDefault(); };
  private readonly down = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.drag = true; this.panning = e.shiftKey || e.button !== 0; this.x = e.clientX; this.y = e.clientY;
    this.element.setPointerCapture(e.pointerId); this.element.focus();
  };
  private readonly move = (e: PointerEvent): void => {
    if (!this.drag || !this.enabled) return;
    const dx = e.clientX - this.x, dy = e.clientY - this.y;
    this.x = e.clientX; this.y = e.clientY;
    if (this.panning) {
      this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
      this.targetPan.addScaledVector(this.right, -dx * this.distance * .0012);
      this.targetPan.y += dy * this.distance * .0012;
      this.targetPan.clampLength(0, 12);
    } else { this.targetAzimuth -= dx * .006; this.targetPolar = clamp(this.targetPolar - dy * .004, .24, 1.48); }
  };
  private readonly up = (): void => { this.drag = false; };
  private readonly wheel = (e: WheelEvent): void => { if (!this.enabled) return; e.preventDefault(); this.targetDistance = clamp(this.targetDistance * Math.exp(e.deltaY * .001), 9.5, 42); };
  setPreset(index: number): void {
    const presets = [[14.5,1.32,1.02], [16,1.42,1.47], [16.5,1.25,2.35], [17.8,.48,.65]];
    const value = presets[clamp(index,0,3)];
    this.targetDistance = value[0]; this.targetPolar = value[1]; this.targetAzimuth = value[2];
    this.targetPan.set(0,0,0); this.preset = ['front','side','rear','above'][index];
  }
  reset(): void { this.targetDistance = 26; this.targetPolar = 1.42; this.targetAzimuth = 1.1; this.targetPan.set(0,0,0); this.preset='front'; }
  update(dt: number, p: THREE.Vector3, instant = false): void {
    const d = instant ? 1 : 1-Math.exp(-10*dt);
    this.distance += (this.targetDistance-this.distance)*d; this.polar += (this.targetPolar-this.polar)*d; this.azimuth += (this.targetAzimuth-this.azimuth)*d;
    this.pan.lerp(this.targetPan, instant ? 1 : 1-Math.exp(-12*dt));
    this.target.copy(p).add(this.pan); this.target.y += 2.36;
    this.camera.position.set(Math.sin(this.azimuth)*Math.sin(this.polar)*this.distance, Math.cos(this.polar)*this.distance, Math.cos(this.azimuth)*Math.sin(this.polar)*this.distance).add(this.target);
    this.camera.up.set(0,1,0); this.camera.lookAt(this.target);
    this.camera.fov = instant ? 30 : damp(this.camera.fov,30,10,dt); this.camera.updateProjectionMatrix();
  }
  dispose(): void {
    const e=this.element; e.removeEventListener('pointerdown',this.down); e.removeEventListener('pointermove',this.move); e.removeEventListener('pointerup',this.up); e.removeEventListener('pointercancel',this.up); e.removeEventListener('lostpointercapture',this.up); e.removeEventListener('wheel',this.wheel); e.removeEventListener('contextmenu',this.menu);
  }
}
