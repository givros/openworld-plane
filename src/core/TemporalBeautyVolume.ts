import * as THREE from 'three';

/** Retain a visibility superset only while the complete current camera frustum
 * and distance sphere remain inside it. Camera teleports/turns refresh at once. */
export class TemporalBeautyVolume{
  readonly frustum=new THREE.Frustum();
  readonly origin=new THREE.Vector3();
  readonly translationMargin=24;
  pixelsPerRadian=0;
  distance=Infinity;
  revision=0;
  readonly statistics={refreshes:0,reuses:0};
  private height=0;
  private readonly point=new THREE.Vector3();
  private readonly inverseProjectionView=new THREE.Matrix4();
  update(camera:THREE.PerspectiveCamera,current:THREE.Frustum,distance:number,height:number):boolean{
    this.point.setFromMatrixPosition(camera.matrixWorld);
    const movement=this.point.distanceTo(this.origin);
    const pixels=height*Math.abs(camera.projectionMatrix.elements[5])*.5;
    let reuse=this.revision>0&&height===this.height&&movement<=this.translationMargin&&
      pixels<=this.pixelsPerRadian&&distance+movement<=this.distance;
    if(reuse){
      this.inverseProjectionView.multiplyMatrices(camera.matrixWorld,camera.projectionMatrixInverse);
      const nearClip=camera.reversedDepth||camera.coordinateSystem===THREE.WebGPUCoordinateSystem?0:-1;
      outer:for(const x of [-1,1])for(const y of [-1,1])for(const z of [nearClip,1]){
        this.point.set(x,y,z).applyMatrix4(this.inverseProjectionView);
        for(const plane of this.frustum.planes)if(!(plane.distanceToPoint(this.point)>=.00001)){reuse=false;break outer;}
      }
    }
    if(reuse){this.statistics.reuses++;return false;}
    this.frustum.copy(current);
    for(const plane of this.frustum.planes)plane.constant+=24;
    this.origin.setFromMatrixPosition(camera.matrixWorld);
    this.distance=distance+this.translationMargin;
    this.pixelsPerRadian=pixels*1.06;
    this.height=height;this.revision++;this.statistics.refreshes++;
    return true;
  }
}
