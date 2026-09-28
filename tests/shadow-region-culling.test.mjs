import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller,isPassInstanceProxy } from '../src/world/PassInstanceCuller.ts';

function box(min=-100,max=100){return new THREE.Frustum(
 new THREE.Plane(new THREE.Vector3(1,0,0),-min),new THREE.Plane(new THREE.Vector3(-1,0,0),max),
 new THREE.Plane(new THREE.Vector3(0,1,0),100),new THREE.Plane(new THREE.Vector3(0,-1,0),100),
 new THREE.Plane(new THREE.Vector3(0,0,1),100),new THREE.Plane(new THREE.Vector3(0,0,-1),100));}
function fixture(shadows=1){
 const scene=new THREE.Scene(),parent=new THREE.Group(),geometry=new THREE.BoxGeometry(2,2,2),material=new THREE.MeshStandardMaterial();
 const source=new THREE.InstancedMesh(geometry,material,4);source.castShadow=true;source.position.x=10;source.renderOrder=7;
 [-30,0,30,60].forEach((x,i)=>{source.setMatrixAt(i,new THREE.Matrix4().makeTranslation(x,0,0));source.setColorAt(i,new THREE.Color().setRGB(i/4,.3,.8));});
 source.instanceMatrix.needsUpdate=true;source.instanceColor.needsUpdate=true;
 parent.add(source);scene.add(parent);scene.updateMatrixWorld(true);
 const culler=new PassInstanceCuller([source],shadows);scene.add(culler.beautyGroup,...culler.shadowGroups);
 const lights=Array.from({length:shadows},()=>new THREE.DirectionalLight()),passes=lights.map(light=>({light,frustum:box(0,50)}));
 culler.prepare(box(),passes);culler.enable();
 const ids=proxy=>Array.from({length:proxy.count},(_,i)=>culler.resolveProxyInstance(proxy,i).instanceId);
 return {scene,parent,geometry,material,source,culler,passes,lights,ids,
  full:()=>culler.shadowGroups[0].children.find(child=>!child.userData.shadowRegionProxy),
  region:()=>culler.shadowGroups[0].children.find(child=>child.userData.shadowRegionProxy),
  prepare:()=>{scene.updateMatrixWorld(true);culler.prepare(box(),passes);},
  close:()=>{culler.dispose();source.dispose();geometry.dispose();material.dispose();}};
}

test('regions filter only prepared canonical IDs with independent exact draw buffers',()=>{
 const f=fixture(),full=f.full(),sourceMatrices=f.source.instanceMatrix.array.slice(),fullMatrices=full.instanceMatrix.array.slice();
 const fullColors=full.instanceColor.array.slice(),version=full.instanceMatrix.version;
 try{
  assert.deepEqual(f.ids(full),[1,2]);
  let region;
  const result=f.culler.withShadowRegion(0,box(39,39),()=>{
   region=f.region();assert.equal(full.visible,false);assert.equal(region.visible,true);
   assert.deepEqual(f.ids(region),[2],'AABB contact retains the full crossing instance');
   assert.equal(isPassInstanceProxy(region),true);assert.equal(region.geometry,full.geometry);
   assert.equal(region.customDepthMaterial,full.customDepthMaterial);assert.equal(region.material,full.material);
   assert.equal(region.renderOrder,full.renderOrder);assert.deepEqual(region.matrixWorld.elements,full.matrixWorld.elements);
   assert.notEqual(region.instanceMatrix,full.instanceMatrix);assert.notEqual(region.instanceColor,full.instanceColor);
   assert.deepEqual(region.instanceMatrix.array.slice(0,16),sourceMatrices.slice(32,48));
   assert.deepEqual(region.instanceColor.array.slice(0,3),f.source.instanceColor.array.slice(6,9));
   return 17;
  });
  assert.equal(result,17);assert.equal(region.visible,false);assert.equal(full.visible,true);
  const regionVersion=region.instanceMatrix.version;
  f.culler.withShadowRegion(0,box(-100,100),()=>{assert.equal(f.region(),region);assert.deepEqual(f.ids(region),[1,2],'Region cannot add an instance excluded from the prepared full pass');});
  assert.ok(region.instanceMatrix.version>regionVersion);
  assert.equal(full.instanceMatrix.version,version);assert.deepEqual(full.instanceMatrix.array,fullMatrices);
  assert.deepEqual(full.instanceColor.array,fullColors);assert.deepEqual(f.source.instanceMatrix.array,sourceMatrices);
  assert.deepEqual(f.ids(full),[1,2]);
  f.prepare();assert.equal(full.instanceMatrix.version,version,'A region does not invalidate the cached full-pass upload');
 }finally{f.close();}
});

test('region failure restores visibility and residency cannot mutate during callbacks',()=>{
 const f=fixture(),full=f.full();
 try{
  assert.throws(()=>f.culler.withShadowRegion(0,box(0,15),()=>{throw new Error('strip failed');}),/strip failed/);
  assert.equal(full.visible,true);assert.equal(f.region().visible,false);
  let callbacks=0;
  f.culler.withShadowRegion(0,box(900,1000),()=>{
   callbacks++;assert.equal(full.visible,false);assert.equal(f.region().visible,false);
   assert.throws(()=>f.culler.withShadowRegion(0,box(),()=>{}),/Nested/);
   assert.throws(()=>f.culler.removeSources([f.source]),/shadow dispatch/);
   assert.throws(()=>f.prepare(),/dispatching shadows/);
  });
  assert.equal(callbacks,1);assert.equal(full.visible,true);
  assert.throws(()=>f.culler.withShadowRegion(0,box(),()=>Promise.resolve()),/synchronous/);
  assert.equal(full.visible,true);assert.equal(f.region().visible,false);
 }finally{f.close();}
});

test('region helpers release GPU owners with removed sources and keep canonical resources owned by world',()=>{
 const f=fixture();let regionDisposed=0,geometryDisposed=0;
 try{
  f.geometry.addEventListener('dispose',()=>geometryDisposed++);
  f.culler.withShadowRegion(0,box(),()=>{});const region=f.region();region.addEventListener('dispose',()=>regionDisposed++);
  f.culler.removeSources([f.source]);
  assert.equal(regionDisposed,1);assert.equal(region.parent,null);assert.equal(geometryDisposed,0);
  assert.equal(f.culler.resolveProxyInstance(region,0),undefined);
 }finally{f.close();}
});

test('optional dispatcher can issue multiple native strips or skip a cached pass',()=>{
 const f=fixture(2),state={enabled:true,autoUpdate:false,needsUpdate:true,type:THREE.PCFShadowMap};
 let nativeCalls=0,saved;
 try{
  f.culler.shadowPassDispatcher=(index,light,group,drawNative)=>{
   assert.equal(group,f.culler.shadowGroups[index]);assert.equal(light,f.lights[index]);assert.equal(group.visible,true);
   assert.equal(f.culler.shadowGroups[1-index].visible,false);
   saved=drawNative;
   if(index===0){f.culler.withShadowRegion(0,box(0,15),drawNative);f.culler.withShadowRegion(0,box(35,45),drawNative);}
  };
  f.culler.renderShadowPasses((lights)=>{nativeCalls++;assert.equal(lights[0],f.lights[0]);assert.equal(state.needsUpdate,true);state.needsUpdate=false;},state,f.lights,f.scene,new THREE.PerspectiveCamera());
  assert.equal(nativeCalls,2);assert.equal(f.culler.shadowGroups.every(group=>!group.visible),true);
  assert.equal(f.full().visible,true);assert.equal(f.region().visible,false);
  assert.throws(()=>saved(),/outlive/);
 }finally{f.close();}
});

test('shadow content revision observes edits without changing on camera-only prepares',()=>{
 const f=fixture(),texture=new THREE.Texture();
 try{
  f.culler.trackShadowContent=true;f.prepare();let revision=f.culler.contentRevision;
  const changed=edit=>{edit();f.prepare();assert.ok(f.culler.contentRevision>revision);revision=f.culler.contentRevision;f.prepare();assert.equal(f.culler.contentRevision,revision);};
  f.passes[0].frustum=box(-40,80);f.prepare();assert.equal(f.culler.contentRevision,revision);
  changed(()=>{f.source.castShadow=false;});changed(()=>{f.source.castShadow=true;});
  changed(()=>{f.parent.visible=false;});changed(()=>{f.parent.visible=true;});
  changed(()=>{f.material.side=THREE.DoubleSide;});changed(()=>{f.material.opacity=.9;});
  changed(()=>{f.material.needsUpdate=true;});changed(()=>{f.material.map=texture;});
  changed(()=>{texture.offset.x=.1;});changed(()=>{texture.needsUpdate=true;});
  changed(()=>{f.geometry.index.needsUpdate=true;});changed(()=>{f.geometry.attributes.uv.needsUpdate=true;});
  changed(()=>{f.geometry.groups[0].count-=3;});
  changed(()=>{f.source.setMatrixAt(1,new THREE.Matrix4().makeTranslation(2,0,0));f.source.instanceMatrix.needsUpdate=true;});
  f.culler.removeSources([f.source]);assert.ok(f.culler.contentRevision>revision);
 }finally{texture.dispose();f.close();}
});

test('shadow journal retains asynchronous residency changes and ignores invisible preloads',()=>{
 const f=fixture(),chunk=new THREE.Group(),extra=new THREE.InstancedMesh(f.geometry,f.material,1);
 extra.castShadow=true;extra.position.x=600;extra.setMatrixAt(0,new THREE.Matrix4());chunk.add(extra);chunk.visible=false;f.scene.add(chunk);
 try{
  f.culler.trackShadowContent=true;f.prepare();f.prepare();let previous=f.culler.shadowChanges.revision;
  f.culler.addSources([extra]);f.prepare();
  let changes=f.culler.shadowChanges;assert.equal(changes.fromRevision,previous);assert.ok(changes.revision>previous);
  assert.equal(changes.full,false);assert.equal(changes.bounds.length,0,'A hidden preload has never contributed to the cache');previous=changes.revision;
  extra.position.x=750;f.prepare();changes=f.culler.shadowChanges;
  assert.equal(changes.fromRevision,previous);assert.equal(changes.bounds.length,0);previous=changes.revision;
  chunk.visible=true;f.prepare();changes=f.culler.shadowChanges;
  assert.equal(changes.fromRevision,previous);assert.equal(changes.full,false);
  assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(750,0,0))));previous=changes.revision;
  // Chunk owners commonly hide/detach first, then unregister between prepares.
  chunk.visible=false;f.culler.removeSources([extra]);f.prepare();changes=f.culler.shadowChanges;
  assert.equal(changes.fromRevision,previous);assert.equal(changes.full,false);
  assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(750,0,0))),'Removal clears the previously visible footprint');
  const saved=changes.bounds.map(bounds=>bounds.clone());f.prepare();
  assert.equal(f.culler.shadowChanges.bounds.length,0);assert.deepEqual(changes.bounds,saved,'Published batches remain unchanged for a second cached light');
 }finally{f.culler.removeSources([extra]);extra.dispose();f.close();}
});

test('shadow journal covers old and new transforms plus parent visibility transitions',()=>{
 const f=fixture();
 try{
  f.culler.trackShadowContent=true;f.prepare();f.prepare();
  f.source.position.x=500;f.prepare();let changes=f.culler.shadowChanges;
  assert.equal(changes.full,false);
  assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(10,0,0))));
  assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(500,0,0))));
  f.parent.visible=false;f.prepare();changes=f.culler.shadowChanges;
  assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(500,0,0))));
  f.source.position.x=1200;f.material.side=THREE.DoubleSide;f.prepare();
  assert.equal(f.culler.shadowChanges.full,false);assert.equal(f.culler.shadowChanges.bounds.length,0);
  f.parent.visible=true;f.prepare();changes=f.culler.shadowChanges;
  assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(1200,0,0))));
 }finally{f.close();}
});

test('shared geometry and material edits invalidate every visible affected cell',()=>{
 const f=fixture(),extra=new THREE.InstancedMesh(f.geometry,f.material,1);
 extra.castShadow=true;extra.position.x=600;extra.setMatrixAt(0,new THREE.Matrix4());f.scene.add(extra);
 try{
  f.culler.trackShadowContent=true;f.culler.addSources([extra]);f.prepare();f.prepare();
  for(const edit of [()=>{f.material.shadowSide=THREE.DoubleSide;},()=>{f.geometry.index.needsUpdate=true;},()=>{f.geometry.attributes.uv.needsUpdate=true;}]){
   edit();f.prepare();const changes=f.culler.shadowChanges;
   assert.equal(changes.full,false);assert.equal(changes.bounds.length,2,'Changes are coalesced by cell rather than globally');
   assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(10,0,0))));
   assert.ok(changes.bounds.some(bounds=>bounds.containsPoint(new THREE.Vector3(600,0,0))));
   f.prepare();assert.equal(f.culler.shadowChanges.bounds.length,0);
  }
 }finally{f.culler.removeSources([extra]);extra.dispose();f.close();}
});
