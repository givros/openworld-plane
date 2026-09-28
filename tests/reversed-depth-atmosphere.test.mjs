import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/systems/Atmosphere.ts';

test('CSM keeps identical world-space coverage with a reversed view projection',()=>{
 const normalCamera=new THREE.PerspectiveCamera(42,1.6,.15,16000),reversedCamera=normalCamera.clone();
 normalCamera.position.set(1800,320,210);normalCamera.lookAt(1500,100,0);normalCamera.updateMatrixWorld();
 reversedCamera.copy(normalCamera);reversedCamera._reversedDepth=true;reversedCamera.updateProjectionMatrix();
 const normal=new Atmosphere(new THREE.Scene(),{capabilities:{reversedDepthBuffer:false},shadowMap:{}},normalCamera);
 const reversed=new Atmosphere(new THREE.Scene(),{capabilities:{reversedDepthBuffer:true},shadowMap:{}},reversedCamera);
 try{
  for(const range of [300,600,1200,6000]){
   normalCamera.far=range;normalCamera.updateProjectionMatrix();
   reversedCamera.far=range;reversedCamera.updateProjectionMatrix();
   const projection=reversedCamera.projectionMatrix.clone();
   normal.setViewDistance(range,range,320);reversed.setViewDistance(range,range,320);
   normal.prepareRender();reversed.prepareRender();
   assert.ok(reversedCamera.projectionMatrix.equals(projection),'CSM bounds must not alter the render projection');
   assert.equal(reversed.sunlight.camera,reversedCamera,'CSM must retain the actual view camera after updating bounds');
   for(let cascade=0;cascade<4;cascade++){
    const a=normal.sunlight.frustums[cascade],b=reversed.sunlight.frustums[cascade];
    for(const side of ['near','far'])for(let corner=0;corner<4;corner++)
     assert.ok(a.vertices[side][corner].distanceTo(b.vertices[side][corner])<1e-8);
    const shadowA=normal.sunlight.lights[cascade].shadow.camera,shadowB=reversed.sunlight.lights[cascade].shadow.camera;
    assert.equal(shadowA.reversedDepth,false);assert.equal(shadowB.reversedDepth,true);
    for(const field of ['left','right','top','bottom','near','far'])assert.equal(shadowA[field],shadowB[field]);
    assert.ok(normal.sunlight.lights[cascade].position.distanceTo(reversed.sunlight.lights[cascade].position)<1e-8);
   }
  }
 }finally{normal.dispose();reversed.dispose();}
});
