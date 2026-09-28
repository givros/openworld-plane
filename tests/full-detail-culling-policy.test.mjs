import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {FullDetailWorldCulling} from '../src/core/FullDetailWorldCulling.ts';

function fixture(){
 const scene=new THREE.Scene(),world=new THREE.Group();scene.add(world);
 const geometry=new THREE.BoxGeometry(1,1,1),material=new THREE.MeshStandardMaterial();
 const sources=[0,20,40].map((x,index)=>{
  const source=new THREE.InstancedMesh(geometry,material,2);
  source.name=`Static complete batch ${index}`;source.position.x=x;
  source.castShadow=source.receiveShadow=true;source.layers.mask=1|(1<<(index+4));
  source.userData.sourceObjects=[{name:`${index}/left`},{name:`${index}/right`}];
  for(let slot=0;slot<2;slot++){
   source.setMatrixAt(slot,new THREE.Matrix4().makeTranslation(slot?0.75:-0.75,0,0));
   source.setColorAt(slot,new THREE.Color(slot?0x445566:0xaabbcc));
  }
  source.instanceMatrix.needsUpdate=true;source.instanceColor.needsUpdate=true;
  source.updateMatrix();source.matrixAutoUpdate=false;world.add(source);return source;
 });
 // An ordinary mesh remains on the canonical path regardless of the policy.
 const ordinary=new THREE.Mesh(geometry,material);ordinary.position.set(10,-3,0);world.add(ordinary);
 const camera=new THREE.PerspectiveCamera(10,1,0.1,120);
 const lights=Array.from({length:4},(_,index)=>{
  const light=new THREE.DirectionalLight();light.position.set(index*5,30,40);light.target.position.set(20,0,0);light.castShadow=true;
  Object.assign(light.shadow.camera,{left:-100,right:100,top:100,bottom:-100,near:0.1,far:300});
  light.shadow.camera.updateProjectionMatrix();scene.add(light,light.target);return light;
 });
 const shadowPasses=()=>lights.map(light=>{
  light.shadow.updateMatrices(light);
  const projection=new THREE.Matrix4().multiplyMatrices(light.shadow.camera.projectionMatrix,light.shadow.camera.matrixWorldInverse);
  return{light,frustum:new THREE.Frustum().setFromProjectionMatrix(projection)};
 });
 scene.updateMatrixWorld(true);
 const saved=sources.map(source=>({source,layer:source.layers.mask,count:source.count,geometry:source.geometry,material:source.material,
  metadata:structuredClone(source.userData),matrix:source.matrix.clone(),worldMatrix:source.matrixWorld.clone(),
  instanceAttribute:source.instanceMatrix,matrices:source.instanceMatrix.array.slice(),matrixVersion:source.instanceMatrix.version,
  colorAttribute:source.instanceColor,colors:source.instanceColor.array.slice(),colorVersion:source.instanceColor.version}));
 const savedIndex=geometry.index.array.slice(),savedAttributes=Object.fromEntries(Object.entries(geometry.attributes).map(([key,value])=>[key,{attribute:value,values:value.array.slice(),version:value.version}]));
 const adapter=new FullDetailWorldCulling(world,scene,camera,shadowPasses,()=>true,1,{enterTriangles:72,exitTriangles:48});
 const pose=(name)=>{
  const [x,fov]=name==='low'?[0,10]:name==='middle'?[10,35]:[20,65];
  camera.position.set(x,0,40);camera.lookAt(x,0,0);camera.fov=fov;camera.updateProjectionMatrix();
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);adapter.prepare();
 };
 const assertSourceIntact=()=>{
  assert.deepEqual(geometry.index.array,savedIndex);
  for(const [key,row]of Object.entries(savedAttributes)){
   assert.equal(geometry.attributes[key],row.attribute);assert.equal(row.attribute.version,row.version);assert.deepEqual(row.attribute.array,row.values);
  }
  for(const row of saved){
   const source=row.source;
   assert.equal(source.geometry,row.geometry);assert.equal(source.material,row.material);assert.equal(source.count,row.count);
   assert.equal(source.parent,world);assert.equal(source.visible,true);assert.deepEqual(source.userData,row.metadata);
   assert.equal(source.matrix.equals(row.matrix),true);assert.equal(source.matrixWorld.equals(row.worldMatrix),true);
   assert.equal(source.instanceMatrix,row.instanceAttribute);assert.equal(source.instanceMatrix.version,row.matrixVersion);assert.deepEqual(source.instanceMatrix.array,row.matrices);
   assert.equal(source.instanceColor,row.colorAttribute);assert.equal(source.instanceColor.version,row.colorVersion);assert.deepEqual(source.instanceColor.array,row.colors);
  }
  assert.equal(ordinary.geometry,geometry);assert.equal(ordinary.material,material);assert.equal(ordinary.layers.mask,1);assert.equal(ordinary.visible,true);
 };
 const assertPath=(enabled,estimate)=>{
  assert.equal(adapter.culler.enabled,enabled);assert.equal(adapter.diagnostics.renderPath,enabled?'instance-culling':'canonical');
  assert.equal(adapter.diagnostics.estimatedBeautyTriangles,estimate);assert.equal(adapter.diagnostics.geometryReduction,false);
  assert.equal(adapter.culler.beautyGroup.visible,enabled);
  for(const group of adapter.culler.shadowGroups)assert.equal(group.visible,false,'shadow groups are hidden outside their native pass');
  for(const row of saved)assert.equal(row.source.layers.mask,enabled?0:row.layer);
  assertSourceIntact();
 };
 const close=()=>{adapter.dispose();sources.forEach(source=>source.dispose());geometry.dispose();material.dispose();};
 return{scene,world,geometry,material,sources,camera,lights,adapter,saved,pose,assertSourceIntact,assertPath,close};
}

test('automatic low-high-low path changes preserve complete source geometry, matrices, counts and layers',()=>{
 const f=fixture();try{
  f.pose('low');f.assertPath(false,24);
  f.pose('high');f.assertPath(true,72);
  assert.equal(f.adapter.culler.shadowGroups.length,4);
  for(const group of [f.adapter.culler.beautyGroup,...f.adapter.culler.shadowGroups]){
   let proxies=0;
   group.traverse(proxy=>{
    if(!proxy.isInstancedMesh)return;proxies++;
    assert.equal(proxy.geometry,f.geometry);assert.equal(proxy.material,f.material);assert.equal(proxy.visible,true);assert.equal(proxy.count,2);
    for(let slot=0;slot<proxy.count;slot++){
     const match=f.adapter.culler.resolveProxyInstance(proxy,slot);assert.ok(match);
     assert.equal(proxy.matrixWorld.equals(match.source.matrixWorld),true);
     assert.deepEqual(proxy.instanceMatrix.array.slice(slot*16,slot*16+16),match.source.instanceMatrix.array.slice(match.instanceId*16,match.instanceId*16+16));
     assert.deepEqual(proxy.instanceColor.array.slice(slot*3,slot*3+3),match.source.instanceColor.array.slice(match.instanceId*3,match.instanceId*3+3));
    }
   });
   assert.equal(proxies,3);
  }
  f.pose('low');f.assertPath(false,24);
  f.adapter.dispose();f.assertSourceIntact();
  for(const row of f.saved)assert.equal(row.source.layers.mask,row.layer);
  assert.equal(f.adapter.culler.beautyGroup.parent,null);
  for(const group of f.adapter.culler.shadowGroups)assert.equal(group.parent,null);
 }finally{f.close();}
});

test('automatic workload hysteresis enters at the upper boundary and exits only below the lower boundary',()=>{
 const f=fixture();try{
  f.pose('low');f.assertPath(false,24);
  f.pose('middle');f.assertPath(false,48);
  f.pose('high');f.assertPath(true,72);
  for(let i=0;i<3;i++){f.pose('middle');f.assertPath(true,48);}
  f.pose('low');f.assertPath(false,24);
  f.pose('middle');f.assertPath(false,48);
  f.pose('high');f.assertPath(true,72);
 }finally{f.close();}
});

test('manual A/B ownership preserves explicit enable and disable after an automatic canonical frame',()=>{
 const f=fixture();try{
  f.pose('low');f.assertPath(false,24);
  f.adapter.automaticSelection=false;
  f.pose('low');f.assertPath(false,null);
  f.adapter.culler.enable();f.assertPath(true,null);
  f.pose('low');f.assertPath(true,null);
  f.adapter.culler.disable();f.pose('high');f.assertPath(false,null);
  f.adapter.culler.enable();f.pose('high');f.assertPath(true,null);
  f.adapter.automaticSelection=true;f.pose('low');f.assertPath(false,24);
  f.pose('high');f.assertPath(true,72);
 }finally{f.close();}
});

test('manual selection before initial preparation enables the complete culling path even below the automatic threshold',()=>{
 const f=fixture();try{
  f.adapter.automaticSelection=false;f.pose('low');f.assertPath(true,null);
  const visible=[];f.adapter.culler.beautyGroup.traverse(object=>{if(object.isInstancedMesh&&object.visible)visible.push(object);});
  assert.equal(visible.length,1);assert.equal(visible[0].count,2);
  f.adapter.culler.disable();f.pose('low');f.assertPath(false,null);
  f.adapter.automaticSelection=true;f.pose('middle');f.assertPath(false,48);
 }finally{f.close();}
});

test('finite range forces bounded rendering below adaptive thresholds and supports streamed residency',()=>{
 const f=fixture();
 const newcomer=new THREE.InstancedMesh(f.geometry,f.material,1);newcomer.name='New single-instance cell';
 newcomer.setMatrixAt(0,new THREE.Matrix4().makeTranslation(0,0,5));newcomer.instanceMatrix.needsUpdate=true;
 try{
  f.adapter.setViewDistance(50);f.pose('low');
  assert.equal(f.adapter.culler.enabled,true);assert.equal(f.adapter.diagnostics.viewDistance,50);
  assert.equal(f.adapter.diagnostics.estimatedBeautyTriangles,null);
  f.world.add(newcomer);f.scene.updateMatrixWorld(true);f.adapter.addSources([newcomer]);f.pose('low');
  assert.equal(f.adapter.culler.canonicalSources.length,4);
  assert.equal(newcomer.layers.mask,0);
  f.adapter.removeSources([newcomer]);newcomer.removeFromParent();
  assert.equal(newcomer.layers.mask,1);assert.equal(f.adapter.culler.canonicalSources.length,3);
  f.adapter.setViewDistance(10);f.pose('low');
  assert.equal(f.adapter.culler.statistics[0].selected,0);
  f.adapter.setViewDistance(Infinity);f.pose('low');f.assertPath(false,24);
  assert.throws(()=>f.adapter.setViewDistance(0),/positive/);
 }finally{newcomer.dispose();f.close();}
});
