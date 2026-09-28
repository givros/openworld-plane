import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';
import { markImmutableStreamSource, isImmutableStreamSource, markStaticStreamSource, getStaticStreamSourceLease,
  getStaticStreamOwnershipRevision, invalidateStaticStreamSource, invalidateStaticStreamResources, releaseStaticStreamSource } from '../src/world/ImmutableStreamSources.ts';

function box(min=-10,max=10){
  return new THREE.Frustum(new THREE.Plane(new THREE.Vector3(1,0,0),-min),new THREE.Plane(new THREE.Vector3(-1,0,0),max),
    new THREE.Plane(new THREE.Vector3(0,1,0),20),new THREE.Plane(new THREE.Vector3(0,-1,0),20),
    new THREE.Plane(new THREE.Vector3(0,0,1),20),new THREE.Plane(new THREE.Vector3(0,0,-1),20));
}
function fixture({legacy=false,generation=true}={}){
  const scene=new THREE.Scene(),world=new THREE.Group(),anchor=new THREE.Group();scene.add(world);world.add(anchor);
  const geometry=new THREE.BoxGeometry(2,2,2),material=new THREE.MeshStandardMaterial(),sources=[];
  for(let i=0;i<2;i++){
    const source=new THREE.InstancedMesh(geometry,material,2);source.count=1;source.castShadow=true;
    source.setMatrixAt(0,new THREE.Matrix4().makeTranslation(i*3,0,0));source.instanceMatrix.needsUpdate=true;
    anchor.add(source);if(legacy)markImmutableStreamSource(source);markStaticStreamSource(source,anchor);sources.push(source);
  }
  scene.updateMatrixWorld(true);
  const culler=new PassInstanceCuller(sources,1,{getStaticSourceLease:getStaticStreamSourceLease,
    ...(generation?{getStaticSourceLeaseRevision:getStaticStreamOwnershipRevision}:{}),isImmutableSource:isImmutableStreamSource});
  culler.trackShadowContent=true;scene.add(culler.beautyGroup,...culler.shadowGroups);
  const passes=[{light:new THREE.DirectionalLight(),frustum:box()}];
  const prepare=(volume=box())=>{scene.updateMatrixWorld(true);culler.prepare(volume,passes);};
  prepare();culler.enable();
  return{scene,world,anchor,geometry,material,sources,culler,passes,prepare,
    close(){culler.dispose();for(const source of sources){releaseStaticStreamSource(source);source.dispose();}geometry.dispose();material.dispose();}};
}

test('stable strong leases bypass per-source audits with and without the legacy immutable flag',()=>{
  for(const legacy of [false,true]){
    const f=fixture({legacy});let callbackReads=0;
    for(const source of f.sources)Object.defineProperty(source,'onBeforeRender',{configurable:true,get(){callbackReads++;return THREE.Object3D.prototype.onBeforeRender;}});
    try{
      f.prepare();assert.deepEqual(f.culler.staticLeaseStatistics,{auditedSources:0,reusedSources:2,anchors:1,leaseLookupSources:0,selectionSourceVisits:2,skippedCellSources:0});assert.equal(callbackReads,0);
      assert.equal(f.culler.statistics[0].selected,2);
      f.culler.staticStreamLeasesEnabled=false;f.prepare();assert.equal(f.culler.staticLeaseStatistics.auditedSources,2);assert.equal(f.culler.staticLeaseStatistics.reusedSources,0);
      f.culler.staticStreamLeasesEnabled=true;f.prepare();assert.equal(f.culler.staticLeaseStatistics.auditedSources,2,'reenabling performs a full audit');
      callbackReads=0;f.prepare();assert.equal(callbackReads,0);assert.equal(f.culler.staticLeaseStatistics.reusedSources,2);
    }finally{f.close();}
  }
});

test('static beauty reuse skips per-proxy work while ordinary shadows keep their live exact volume',()=>{
  const f=fixture();let beautyCalls=0;
  try{
    f.culler.reuseStaticBeautySelection=true;
    f.culler.geometryForPass=(_,pass)=>{if(pass===0)beautyCalls++;};
    f.prepare();const revision=f.culler.getRenderPassRevision(0);
    assert.equal(typeof revision,'number');assert.equal(f.culler.getRenderPassRevision(1),undefined);
    const selected=f.culler.selectedPassProxies[0].slice(),versions=selected.map(p=>p.instanceMatrix.version);
    let writes=0;
    for(const proxy of selected){let count=proxy.count;Object.defineProperty(proxy,'count',{configurable:true,get:()=>count,set:value=>{writes++;count=value;}});}
    beautyCalls=0;f.passes[0].frustum=box(100,110);f.prepare();f.prepare();
    assert.equal(beautyCalls,0);assert.equal(writes,0,'Retained beauty proxies need no count/presentation writes');
    assert.equal(f.culler.getRenderPassRevision(0),revision);
    assert.deepEqual(f.culler.selectedPassProxies[0],selected);assert.deepEqual(selected.map(p=>p.instanceMatrix.version),versions);
    assert.equal(f.culler.statistics[0].selected,2);assert.equal(f.culler.statistics[1].selected,0);
    assert.ok(f.culler.states.every(state=>!state.drawsInactive&&!state.cell.drawsInactive),'Beauty-only cells stay active');
    f.passes[0].frustum=box();f.prepare();assert.equal(f.culler.statistics[1].selected,2);
    f.culler.withShadowRegion(0,box(),()=>assert.equal(f.culler.getRenderPassRevision(0),undefined));
    assert.equal(f.culler.getRenderPassRevision(0),revision);
  }finally{f.close();}
});

test('retained beauty visits only current shadow cells and clears departed shadow cells once',()=>{
  const f=fixture();
  try{
    invalidateStaticStreamSource(f.sources[1]);f.sources[1].setMatrixAt(0,new THREE.Matrix4().makeTranslation(300,0,0));f.sources[1].instanceMatrix.needsUpdate=true;
    f.culler.reuseStaticBeautySelection=true;
    const prepare=()=>f.prepare(box(-500,500));
    prepare();const beauty=f.culler.selectedPassProxies[0].slice(),revision=f.culler.getRenderPassRevision(0);
    prepare();assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,1);assert.equal(f.culler.staticLeaseStatistics.skippedCellSources,1);
    f.passes[0].frustum=box(290,310);prepare();
    assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,2,'The old shadow cell must be visited once to hide its proxies');
    assert.equal(f.culler.states[0].draws[1].proxy.visible,false);assert.equal(f.culler.states[1].draws[1].proxy.visible,true);
    assert.equal(f.culler.selectedPassProxies[1].length,1);prepare();assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,1);
    f.passes[0].frustum=box(990,1010);prepare();assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,1);
    assert.equal(f.culler.statistics[1].selected,0);prepare();assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,0);
    assert.deepEqual(f.culler.selectedPassProxies[0],beauty);assert.equal(f.culler.getRenderPassRevision(0),revision);
    assert.equal(f.culler.statistics[0].selected,2);assert.ok(f.culler.states.every(state=>!state.drawsInactive&&!state.cell.drawsInactive));
    invalidateStaticStreamSource(f.sources[0]);f.sources[0].setMatrixAt(0,new THREE.Matrix4().makeTranslation(1000,0,0));f.sources[0].instanceMatrix.needsUpdate=true;
    prepare();assert.ok(f.culler.getRenderPassRevision(0)>revision);assert.equal(f.culler.statistics[0].selected,1);assert.equal(f.culler.statistics[1].selected,1);
    f.culler.deferredShadowPasses=new Set([0]);prepare();prepare();assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,0);
    f.culler.withShadowRegion(0,box(990,1010),()=>{
      let selected=0;f.culler.shadowGroups[0].traverse(o=>{if(o.isInstancedMesh&&o.visible)selected+=o.count;});assert.equal(selected,1);
    });
    f.culler.deferredShadowPasses.clear();prepare();assert.equal(f.culler.statistics[1].selected,1,'A formerly deferred pass reactivates independently of cached beauty');
  }finally{f.close();}
});

test('beauty reuse invalidates representation, coarse mode, source resources, camera layers and membership',()=>{
  const f=fixture(),variant=new THREE.BoxGeometry(1,1,1),extra=new THREE.InstancedMesh(f.geometry,f.material,1);
  try{
    f.culler.reuseStaticBeautySelection=true;f.prepare();f.prepare();
    let revision=f.culler.getRenderPassRevision(0);
    const refreshed=()=>{f.prepare();const next=f.culler.getRenderPassRevision(0);assert.ok(next>revision);revision=next;f.prepare();assert.equal(f.culler.getRenderPassRevision(0),revision);};
    f.culler.geometryForPass=(_,pass)=>pass===0?variant:undefined;refreshed();
    assert.ok(f.culler.selectedPassProxies[0].every(p=>p.geometry===variant));
    f.culler.invalidateRenderGeometry();assert.equal(f.culler.getRenderPassRevision(0),undefined);refreshed();
    f.culler.coarseDetailSelection=true;refreshed();
    f.culler.coarseBeautySelection=false;refreshed();
    const shadowRevision=f.culler.contentRevision;
    f.culler.beautySelectionRevision++;assert.equal(f.culler.getRenderPassRevision(0),undefined);refreshed();
    assert.equal(f.culler.contentRevision,shadowRevision,'Beauty-only policy revisions do not invalidate cached static shadows');
    invalidateStaticStreamResources();f.material.roughness=.4;refreshed();
    f.anchor.position.x=.1;refreshed();
    invalidateStaticStreamSource(f.sources[0]);f.sources[0].renderOrder=4;refreshed();
    f.scene.updateMatrixWorld(true);f.culler.prepare(box(),f.passes,2);
    assert.ok(f.culler.getRenderPassRevision(0)>revision);revision=f.culler.getRenderPassRevision(0);
    refreshed();
    f.anchor.add(extra);extra.castShadow=true;markStaticStreamSource(extra,f.anchor);f.scene.updateMatrixWorld(true);f.culler.addSources([extra]);
    assert.equal(f.culler.getRenderPassRevision(0),undefined);refreshed();assert.equal(f.culler.statistics[0].selected,3);
    f.culler.removeSources([extra]);releaseStaticStreamSource(extra);extra.removeFromParent();refreshed();assert.equal(f.culler.statistics[0].selected,2);
    const before=f.culler.getRenderPassRevision(0);[...f.culler.preparationMeshes()];assert.equal(f.culler.getRenderPassRevision(0),undefined);
    f.prepare();assert.ok(f.culler.getRenderPassRevision(0)>before);
  }finally{releaseStaticStreamSource(extra);extra.dispose();variant.dispose();f.close();}
});

test('beauty guard includes exact frustum, distance origin and radius and preserves canonical instance IDs',()=>{
  const f=fixture();
  try{
    f.culler.reuseStaticBeautySelection=true;
    const prepare=(origin,distance,volume=box())=>f.culler.prepare(volume,f.passes,1,{origin:new THREE.Vector3(origin,0,0),distance});
    prepare(0,.1);let revision=f.culler.getRenderPassRevision(0);assert.equal(f.culler.statistics[0].selected,1);
    prepare(0,.1);assert.equal(f.culler.getRenderPassRevision(0),revision);
    prepare(3,.1);assert.ok(f.culler.getRenderPassRevision(0)>revision);revision=f.culler.getRenderPassRevision(0);
    assert.equal(f.culler.statistics[0].selected,1);
    assert.equal(f.culler.resolveProxyInstance(f.culler.selectedPassProxies[0][0],0).source,f.sources[1]);
    prepare(3,10);assert.ok(f.culler.getRenderPassRevision(0)>revision);revision=f.culler.getRenderPassRevision(0);assert.equal(f.culler.statistics[0].selected,2);
    prepare(3,10,box(30,40));assert.ok(f.culler.getRenderPassRevision(0)>revision);assert.equal(f.culler.statistics[0].selected,0);
    prepare(3,10);assert.equal(f.culler.statistics[0].selected,2);
  }finally{f.close();}
});

test('generic or revoked sources and failed partial preparation cannot use static beauty reuse',()=>{
  const f=fixture();let calls=0,fail=false;
  try{
    f.culler.reuseStaticBeautySelection=true;
    f.culler.geometryForPass=(_,pass)=>{if(pass===0){calls++;if(fail)throw new Error('representation failed');}};
    f.prepare();f.prepare();const before=f.culler.getRenderPassRevision(0);
    f.culler.invalidateRenderGeometry();fail=true;assert.throws(f.prepare,/representation failed/);assert.equal(f.culler.getRenderPassRevision(0),undefined);
    fail=false;calls=0;f.prepare();assert.equal(calls,2);assert.ok(f.culler.getRenderPassRevision(0)>before);
    releaseStaticStreamSource(f.sources[0]);calls=0;f.prepare();f.prepare();assert.equal(calls,4);assert.equal(f.culler.getRenderPassRevision(0),undefined);
    markStaticStreamSource(f.sources[0],f.anchor);f.prepare();f.prepare();assert.equal(typeof f.culler.getRenderPassRevision(0),'number');
    f.culler.staticStreamLeasesEnabled=false;calls=0;f.prepare();f.prepare();assert.equal(calls,4);assert.equal(f.culler.getRenderPassRevision(0),undefined);
    f.culler.staticStreamLeasesEnabled=true;f.culler.reuseStaticBeautySelection=false;f.prepare();assert.equal(f.culler.getRenderPassRevision(0),undefined);
  }finally{f.close();}
});

test('owned render proxy revisions retain stable bindings and cover resource, anchor and representation changes',()=>{
  const f=fixture(),variant=new THREE.BoxGeometry(1,1,1);
  const source=f.sources[0],proxy=f.culler.beautyGroup.children.find(item=>item.userData.canonicalSourceId===source.id);
  const read=()=>f.culler.getRenderProxyRevision(proxy);
  try{
    let revision=read();assert.equal(typeof revision,'number');f.prepare();assert.equal(read(),revision);
    f.prepare(box(-1,.5));assert.equal(read(),revision,'Selection-only changes do not alter resource bindings');
    invalidateStaticStreamSource(source);source.renderOrder=12;f.prepare();assert.ok(read()>revision);revision=read();
    f.anchor.position.x=.25;f.prepare();assert.ok(read()>revision);revision=read();
    invalidateStaticStreamResources();f.material.roughness=.2;f.prepare();assert.ok(read()>revision);revision=read();
    f.culler.geometryForPass=(_,pass)=>pass===0?variant:undefined;f.prepare();assert.ok(read()>revision);revision=read();
    f.culler.invalidateRenderGeometry();f.prepare();assert.ok(read()>revision);revision=read();
    f.prepare();assert.equal(read(),revision);
    releaseStaticStreamSource(source);f.prepare();assert.equal(read(),undefined,'Revoked sources return to generic validation');
    markStaticStreamSource(source,f.anchor);f.prepare();assert.equal(typeof read(),'number');
    f.culler.staticStreamLeasesEnabled=false;assert.equal(read(),undefined);
  }finally{f.close();variant.dispose();}
});

test('shadow proxy revision includes pass-specific depth bindings and removed helpers lose trust',()=>{
  const f=fixture();
  const source=f.sources[0],proxy=f.culler.shadowGroups[0].children.find(item=>item.userData.canonicalSourceId===source.id);
  try{
    const before=f.culler.getRenderProxyRevision(proxy);assert.equal(typeof before,'number');
    f.culler.orthographicDepthEnabled=false;f.prepare();assert.ok(f.culler.getRenderProxyRevision(proxy)>before);
    f.culler.withShadowRegion(0,box(),()=>{
      const region=f.culler.shadowGroups[0].children.find(item=>item.userData.shadowRegionProxy&&item.userData.canonicalSourceId===source.id);
      assert.equal(typeof f.culler.getRenderProxyRevision(region),'number');
    });
    f.culler.removeSources([source]);assert.equal(f.culler.getRenderProxyRevision(proxy),undefined);
    assert.equal(f.culler.getRenderProxyRevision(source),undefined,'Canonical sources are not renderer-owned proxies');
  }finally{f.close();}
});

test('sector ownership generation avoids existing-source lookup when fresh stream batches arrive',()=>{
  const f=fixture(),anchor=new THREE.Group(),source=new THREE.InstancedMesh(f.geometry,f.material,1);f.scene.add(anchor);
  try{
    f.prepare();const revision=getStaticStreamOwnershipRevision();
    anchor.add(source);source.castShadow=true;markStaticStreamSource(source,anchor);
    assert.equal(getStaticStreamOwnershipRevision(),revision,'unobserved pre-registration authoring does not invalidate existing renderers');
    f.scene.updateMatrixWorld(true);f.culler.addSources([source]);f.prepare();
    assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,0,'addSources registers only the new batch incrementally');
    assert.equal(f.culler.staticLeaseStatistics.auditedSources,1);assert.equal(f.culler.staticLeaseStatistics.reusedSources,2);
    assert.equal(f.culler.statistics[0].selected,3);
    releaseStaticStreamSource(f.sources[0]);f.prepare();assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,3);
    f.prepare();assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,0);assert.equal(f.culler.staticLeaseStatistics.auditedSources,1);
    markStaticStreamSource(f.sources[0],f.anchor);f.prepare();assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,3,'claiming an already observed dynamic source invalidates membership');
    f.prepare();assert.equal(f.culler.staticLeaseStatistics.auditedSources,0);assert.equal(f.culler.staticLeaseStatistics.reusedSources,3);
  }finally{releaseStaticStreamSource(source);f.culler.removeSources([source]);source.removeFromParent();source.dispose();f.close();}
});

test('owners without an ownership generation retain live source lookups and reparent fallback',()=>{
  const f=fixture({generation:false}),replacement=new THREE.Group();f.scene.add(replacement);
  try{
    f.prepare();assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,2);
    replacement.position.x=100;replacement.add(f.sources[0]);f.prepare();
    assert.equal(f.culler.statistics[0].selected,1);assert.equal(f.culler.staticLeaseStatistics.auditedSources,1);
    assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,2);
  }finally{f.close();}
});

test('dormant rejected cells skip every source visit while deferred shadow strips retain their casters',()=>{
  const f=fixture();
  try{
    f.culler.deferredShadowPasses=new Set([0]);f.passes[0].frustum=box(-200,200);f.world.position.x=100;f.prepare();f.prepare();
    assert.equal(f.culler.staticLeaseStatistics.leaseLookupSources,0);assert.equal(f.culler.staticLeaseStatistics.auditedSources,0);
    assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,0);assert.equal(f.culler.staticLeaseStatistics.skippedCellSources,2);
    f.culler.withShadowRegion(0,box(90,110),()=>{let selected=0;f.culler.shadowGroups[0].traverse(o=>{if(o.isInstancedMesh&&o.visible)selected+=o.count;});assert.equal(selected,2);});
    f.material.alphaTest=.3;invalidateStaticStreamResources();f.prepare();
    assert.equal(f.culler.staticLeaseStatistics.auditedSources,2);assert.ok(f.culler.shadowChanges.bounds.length);
    assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,0,'shadow invalidation is independent of dormant beauty processing');
    f.world.position.x=0;f.prepare();assert.equal(f.culler.statistics[0].selected,2);assert.equal(f.culler.staticLeaseStatistics.selectionSourceVisits,2);
  }finally{f.close();}
});

test('leased anchor transforms, ancestor visibility, membership and inherited order remain dynamic',()=>{
  const f=fixture(),replacement=new THREE.Group();f.scene.add(replacement);
  try{
    f.prepare();const revision=f.culler.shadowChanges.revision;
    f.world.position.x=100;f.prepare();assert.equal(f.culler.statistics[0].selected,0);assert.equal(f.culler.staticLeaseStatistics.auditedSources,2);
    assert.ok(f.culler.shadowChanges.revision>revision);assert.ok(f.culler.shadowChanges.bounds.some(b=>b.containsPoint(new THREE.Vector3(0,0,0))));
    f.prepare();assert.equal(f.culler.staticLeaseStatistics.reusedSources,2,'fully rejected sectors keep resources dormant');
    f.world.position.x=0;f.world.visible=false;f.prepare();assert.equal(f.culler.statistics[0].selected,0);
    f.world.visible=true;f.anchor.renderOrder=7;f.prepare();assert.equal(f.culler.statistics[0].selected,2);
    const proxy=f.culler.beautyGroup.children.find(group=>group.renderOrder===7)?.children.find(mesh=>mesh.isInstancedMesh);
    assert.ok(proxy,'current inherited order is applied on reactivation');
    f.anchor.removeFromParent();f.prepare();assert.equal(f.culler.statistics[0].selected,0,'detached anchors cannot draw');
    replacement.add(f.anchor);f.prepare();assert.equal(f.culler.statistics[0].selected,2,'reparented anchors reactivate');
    f.anchor.matrixWorld.elements[15]=NaN;assert.throws(()=>f.culler.prepare(box(),f.passes),/finite/);
  }finally{f.close();}
});

test('explicit resource invalidation updates dormant geometry, displacement and cached shadow content',()=>{
  const f=fixture(),texture=new THREE.Texture();
  try{
    f.world.position.x=100;f.prepare();f.prepare();const revision=f.culler.shadowChanges.revision;
    invalidateStaticStreamResources();f.geometry.attributes.position.setX(0,8);f.geometry.attributes.position.needsUpdate=true;
    f.material.displacementMap=texture;f.material.displacementScale=3;f.material.displacementBias=-2;f.material.alphaTest=.25;f.prepare();
    assert.equal(f.culler.staticLeaseStatistics.auditedSources,2);
    assert.equal(f.culler.canonicalSources[0].localBox.max.x,13);
    assert.ok(f.culler.shadowChanges.revision>revision);assert.ok(f.culler.shadowChanges.bounds.length,'offscreen edited shadows invalidate cached regions');
    f.prepare();assert.equal(f.culler.staticLeaseStatistics.reusedSources,2);
    invalidateStaticStreamResources();f.material.transparent=true;assert.throws(f.prepare,/transparent/);f.material.transparent=false;
  }finally{texture.dispose();f.close();}
});

test('source invalidation and revocation force authored audits even with the legacy immutable contract',()=>{
  const f=fixture({legacy:true}),source=f.sources[0];
  try{
    f.prepare();invalidateStaticStreamSource(source);
    source.setMatrixAt(0,new THREE.Matrix4().makeTranslation(50,0,0));source.instanceMatrix.needsUpdate=true;f.prepare();
    assert.equal(f.culler.statistics[0].selected,1);assert.equal(f.culler.canonicalSources[0].worldBox.getCenter(new THREE.Vector3()).x,50);
    invalidateStaticStreamSource(source);source.count=2;source.setMatrixAt(1,new THREE.Matrix4());source.instanceMatrix.needsUpdate=true;f.prepare();assert.equal(f.culler.statistics[0].selected,2);
    releaseStaticStreamSource(source);source.count=1;source.setMatrixAt(0,new THREE.Matrix4());source.instanceMatrix.needsUpdate=true;f.prepare();
    assert.equal(f.culler.canonicalSources[0].count,1);assert.equal(f.culler.canonicalSources[0].worldBox.getCenter(new THREE.Vector3()).x,0);
    assert.equal(getStaticStreamSourceLease(source),undefined);
    f.prepare();assert.equal(f.culler.staticLeaseStatistics.auditedSources,1,'revoked sources retain legacy validation');
    markStaticStreamSource(source,f.anchor);invalidateStaticStreamSource(source);source.count=3;assert.throws(f.prepare,/capacity/);
  }finally{f.close();}
});

test('late leased arrivals and removal preserve deferred offscreen shadow selection',()=>{
  const f=fixture(),source=new THREE.InstancedMesh(f.geometry,f.material,1);
  try{
    f.culler.deferredShadowPasses=new Set([0]);f.prepare();f.prepare();
    source.castShadow=true;f.anchor.add(source);source.setMatrixAt(0,new THREE.Matrix4().makeTranslation(50,0,0));source.instanceMatrix.needsUpdate=true;
    markStaticStreamSource(source,f.anchor);f.scene.updateMatrixWorld(true);f.culler.addSources([source]);f.passes[0].frustum=box(-100,100);f.prepare();
    assert.equal(f.culler.canonicalSources.length,3);assert.equal(f.culler.statistics[0].selected,2);
    f.culler.withShadowRegion(0,box(45,55),()=>{let selected=0;f.culler.shadowGroups[0].traverse(o=>{if(o.isInstancedMesh&&o.visible)selected+=o.count;});assert.equal(selected,1);});
    releaseStaticStreamSource(source);f.culler.removeSources([source]);source.removeFromParent();f.prepare();
    f.culler.withShadowRegion(0,box(45,55),()=>{let selected=0;f.culler.shadowGroups[0].traverse(o=>{if(o.isInstancedMesh&&o.visible)selected+=o.count;});assert.equal(selected,0);});
  }finally{source.dispose();f.close();}
});

test('strong leases do not replace native frustum-only policies with radial clipping',()=>{
  const f=fixture();
  try{
    f.culler.dispose();f.sources[0].setMatrixAt(0,new THREE.Matrix4().makeTranslation(8,0,0));f.sources[0].instanceMatrix.needsUpdate=true;
    const culler=new PassInstanceCuller(f.sources,0,{getStaticSourceLease:getStaticStreamSourceLease,isFrustumOnlySource:s=>s===f.sources[0]});
    f.scene.add(culler.beautyGroup);f.scene.updateMatrixWorld(true);
    try{
      const prepare=()=>culler.prepare(box(-20,20),[],1,{origin:new THREE.Vector3(),distance:1});
      prepare();culler.enable();prepare();assert.equal(culler.statistics[0].selected,1);assert.equal(culler.staticLeaseStatistics.reusedSources,2);
    }finally{culler.dispose();}
  }finally{f.close();}
});
