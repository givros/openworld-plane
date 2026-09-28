import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {registerDistanceDetailGeometry,distanceDetailLevels,DistanceDetailController} from '../src/world/DistanceDetailGeometry.ts';

function fixture(){
  const geometry=new THREE.BoxGeometry(2,2,2);geometry.clearGroups();geometry.userData.sourceSha256='source';geometry.computeBoundingBox();geometry.computeBoundingSphere();
  const indices=new Uint32Array([0,1,2,3,4,5,6,7,8]);
  const pack={binary:indices.buffer,definitions:new Map([[1,{geometryId:1,sourceSha256:'source',levels:[1,2,3].map(level=>({level,errorAbsolute:level*.1,index:{byteOffset:(level-1)*12,bytes:12,count:3,arrayType:'Uint32Array'}}))}]])};
  registerDistanceDetailGeometry(geometry,1,pack);
  const source=new THREE.InstancedMesh(geometry,new THREE.MeshStandardMaterial(),1);source.setMatrixAt(0,new THREE.Matrix4());source.updateMatrixWorld();
  const descriptor={source,worldBox:geometry.boundingBox.clone()};
  const camera=new THREE.PerspectiveCamera(45,1.6,.15,6000),controller=new DistanceDetailController(camera,2,35);
  return{geometry,source,descriptor,camera,controller,pack};
}

test('distance variants share unchanged original vertex attributes and own only indices',()=>{
  const f=fixture(),original=f.geometry.index;
  for(const level of distanceDetailLevels(f.geometry)){
    assert.equal(level.geometry.getAttribute('position'),f.geometry.getAttribute('position'));
    assert.equal(level.geometry.getAttribute('normal'),f.geometry.getAttribute('normal'));
    assert.equal(level.geometry.getAttribute('uv'),f.geometry.getAttribute('uv'));
    assert.equal(level.geometry.boundingBox,f.geometry.boundingBox);
    assert.notEqual(level.geometry.index,original);
  }
  assert.equal(f.geometry.index,original);
  f.geometry.dispose();assert.equal(distanceDetailLevels(f.geometry).length,0);
});

test('near views retain original geometry and distant selection respects screen error and instance scale',()=>{
  const f=fixture();f.camera.position.set(0,0,20);f.controller.beginFrame(900);
  assert.equal(f.controller.geometryForPass(f.descriptor,0),undefined);
  f.camera.position.z=1000;f.controller.beginFrame(900);
  assert.equal(f.controller.geometryForPass(f.descriptor,0),distanceDetailLevels(f.geometry)[2].geometry);
  f.source.setMatrixAt(0,new THREE.Matrix4().makeScale(100,100,100));f.source.instanceMatrix.needsUpdate=true;
  assert.equal(f.controller.geometryForPass(f.descriptor,0),undefined,'Large transformed error must not use the tiny-object tier');
  f.geometry.dispose();
});

test('shadow tiers stay fixed as the view moves and keep the nearest cascade original',()=>{
  const f=fixture();f.controller.beginFrame(900);
  assert.equal(f.controller.geometryForPass(f.descriptor,1),undefined);
  for(const distance of [10,100,10000]){
    f.camera.position.z=distance;
    for(const pass of [2,3,4])assert.equal(f.controller.geometryForPass(f.descriptor,pass),distanceDetailLevels(f.geometry)[pass-2].geometry);
  }
  f.geometry.dispose();
});

test('invalid distance index ranges fail before a variant can be drawn',()=>{
  const f=fixture(),source=new THREE.BufferGeometry();source.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));source.userData.sourceSha256='source';
  assert.throws(()=>registerDistanceDetailGeometry(source,1,f.pack),/exceeds source vertices/);
  assert.equal(distanceDetailLevels(source).length,0);f.geometry.dispose();source.dispose();
});
