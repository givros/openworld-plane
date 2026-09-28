import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShadowCasterVolume,ShadowReceiverBounds } from '../src/systems/ShadowCasterVolume.ts';
import { registerStreamGeometryBounds } from '../src/world/StreamGeometryBounds.ts';

test('new streamed receivers reuse exact packed bounds while mutations still rescan',()=>{
 const scene=new THREE.Scene(),geometry=new THREE.BoxGeometry(4,8,6),material=new THREE.MeshStandardMaterial();
 geometry.computeBoundingBox();geometry.computeBoundingSphere();registerStreamGeometryBounds(geometry);
 const mesh=new THREE.Mesh(geometry,material);mesh.receiveShadow=true;scene.add(mesh);scene.updateMatrixWorld(true);
 const bounds=new ShadowReceiverBounds(),original=geometry.computeBoundingBox;let scans=0;
 geometry.computeBoundingBox=function(){scans++;return original.call(this);};
 try{
  assert.deepEqual(bounds.update(scene).min.toArray(),[-4,-6,-5]);assert.equal(scans,0);
  const positions=geometry.attributes.position;
  for(let i=0;i<positions.count;i++)positions.setX(i,positions.getX(i)*5);
  positions.needsUpdate=true;
  assert.equal(bounds.update(scene).max.x,12);assert.equal(scans,1);
 }finally{geometry.dispose();material.dispose();}
});

test('all sampled upstream off-screen casters remain eligible for visible receivers',()=>{
 const volume=new ShadowCasterVolume(),camera=new THREE.PerspectiveCamera(48,1.6,.15,16000);
 const direction=new THREE.Vector3(.48,-.58,.65).normalize(),bounds=new THREE.Box3(new THREE.Vector3(-800,-50,-800),new THREE.Vector3(2400,800,2400));
 const caster=new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.MeshBasicMaterial());
 let checked=0,offscreen=0;
 for(const yaw of [0,.7,1.5,2.5])for(const pitch of [-.2,-.7]){
  camera.position.set(150,220,150);camera.rotation.set(pitch,yaw,0,'YXZ');camera.updateMatrixWorld();
  const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  for(const [near,far] of [[.15,110],[95,490],[400,1800],[1600,6700]]){
   volume.update(camera,near,far,bounds,direction,15000,2);
   for(const depth of [near+(far-near)*.1,near+(far-near)*.5,near+(far-near)*.9])for(const x of [-.8,0,.8])for(const y of [-.8,0,.8]){
    const receiver=new THREE.Vector3(x*depth*Math.tan(24*Math.PI/180)*1.6,y*depth*Math.tan(24*Math.PI/180),-depth).applyMatrix4(camera.matrixWorld);
    if(!bounds.containsPoint(receiver))continue;
    for(const distance of [0,50,500,2500,10000]){
     caster.position.copy(receiver).addScaledVector(direction,-distance);caster.updateMatrixWorld();
     assert.equal(volume.intersectsObject(caster),true,`Lost upstream caster at ${caster.position.toArray()} for ${receiver.toArray()}`);
     if(!frustum.intersectsObject(caster))offscreen++;checked++;
    }
   }
  }
 }
 assert.ok(checked>1000);assert.ok(offscreen>500);
 caster.geometry.dispose();caster.material.dispose();
});

test('empty distant receiver volume rejects irrelevant casters and follows a moved camera',()=>{
 const volume=new ShadowCasterVolume(),camera=new THREE.PerspectiveCamera(48,1.6,.15,16000);
 camera.position.set(0,100,0);camera.lookAt(0,0,-100);camera.updateMatrixWorld();
 const bounds=new THREE.Box3(new THREE.Vector3(-800,-10,-800),new THREE.Vector3(800,30,800));
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(10,10,10),new THREE.MeshBasicMaterial());mesh.position.set(0,5,-100);mesh.updateMatrixWorld();
 const direction=new THREE.Vector3(.48,-.58,.65).normalize();
 volume.update(camera,1700,6000,bounds,direction,15000,2);assert.equal(volume.intersectsObject(mesh),false);
 volume.update(camera,20,450,bounds,direction,15000,2);assert.equal(volume.intersectsObject(mesh),true);
 camera.position.set(4000,100,0);camera.lookAt(4000,0,-100);camera.updateMatrixWorld();
 volume.update(camera,20,450,bounds,direction,15000,2);assert.equal(volume.intersectsObject(mesh),false);
 mesh.geometry.dispose();mesh.material.dispose();
});

test('reversed depth preserves the same receiver extrusion and caster eligibility',()=>{
 const normal=new THREE.PerspectiveCamera(48,1.6,.15,16000),reversed=new THREE.PerspectiveCamera();
 normal.position.set(150,220,150);normal.rotation.set(-.45,.7,0,'YXZ');normal.updateMatrixWorld();
 reversed.copy(normal);reversed._reversedDepth=true;reversed.updateProjectionMatrix();
 const conventionalVolume=new ShadowCasterVolume(),reversedVolume=new ShadowCasterVolume();
 const bounds=new THREE.Box3(new THREE.Vector3(-800,-50,-800),new THREE.Vector3(2400,800,2400));
 const direction=new THREE.Vector3(.48,-.58,.65).normalize();
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(4,9,6),new THREE.MeshBasicMaterial());
 let included=0,excluded=0;
 try{
  for(const [near,far] of [[.15,110],[95,490],[400,1800],[1600,6700]]){
   conventionalVolume.update(normal,near,far,bounds,direction,15000,2);
   reversedVolume.update(reversed,near,far,bounds,direction,15000,2);
   for(let x=-1800;x<2400;x+=350)for(let y=-20;y<2500;y+=420)for(let z=-1800;z<2400;z+=350){
    mesh.position.set(x,y,z);mesh.updateMatrixWorld();
    const eligible=conventionalVolume.intersectsObject(mesh);
    assert.equal(reversedVolume.intersectsObject(mesh),eligible,`Depth convention changed caster eligibility at ${[x,y,z]}`);
    if(eligible)included++;else excluded++;
   }
  }
  assert.ok(included>10,`Expected covered casters, found ${included}`);assert.ok(excluded>100);
 }finally{mesh.geometry.dispose();mesh.material.dispose();}
});

test('receiver bounds respond to transformed instances and edited or replaced source buffers',()=>{
 const scene=new THREE.Scene(),bounds=new ShadowReceiverBounds(),geometry=new THREE.BoxGeometry(2,2,2);
 const mesh=new THREE.InstancedMesh(geometry,new THREE.MeshStandardMaterial(),2);mesh.receiveShadow=true;
 mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(0,0,0));mesh.setMatrixAt(1,new THREE.Matrix4().makeTranslation(20,0,0));scene.add(mesh);scene.updateMatrixWorld(true);
 assert.ok(bounds.update(scene).max.x>=21);
 mesh.setMatrixAt(1,new THREE.Matrix4().makeTranslation(60,0,0));mesh.instanceMatrix.needsUpdate=true;
 assert.ok(bounds.update(scene).max.x>=61);
 const positions=geometry.getAttribute('position');for(let i=0;i<positions.count;i++)positions.setX(i,positions.getX(i)*10);positions.needsUpdate=true;
 assert.ok(bounds.update(scene).max.x>=70);
 const replaced=positions.clone();for(let i=0;i<replaced.count;i++)replaced.setX(i,replaced.getX(i)*2);geometry.setAttribute('position',replaced);
 assert.ok(bounds.update(scene).max.x>=80);
 mesh.position.x=100;scene.updateMatrixWorld(true);assert.ok(bounds.update(scene).max.x>=180);
 geometry.dispose();mesh.material.dispose();mesh.dispose();
});
