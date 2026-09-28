import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {TemporalBeautyVolume} from '../src/core/TemporalBeautyVolume.ts';
import {registerDistanceDetailGeometry,DistanceDetailController} from '../src/world/DistanceDetailGeometry.ts';

function fixture(reversed=false,margin=24){
  const camera=new THREE.PerspectiveCamera(48,1.6,.15,6008);camera._reversedDepth=reversed;camera.updateProjectionMatrix();camera.position.set(0,100,0);
  const current=new THREE.Frustum(),matrix=new THREE.Matrix4(),cache=new TemporalBeautyVolume();
  cache.translationMargin=margin;
  const update=(range=6008,height=900)=>{camera.updateMatrixWorld();matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);current.setFromProjectionMatrix(matrix,camera.coordinateSystem,camera.reversedDepth);return cache.update(camera,current,range,height);};
  return{camera,current,cache,update};
}

test('ordinary visibility cache allows the measured 24 m translation window',()=>{
  assert.equal(new TemporalBeautyVolume().translationMargin,24);
});

for(const margin of [8,24])for(const reversed of [false,true])test(`visibility reuse proves full camera coverage (${margin} m, reversed ${reversed})`,()=>{
  const {camera,cache,update}=fixture(reversed,margin);assert.equal(update(),true);
  const revision=cache.revision;camera.position.x+=margin-1;assert.equal(update(),false);assert.equal(cache.revision,revision);
  camera.position.x+=2;assert.equal(update(),true,'Crossing the translation window immediately rebuilds selection');
  camera.rotateY(.0005);assert.equal(update(),false,'A covered small rotation can reuse the selection');
  camera.rotateY(.4);assert.equal(update(),true,'A sharp turn immediately rebuilds the selection');
  camera.position.x+=100;assert.equal(update(),true,'A teleport immediately rebuilds the selection');
  assert.equal(update(6100),true,'An expanded range cannot reuse the old sphere');
  assert.equal(update(6100,1080),true,'Screen-height changes must refresh the LOD policy');
  camera.fov=25;camera.updateProjectionMatrix();assert.equal(update(6100,1080),true,'Zoomed detail cannot use a looser pixel budget');
});

for(const reversed of [false,true])test(`the padded frustum boundary overrides the translation allowance (reversed ${reversed})`,()=>{
  const {camera,cache,update}=fixture(reversed);assert.equal(update(),true);
  camera.position.z=-23;assert.equal(update(),false,'Movement inside the padded far plane stays covered');
  const revision=cache.revision;camera.position.z=-24;
  assert.equal(update(),true,'A current corner touching the cached far plane refreshes before escaping coverage');
  assert.equal(cache.revision,revision+1);
});

for(const margin of [8,24])test(`guarded detail remains conservative throughout the ${margin} m camera translation`,()=>{
  const geometry=new THREE.BoxGeometry(2,2,2);geometry.clearGroups();geometry.userData.sourceSha256='test';geometry.computeBoundingBox();
  const error=.05,index=new Uint32Array([0,1,2]);registerDistanceDetailGeometry(geometry,1,{binary:index.buffer,definitions:new Map([[1,{sourceSha256:'test',levels:[{level:1,errorAbsolute:error,index:{arrayType:'Uint32Array',byteOffset:0,bytes:12,count:3}}]}]])});
  const source=new THREE.InstancedMesh(geometry,new THREE.MeshBasicMaterial(),1);source.setMatrixAt(0,new THREE.Matrix4());source.updateMatrixWorld();
  const {camera,cache,update}=fixture(false,margin);camera.position.set(0,0,100);update();
  const controller=new DistanceDetailController(camera,2,35);controller.beginFrame(900);controller.setSelectionView(cache.origin,cache.pixelsPerRadian,cache.translationMargin);
  const selected=controller.geometryForPass({source,worldBox:geometry.boundingBox},0);
  assert.ok(selected);
  for(const shift of [-margin,0,margin]){const distance=99+shift;assert.ok(error*(900/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))))/distance<=2);}
  camera.position.z=controller.nearDistance+margin+.5;assert.equal(update(),true);controller.beginFrame(900);
  assert.ok(controller.geometryForPass({source,worldBox:geometry.boundingBox},0),'Without the guard this anchor could use reduced detail');
  controller.setSelectionView(cache.origin,cache.pixelsPerRadian,cache.translationMargin);
  assert.equal(controller.geometryForPass({source,worldBox:geometry.boundingBox},0),undefined,'Guard retains full geometry before entering the original-detail radius');
  camera.position.z-=margin-.25;assert.equal(update(),false,'The camera can enter the near-detail radius while reusing visibility');
  controller.beginFrame(900);controller.setSelectionView(cache.origin,cache.pixelsPerRadian,cache.translationMargin);
  assert.equal(controller.geometryForPass({source,worldBox:geometry.boundingBox},0),undefined,'Cached selection still preserves original geometry inside the near radius');
  geometry.dispose();source.material.dispose();source.dispose();
});
