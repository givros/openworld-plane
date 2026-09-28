import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';

function box(min=-100,max=100) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -min), new THREE.Plane(new THREE.Vector3(-1, 0, 0), max),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 100), new THREE.Plane(new THREE.Vector3(0, -1, 0), 100),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 100), new THREE.Plane(new THREE.Vector3(0, 0, -1), 100),
  );
}
function fixture() {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, 2);
  source.castShadow = source.receiveShadow = true;
  source.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-3, 0, 0));
  source.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0, 0));
  scene.add(source); scene.updateMatrixWorld(true);
  const culler = new PassInstanceCuller([source], 2);
  scene.add(culler.beautyGroup, ...culler.shadowGroups);
  const passes = Array.from({ length: 2 }, () => ({ light: new THREE.DirectionalLight(), frustum: box() }));
  const prepare = () => { scene.updateMatrixWorld(true); culler.prepare(box(), passes); culler.enable(); };
  const proxy = (pass, region = false) => {
    let result;
    [culler.beautyGroup, ...culler.shadowGroups][pass].traverse(object => {
      if (object instanceof THREE.InstancedMesh && !!object.userData.shadowRegionProxy === region) result = object;
    });
    return result;
  };
  prepare();
  return { scene, geometry, material, source, culler, passes, prepare, proxy,
    close: () => { culler.dispose(); source.dispose(); geometry.dispose(); material.dispose(); } };
}

test('pass geometry binds independent representations without changing canonical resources or instance IDs', () => {
  const f = fixture(), variants = Array.from({ length: 3 }, () => new THREE.BoxGeometry(1, 1, 1));
  const originalMatrices = f.source.instanceMatrix.array.slice(), originalBounds = f.culler.canonicalSources[0].worldBox.clone();
  const seen = [];
  try {
    f.culler.geometryForPass = (descriptor, pass, light) => {
      assert.equal(descriptor.source, f.source); seen.push([pass, light]); return variants[pass];
    };
    f.prepare();
    for (let pass = 0; pass < 3; pass++) {
      assert.equal(f.proxy(pass).geometry, variants[pass]);
      assert.equal(f.proxy(pass).material, f.material);
      assert.deepEqual(Array.from({ length: 2 }, (_, index) => f.culler.resolveProxyInstance(f.proxy(pass), index).instanceId), [0, 1]);
    }
    assert.deepEqual(seen, [[0, undefined], [1, f.passes[0].light], [2, f.passes[1].light]]);
    assert.equal(f.source.geometry, f.geometry); assert.deepEqual(f.source.instanceMatrix.array, originalMatrices);
    assert.deepEqual(f.culler.canonicalSources[0].worldBox, originalBounds);
    const next = new THREE.BoxGeometry(.5, .5, .5); variants.push(next);
    f.culler.geometryForPass = (_, pass) => pass === 0 ? next : variants[pass];
    f.prepare(); assert.equal(f.proxy(0).geometry, next, 'Geometry changes even when selection is reused');
  } finally { f.close(); variants.forEach(geometry => geometry.dispose()); }
});

test('removing pass override restores canonical beauty and legacy exact shadow fallback', () => {
  const f = fixture(), variant = new THREE.BoxGeometry(1, 1, 1), shadow = f.geometry.clone();
  try {
    f.culler.shadowGeometryForSource = () => shadow;
    f.culler.geometryForPass = () => variant; f.prepare();
    f.culler.geometryForPass = () => undefined; f.prepare();
    assert.equal(f.proxy(0).geometry, f.geometry); assert.equal(f.proxy(1).geometry, shadow); assert.equal(f.proxy(2).geometry, shadow);
    f.culler.geometryForPass = () => variant; f.prepare();
    f.culler.geometryForPass = undefined; f.prepare();
    assert.equal(f.proxy(0).geometry, f.geometry); assert.equal(f.proxy(1).geometry, shadow);
  } finally { f.close(); variant.dispose(); shadow.dispose(); }
});

test('exact boundary beauty can retain coarse shadow draws and fully contained identity selections',()=>{
  const f=fixture(),variant=new THREE.BoxGeometry(1,1,1);variant.userData.distanceDetailLevel=1;
  try{
    f.culler.coarseDetailSelection=true;f.culler.geometryForPass=()=>variant;
    for(const pass of f.passes)pass.frustum=box(0,100);
    const prepare=(volume=box(0,100))=>f.culler.prepare(volume,f.passes);
    prepare();assert.equal(f.proxy(0).count,2);assert.equal(f.proxy(1).count,2);
    f.culler.coarseBeautySelection=false;prepare();
    assert.equal(f.proxy(0).count,1);assert.equal(f.proxy(1).count,2);assert.equal(f.proxy(2).count,2);
    assert.equal(f.culler.resolveProxyInstance(f.proxy(0),0).instanceId,1);
    assert.equal(f.proxy(0).geometry,variant,'Only visibility changes, never the selected representation');
    prepare(box());assert.equal(f.proxy(0).count,2);assert.equal(f.culler.statistics[0].boundsTests,0);
    assert.equal(f.culler.states[0].draws[0].identityCount,2,'Fully contained batches retain the identity upload fastpath');
    const version=f.proxy(0).instanceMatrix.version;prepare(box());assert.equal(f.proxy(0).instanceMatrix.version,version);
    f.culler.coarseBeautySelection=true;prepare();assert.equal(f.proxy(0).count,2);
  }finally{f.close();variant.dispose();}
});

test('deferred and ordinary shadow regions bind their own pass representation', () => {
  const f = fixture(), variants = Array.from({ length: 3 }, () => new THREE.BoxGeometry(1, 1, 1));
  try {
    f.culler.geometryForPass = (_, pass) => variants[pass];
    f.culler.deferredShadowPasses.add(1); f.prepare();
    f.culler.withShadowRegion(1, box(), () => {
      assert.equal(f.proxy(2, true).geometry, variants[2]); assert.equal(f.proxy(2, true).count, 2);
    });
    f.culler.withShadowRegion(0, box(), () => assert.equal(f.proxy(1, true).geometry, variants[1]));
    f.culler.geometryForPass = undefined; f.prepare();
    f.culler.withShadowRegion(1, box(), () => assert.equal(f.proxy(2, true).geometry, f.geometry));
    assert.equal(f.source.geometry, f.geometry);
  } finally { f.close(); variants.forEach(geometry => geometry.dispose()); }
});

test('resident preparation includes selected pass representations and preserves selection', () => {
  const f = fixture(), variants = Array.from({ length: 3 }, () => new THREE.BoxGeometry(1, 1, 1));
  try {
    f.culler.geometryForPass = (_, pass) => variants[pass]; f.prepare();
    const before = [0, 1, 2].map(pass => [f.proxy(pass).count, f.proxy(pass).visible, f.proxy(pass).instanceMatrix.version]);
    const meshes = [...f.culler.preparationMeshes(new Set([1]))];
    assert.equal(meshes.length, 4);
    for (const mesh of meshes) assert.equal(mesh.geometry, variants[mesh.userData.passIndex]);
    assert.deepEqual([0, 1, 2].map(pass => [f.proxy(pass).count, f.proxy(pass).visible, f.proxy(pass).instanceMatrix.version]), before);
    assert.equal(f.source.geometry, f.geometry);
  } finally { f.close(); variants.forEach(geometry => geometry.dispose()); }
});

test('shadow cache journals representation policy changes and explicit content invalidations', () => {
  const f = fixture(), variant = new THREE.BoxGeometry(1, 1, 1);
  try {
    f.culler.trackShadowContent = true; f.prepare(); f.prepare();
    assert.equal(f.culler.shadowChanges.full, false); const initial = f.culler.shadowChanges.revision;
    f.culler.geometryForPass = () => variant; f.prepare();
    assert.equal(f.culler.shadowChanges.full, true); assert.ok(f.culler.shadowChanges.revision > initial);
    const applied = f.culler.shadowChanges.revision; f.prepare();
    assert.equal(f.culler.shadowChanges.full, false); assert.equal(f.culler.shadowChanges.revision, applied);
    f.culler.invalidateRenderGeometry(); f.prepare();
    assert.equal(f.culler.shadowChanges.full, true); assert.ok(f.culler.shadowChanges.revision > applied);
    f.culler.withShadowRegion(0, box(), () => assert.throws(() => f.culler.invalidateRenderGeometry(), /shadow dispatch/));
    f.culler.geometryForPass = undefined; f.prepare(); assert.equal(f.culler.shadowChanges.full, true);
  } finally { f.close(); variant.dispose(); }
});

test('coarse distance detail retains every exact instance and changes mode without stale selection',()=>{
  const f=fixture(),variant=new THREE.BoxGeometry(1,1,1);variant.userData.distanceDetailLevel=1;
  const ids=pass=>Array.from({length:f.proxy(pass).count},(_,i)=>f.culler.resolveProxyInstance(f.proxy(pass),i).instanceId);
  const prepare=()=>{f.scene.updateMatrixWorld(true);f.culler.prepare(box(1,5),f.passes);};
  let representation=variant,calls=0;
  try{
    f.passes.forEach(pass=>{pass.frustum=box(1,5);});
    f.culler.geometryForPass=()=>{calls++;return representation;};
    prepare();assert.deepEqual(ids(0),[1]);assert.deepEqual(ids(1),[1]);
    f.culler.coarseDetailSelection=true;calls=0;prepare();
    assert.equal(calls,3,'One geometry decision per active ordinary pass');
    for(const pass of [0,1,2])assert.deepEqual(ids(pass),[0,1],'Coarse draw is a conservative superset');
    const versions=[0,1,2].map(pass=>f.proxy(pass).instanceMatrix.version);
    f.culler.prepare(box(.5,4.5),f.passes);
    assert.deepEqual([0,1,2].map(pass=>f.proxy(pass).instanceMatrix.version),versions,'Changed clip planes retain identical full-batch buffers');
    representation=f.geometry;prepare();
    assert.deepEqual(ids(0),[1]);assert.deepEqual(ids(1),[1],'Original geometry retains exact selection');
    representation=variant;prepare();assert.deepEqual(ids(0),[0,1]);
    f.culler.coarseDetailSelection=false;prepare();assert.deepEqual(ids(0),[1]);
    assert.equal(f.source.geometry,f.geometry);assert.equal(f.source.count,2);
  }finally{f.close();variant.dispose();}
});

test('coarse distance detail still rejects complete source bounds and respects range and source gates',()=>{
  const f=fixture(),variant=new THREE.BoxGeometry(1,1,1);variant.userData.distanceDetailLevel=2;
  try{
    f.culler.geometryForPass=()=>variant;f.culler.coarseDetailSelection=true;
    f.culler.prepare(box(20,30),f.passes);assert.equal(f.proxy(0).count,0);
    f.culler.prepare(box(),f.passes,1,{origin:new THREE.Vector3(100,0,0),distance:10});assert.equal(f.proxy(0).count,0);
    f.culler.prepare(box(),f.passes,1,{origin:new THREE.Vector3(3,0,0),distance:1});assert.equal(f.proxy(0).count,2,'Intersecting source bounds retain all instances');
    f.passes[0].sourceFilter=()=>false;f.culler.prepare(box(),f.passes);assert.equal(f.proxy(1).count,0);
    f.source.visible=false;f.prepare();assert.equal(f.proxy(0).count,0);assert.equal(f.proxy(2).count,0);
  }finally{f.close();variant.dispose();}
});

test('cached shadow strips remain exact while ordinary distance-detail shadow volumes are coarse',()=>{
  const f=fixture(),variant=new THREE.BoxGeometry(1,1,1);variant.userData.distanceDetailLevel=3;
  const ids=mesh=>Array.from({length:mesh.count},(_,i)=>f.culler.resolveProxyInstance(mesh,i).instanceId);
  try{
    f.culler.geometryForPass=()=>variant;f.culler.coarseDetailSelection=true;
    f.culler.deferredShadowPasses.add(1);f.prepare();
    f.culler.withShadowRegion(1,box(1,5),()=>assert.deepEqual(ids(f.proxy(2,true)),[1]));
    f.culler.withShadowRegion(0,box(1,5),()=>assert.deepEqual(ids(f.proxy(1,true)),[1]));
    // A helper can change from full deferred selection to a partial ordinary
    // strip and back. Its cached identity prefix must not outlive that overwrite.
    f.culler.withShadowRegion(1,box(),()=>assert.deepEqual(ids(f.proxy(2,true)),[0,1]));
    f.culler.deferredShadowPasses.clear();f.prepare();
    f.culler.withShadowRegion(1,box(1,5),()=>assert.deepEqual(ids(f.proxy(2,true)),[1]));
    f.culler.deferredShadowPasses.add(1);f.prepare();
    f.culler.withShadowRegion(1,box(),()=>assert.deepEqual(ids(f.proxy(2,true)),[0,1]));
  }finally{f.close();variant.dispose();}
});

test('unchanged full identity selections reuse uploads without scanning the instance prefix',()=>{
  const f=fixture();
  try{
    const draw=f.culler.sourceStates.get(f.source).draws[0],indices=draw.uploadedIndices;
    let reads=0;draw.uploadedIndices=new Proxy(indices,{get(target,key){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,target);}});
    const version=f.proxy(0).instanceMatrix.version;
    f.culler.prepare(box(-99,99),f.passes);
    assert.equal(reads,0);assert.equal(f.proxy(0).instanceMatrix.version,version);
    f.source.setMatrixAt(1,new THREE.Matrix4().makeTranslation(4,0,0));f.source.instanceMatrix.needsUpdate=true;
    f.prepare();assert.ok(f.proxy(0).instanceMatrix.version>version,'Source buffer revisions still upload the current matrices');
    draw.uploadedIndices=indices;
  }finally{f.close();}
});
