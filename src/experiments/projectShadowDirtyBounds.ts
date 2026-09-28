import * as THREE from 'three';
import type { ShadowCacheRect } from './ScrollingShadowCache';

/** Conservative pixel rectangles of changed full-detail caster bounds. */
export function projectShadowDirtyBounds(light:THREE.DirectionalLight,bounds:readonly THREE.Box3[]):ShadowCacheRect[]|undefined {
  const camera=light.shadow.camera,width=light.shadow.mapSize.x,height=light.shadow.mapSize.y;
  if(!(camera instanceof THREE.OrthographicCamera)||!Number.isInteger(width)||!Number.isInteger(height))return undefined;
  const projection=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(projection,camera.coordinateSystem,camera.reversedDepth);
  const point=new THREE.Vector3(),rectangles:ShadowCacheRect[]=[];
  for(const box of bounds){
    if(box.isEmpty())continue;
    if(![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))return undefined;
    if(!frustum.intersectsBox(box))continue;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(let mask=0;mask<8;mask++){
      point.set(mask&1?box.max.x:box.min.x,mask&2?box.max.y:box.min.y,mask&4?box.max.z:box.min.z).applyMatrix4(projection);
      minX=Math.min(minX,point.x);maxX=Math.max(maxX,point.x);minY=Math.min(minY,point.y);maxY=Math.max(maxY,point.y);
    }
    // Outward rounding and two guard pixels retain boundary samples despite
    // floating-point differences between CPU bounds and GPU rasterization.
    const x=Math.max(0,Math.floor((minX*.5+.5)*width)-2),y=Math.max(0,Math.floor((minY*.5+.5)*height)-2);
    const right=Math.min(width,Math.ceil((maxX*.5+.5)*width)+2),top=Math.min(height,Math.ceil((maxY*.5+.5)*height)+2);
    if(right>x&&top>y)rectangles.push({x,y,width:right-x,height:top-y});
  }
  return rectangles;
}
