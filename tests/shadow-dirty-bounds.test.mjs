import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {projectShadowDirtyBounds} from '../src/experiments/projectShadowDirtyBounds.ts';

function fixture(reversed=false){
  const scene=new THREE.Scene(),light=new THREE.DirectionalLight();scene.add(light,light.target);
  light.position.set(0,0,10);light.target.position.set(0,0,0);
  Object.assign(light.shadow.camera,{left:-5,right:5,bottom:-5,top:5,near:1,far:20,_reversedDepth:reversed});
  light.shadow.camera.updateProjectionMatrix();light.shadow.mapSize.set(100,100);
  scene.updateMatrixWorld(true);light.shadow.updateMatrices(light);return light;
}
test('dirty bounds cover removed and added caster pixels with outward guards',()=>{
  const light=fixture();
  assert.deepEqual(projectShadowDirtyBounds(light,[new THREE.Box3(new THREE.Vector3(-1,-2,-1),new THREE.Vector3(1,2,1))]),[{x:38,y:28,width:24,height:44}]);
  assert.deepEqual(projectShadowDirtyBounds(light,[new THREE.Box3(new THREE.Vector3(20,20,0),new THREE.Vector3(21,21,1))]),[]);
});
test('reversed depth retains the same XY regions and clipped borders',()=>{
  const box=new THREE.Box3(new THREE.Vector3(-8,-8,-1),new THREE.Vector3(1,1,1));
  assert.deepEqual(projectShadowDirtyBounds(fixture(),[box]),projectShadowDirtyBounds(fixture(true),[box]));
  assert.equal(projectShadowDirtyBounds(fixture(),[box])[0].x,0);
});
test('unknown nonfinite bounds require full invalidation',()=>{
  const box=new THREE.Box3(new THREE.Vector3(-Infinity,0,0),new THREE.Vector3(Infinity,1,1));
  assert.equal(projectShadowDirtyBounds(fixture(),[box]),undefined);
});
