import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';

function box(min = -100, max = 100) {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -min), new THREE.Plane(new THREE.Vector3(-1, 0, 0), max),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 100), new THREE.Plane(new THREE.Vector3(0, -1, 0), 100),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 100), new THREE.Plane(new THREE.Vector3(0, 0, -1), 100),
  );
}
function fixture() {
  const scene = new THREE.Scene(), parent = new THREE.Group(), geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, 4);
  source.castShadow = source.receiveShadow = true; source.layers.mask = 65; source.position.x = 10;
  [-30, 0, 30, 60].forEach((x, i) => { source.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 0)); source.setColorAt(i, new THREE.Color().setRGB(i / 4, .3, .8)); });
  source.instanceMatrix.needsUpdate = true; source.instanceColor.needsUpdate = true;
  parent.add(source); scene.add(parent); scene.updateMatrixWorld(true);
  const culler = new PassInstanceCuller([source], 2); scene.add(culler.beautyGroup, ...culler.shadowGroups);
  const lights = [new THREE.DirectionalLight(), new THREE.DirectionalLight()], passes = lights.map(light => ({ light, frustum: box(0, 50) }));
  const prepare = () => { scene.updateMatrixWorld(true); culler.prepare(box(), passes); };
  prepare(); culler.enable();
  const proxy = (pass, region = false) => { let found; culler.shadowGroups[pass].traverse(object => { if (object instanceof THREE.InstancedMesh && !!object.userData.shadowRegionProxy === region) found = object; }); return found; };
  const ids = object => Array.from({ length: object.count }, (_, i) => culler.resolveProxyInstance(object, i).instanceId);
  return { scene, parent, geometry, material, source, culler, lights, passes, prepare, proxy, ids,
    close: () => { culler.dispose(); source.dispose(); geometry.dispose(); material.dispose(); },
  };
}

test('deferred passes skip full selections and uploads while beauty and near shadows remain prepared', () => {
  const f = fixture(), full = f.proxy(1), upload = full.instanceMatrix.version;
  try {
    f.culler.deferredShadowPasses = new Set([1]); f.prepare();
    assert.equal(full.count, 0); assert.equal(full.visible, false);
    assert.equal(full.instanceMatrix.version, upload);
    assert.equal(f.culler.statistics[2].selected, 0);
    assert.equal(f.culler.statistics[2].boundsTests, 0);
    assert.equal(f.culler.statistics[2].cellTests, 0);
    assert.equal(f.culler.statistics[2].uploadedSelections, 0);
    assert.equal(f.culler.statistics[0].selected, 4);
    assert.equal(f.culler.statistics[1].selected, 2);
    f.culler.withShadowRegion(1, box(39, 39), () => {
      assert.deepEqual(f.ids(f.proxy(1, true)), [2]);
      assert.equal(f.proxy(1, true).visible, true); assert.equal(full.visible, false);
    });
    assert.equal(f.proxy(1, true).visible, false); assert.equal(full.visible, false);
    assert.equal(full.instanceMatrix.version, upload);
    assert.equal(f.culler.statistics[2].selected, 1);
    f.culler.withShadowRegion(1, box(-100, 100), () => assert.deepEqual(f.ids(f.proxy(1, true)), [1, 2], 'A wide region cannot escape the original full pass'));
    f.culler.deferredShadowPasses = new Set(); f.prepare();
    assert.deepEqual(f.ids(full), [1, 2]); assert.equal(full.visible, true);
    assert.equal(full.instanceMatrix.version, upload, 'An unchanged original full selection remains reusable');
  } finally { f.close(); }
});

test('stable deferred passes skip draw-state writes and new sources start hidden until a region requests them',()=>{
  const f=fixture(),extra=new THREE.InstancedMesh(f.geometry,f.material,1);
  const tracked=[];let writes=0;
  const observe=(object,key)=>{
    let value=object[key];Object.defineProperty(object,key,{configurable:true,get:()=>value,set:next=>{writes++;value=next;}});
    tracked.push(()=>Object.defineProperty(object,key,{configurable:true,writable:true,value}));
  };
  try{
    f.culler.deferredShadowPasses.add(1);f.prepare();
    const draw=f.culler.sourceStates.get(f.source).draws[2],full=f.proxy(1);
    for(const key of ['selected','volume','revision'])observe(draw,key);
    for(const key of ['count','visible'])observe(full,key);
    f.prepare();f.prepare();assert.equal(writes,0,'Already deferred full draws need no per-source pass bookkeeping');
    extra.castShadow=true;extra.setMatrixAt(0,new THREE.Matrix4().makeTranslation(20,0,0));
    f.parent.add(extra);f.scene.updateMatrixWorld(true);f.culler.addSources([extra]);
    const extraDraw=f.culler.sourceStates.get(extra).draws[2];
    assert.equal(extraDraw.proxy.visible,false);assert.equal(extraDraw.proxy.count,0);
    f.prepare();assert.equal(writes,0);
    f.culler.withShadowRegion(1,box(),()=>{
      assert.equal(extraDraw.region.proxy.visible,true);assert.equal(extraDraw.region.proxy.count,1);
      assert.equal(extraDraw.proxy.visible,false);
    });
    const before=writes;
    f.culler.deferredShadowPasses.delete(1);f.prepare();
    assert.ok(writes>before);assert.equal(full.visible,true);assert.deepEqual(f.ids(full),[1,2]);
    assert.equal(extraDraw.proxy.visible,true);assert.equal(extraDraw.proxy.count,1);
    f.culler.deferredShadowPasses.add(1);f.prepare();const transitioned=writes;
    f.prepare();assert.equal(writes,transitioned);assert.equal(full.visible,false);
  }finally{for(const restore of tracked)restore();f.culler.removeSources([extra]);extra.removeFromParent();extra.dispose();f.close();}
});

test('already hidden cell-rejected passes skip bookkeeping while another pass keeps the cell active',()=>{
  const f=fixture(),tracked=[];let writes=0;
  const observe=(object,key)=>{
    let value=object[key];Object.defineProperty(object,key,{configurable:true,get:()=>value,set:next=>{writes++;value=next;}});
    tracked.push(()=>Object.defineProperty(object,key,{configurable:true,writable:true,value}));
  };
  try{
    f.passes[0].frustum=box(200,250);f.prepare();
    const draw=f.culler.sourceStates.get(f.source).draws[1],proxy=f.proxy(0);
    assert.equal(proxy.visible,false);assert.equal(draw.selected,0);assert.equal(f.culler.statistics[0].selected,4);
    for(const key of ['selected','volume','revision','coarseSelection'])observe(draw,key);
    for(const key of ['count','visible'])observe(proxy,key);
    f.prepare();f.prepare();assert.equal(writes,0);assert.equal(f.culler.statistics[1].cellRejected,1);
    f.source.setMatrixAt(1,new THREE.Matrix4().makeTranslation(5,0,0));f.source.instanceMatrix.needsUpdate=true;
    f.prepare();assert.equal(writes,0,'Source changes are audited without touching an unselected draw');
    f.passes[0].frustum=box(0,50);f.prepare();
    assert.ok(writes>0);assert.equal(proxy.visible,true);assert.deepEqual(f.ids(proxy),[1,2]);
    assert.equal(proxy.instanceMatrix.array[12],5,'Reactivation uses the current source buffer');
  }finally{for(const restore of tracked)restore();f.close();}
});

test('deferred regions intersect caster volumes and preserve current source gates', () => {
  const f = fixture(); let allowed = true, filterCalls = 0;
  try {
    f.culler.deferredShadowPasses = new Set([1]);
    f.passes[1].casterVolume = { planes: [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 35)] };
    f.passes[1].sourceFilter = () => { filterCalls++; return allowed; };
    f.prepare(); assert.equal(filterCalls, 0, 'Deferred full-pass source gates do no work before a region is requested');
    f.culler.withShadowRegion(1, box(), () => assert.deepEqual(f.ids(f.proxy(1, true)), [1]));
    allowed = false; f.prepare();
    f.culler.withShadowRegion(1, box(), () => assert.equal(f.proxy(1, true).visible, false));
    allowed = true; f.source.castShadow = false; f.prepare();
    f.culler.withShadowRegion(1, box(), () => assert.equal(f.proxy(1, true).visible, false));
    f.source.castShadow = true; f.parent.visible = false; f.prepare();
    f.culler.withShadowRegion(1, box(), () => assert.equal(f.proxy(1, true).visible, false));
    f.parent.visible = true; f.prepare();
    f.culler.withShadowRegion(1, box(), () => assert.deepEqual(f.ids(f.proxy(1, true)), [1]));
  } finally { f.close(); }
});

test('deferred strips reject disjoint batch bounds before ancestry and source gates while keeping intersecting gates live',()=>{
  const f=fixture(),extra=new THREE.InstancedMesh(f.geometry,f.material,1),seen=[];let visibilityReads=0,allowed=true;
  try{
    extra.castShadow=true;extra.setMatrixAt(0,new THREE.Matrix4().makeTranslation(90,0,0));extra.instanceMatrix.needsUpdate=true;
    f.parent.add(extra);f.scene.updateMatrixWorld(true);f.culler.addSources([extra]);
    f.culler.deferredShadowPasses.add(1);f.passes[1].frustum=box(0,100);
    f.passes[1].sourceFilter=source=>{seen.push(source);return source!==extra||allowed;};f.prepare();
    assert.equal(f.culler.sourceStates.get(extra).cell,f.culler.sourceStates.get(f.source).cell,'Both batches share a strip-crossing spatial cell');
    Object.defineProperty(extra,'visible',{configurable:true,get(){visibilityReads++;return true;}});
    f.culler.withShadowRegion(1,box(39,39),()=>assert.deepEqual(f.ids(f.proxy(1,true)),[2]));
    assert.deepEqual(seen,[f.source]);assert.equal(visibilityReads,0,'Rejected bounds require no source/ancestor visibility walk');
    seen.length=0;const draw=f.culler.sourceStates.get(extra).draws[2];
    f.culler.withShadowRegion(1,box(89,91),()=>assert.equal(draw.region.proxy.count,1));
    assert.deepEqual(seen,[extra]);assert.ok(visibilityReads>0);
    allowed=false;f.culler.withShadowRegion(1,box(89,91),()=>assert.equal(draw.region.proxy.visible,false));
    allowed=true;f.parent.visible=false;f.culler.withShadowRegion(1,box(89,91),()=>assert.equal(draw.region.proxy.visible,false));
  }finally{
    Object.defineProperty(extra,'visible',{configurable:true,writable:true,value:true});
    f.culler.removeSources([extra]);extra.removeFromParent();extra.dispose();f.close();
  }
});

test('deferred helpers bind newly mutated canonical resources and transforms instead of stale full proxies', () => {
  const f = fixture(), replacementGeometry = new THREE.BoxGeometry(4, 6, 4), replacementMaterial = new THREE.MeshStandardMaterial(), depth = new THREE.MeshDepthMaterial();
  try {
    f.culler.deferredShadowPasses = new Set([1]); f.prepare();
    const oldMatrix = f.proxy(1).matrixWorld.clone();
    f.source.geometry = replacementGeometry; f.source.material = replacementMaterial; f.source.customDepthMaterial = depth;
    f.source.position.set(14, 3, 2); f.source.renderOrder = 23; f.parent.renderOrder = 9;
    f.source.setColorAt(2, new THREE.Color(.9, .2, .1)); f.source.instanceColor.needsUpdate = true;
    f.prepare(); assert.deepEqual(f.proxy(1).matrixWorld.elements, oldMatrix.elements, 'The deferred full proxy was not rebound unnecessarily');
    f.culler.withShadowRegion(1, box(), () => {
      const region = f.proxy(1, true);
      assert.equal(region.geometry, replacementGeometry); assert.equal(region.material, replacementMaterial);
      assert.equal(region.customDepthMaterial, depth); assert.deepEqual(region.matrixWorld.elements, f.source.matrixWorld.elements);
      assert.deepEqual(region.boundingBox, f.culler.canonicalSources[0].localBox);
      assert.equal(region.parent.renderOrder, 9); assert.equal(region.renderOrder, 23); assert.equal(region.layers.mask, 65);
      assert.equal(region.castShadow, true); assert.equal(region.receiveShadow, false);
      assert.deepEqual(f.ids(region), [1, 2]);
      assert.deepEqual(region.instanceColor.array.slice(3, 6), f.source.instanceColor.array.slice(6, 9));
    });
    replacementMaterial.transparent = true;
    assert.throws(f.prepare, /transparent/, 'Even deferred and hidden sources retain material compatibility validation');
  } finally { replacementGeometry.dispose(); replacementMaterial.dispose(); depth.dispose(); f.close(); }
});

test('deferred requests preserve dirty journals, callback cleanup, and the prepare-time deferral snapshot', () => {
  const f = fixture(), requested = new Set([1]);
  try {
    f.culler.trackShadowContent = true; f.culler.deferredShadowPasses = requested; f.prepare();
    const revision = f.culler.shadowChanges.revision;
    f.source.position.x += 2; f.prepare();
    assert.ok(f.culler.shadowChanges.revision > revision); assert.ok(f.culler.shadowChanges.bounds.length > 0);
    requested.clear();
    assert.throws(() => f.culler.withShadowRegion(1, box(), () => { throw new Error('region interrupted'); }), /region interrupted/);
    assert.equal(f.proxy(1).visible, false); assert.equal(f.proxy(1, true).visible, false);
    assert.throws(() => f.culler.withShadowRegion(1, box(), () => Promise.resolve()), /synchronous/);
    assert.equal(f.proxy(1).visible, false); assert.equal(f.proxy(1, true).visible, false);
    f.prepare(); assert.equal(f.proxy(1).visible, true, 'Clearing the public request takes effect on the next prepare');
  } finally { f.close(); }
});

test('ordinary dispatch falls back to a complete region if its deferred cache dispatcher is removed', () => {
  const f = fixture(), state = { enabled: true, autoUpdate: true, needsUpdate: false, type: THREE.PCFShadowMap };
  try {
    f.culler.deferredShadowPasses = new Set([1]); f.prepare();
    let calls = 0;
    f.culler.renderShadowPasses(lights => {
      calls++;
      if (lights[0] === f.lights[1]) { assert.deepEqual(f.ids(f.proxy(1, true)), [1, 2]); assert.equal(f.proxy(1, true).visible, true); }
    }, state, f.lights, f.scene, new THREE.PerspectiveCamera());
    assert.equal(calls, 2); assert.equal(f.proxy(1).visible, false); assert.equal(f.proxy(1, true).visible, false);
    f.culler.deferredShadowPasses = new Set([2]);
    assert.throws(f.prepare, /Invalid deferred shadow pass/);
  } finally { f.close(); }
});

test('stable region pairs avoid sibling-list scans and repair pairing after inherited order changes', () => {
  for (const deferred of [false, true]) {
    const f = fixture(), trackedLists = [];
    const assertPaired = () => {
      const full = f.proxy(1), region = f.proxy(1, true), siblings = full.parent.children;
      assert.equal(region.parent, full.parent);
      assert.equal(Array.prototype.indexOf.call(siblings, region), Array.prototype.indexOf.call(siblings, full) + 1);
    };
    const track = group => {
      const siblings = group.children, counter = { scans: 0 };
      siblings.indexOf = function (...args) { counter.scans++; return Array.prototype.indexOf.apply(this, args); };
      trackedLists.push(siblings); return counter;
    };
    try {
      if (deferred) f.culler.deferredShadowPasses = new Set([1]);
      f.prepare(); f.culler.withShadowRegion(1, box(), assertPaired);
      const original = track(f.proxy(1).parent);
      for (let i = 0; i < 4; i++) { f.prepare(); f.culler.withShadowRegion(1, box(i, 50), assertPaired); }
      assert.equal(original.scans, 0, 'Repeated selections do not scan or reorder stable sibling pairs');
      f.parent.renderOrder = 9; f.prepare(); f.culler.withShadowRegion(1, box(), assertPaired);
      assert.equal(f.proxy(1).parent.renderOrder, 9);
      const next = track(f.proxy(1).parent);
      f.culler.withShadowRegion(1, box(), assertPaired); assert.equal(next.scans, 0);
      // A full proxy can leave and return before its region next renders. The
      // parent identity alone cannot detect that its insertion order changed.
      f.culler.deferredShadowPasses = new Set();
      f.parent.renderOrder = 12; f.prepare();
      f.parent.renderOrder = 9; f.prepare();
      if (deferred) { f.culler.deferredShadowPasses = new Set([1]); f.prepare(); }
      const before = next.scans;
      f.culler.withShadowRegion(1, box(), assertPaired);
      assert.ok(next.scans > before, 'A moved full proxy invalidates the cached pairing even after returning to the same group');
      const repaired = next.scans;
      f.culler.withShadowRegion(1, box(), assertPaired); assert.equal(next.scans, repaired);
    } finally { for (const siblings of trackedLists) delete siblings.indexOf; f.close(); }
  }
});

test('unchanged prepares do not rewrite proxy assets while pointer mutations and shadow overrides remain current', () => {
  const f = fixture(), shadowGeometry = new THREE.BoxGeometry(2, 2, 2), replacementGeometry = new THREE.BoxGeometry(4, 4, 4);
  const replacementMaterial = new THREE.MeshStandardMaterial(), customDepth = new THREE.MeshDepthMaterial();
  let writes = 0;
  try {
    f.culler.shadowGeometryForSource = () => shadowGeometry;
    f.culler.deferredShadowPasses = new Set([1]); f.prepare();
    f.culler.withShadowRegion(1, box(), () => {});
    const proxies = [];
    for (const root of [f.culler.beautyGroup, ...f.culler.shadowGroups]) root.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      proxies.push(object);
      for (const key of ['geometry', 'material', 'customDepthMaterial', 'customDistanceMaterial']) {
        let value = object[key];
        Object.defineProperty(object, key, { configurable: true, get: () => value, set: next => { writes++; value = next; } });
      }
    });
    const nativeDepth = f.proxy(0).customDepthMaterial;
    assert.ok(nativeDepth); assert.equal(f.proxy(0).geometry, shadowGeometry);
    f.prepare(); f.prepare();
    assert.equal(writes, 0, 'Stable selected and hidden proxies retain their already-correct asset bindings');
    const materialArray = [f.material]; f.source.material = materialArray; f.prepare();
    for (const proxy of proxies) assert.equal(proxy.material, materialArray);
    materialArray[0] = replacementMaterial; writes = 0; f.prepare();
    assert.equal(writes, 0, 'In-place material-array edits reach every proxy through the same authoritative array');
    replacementMaterial.transparent = true;
    assert.throws(f.prepare, /transparent/, 'Pointer reuse does not bypass compatibility validation');
    replacementMaterial.transparent = false;
    f.source.geometry = replacementGeometry; f.source.customDepthMaterial = customDepth; f.prepare();
    assert.equal(f.proxy(1, true).geometry, replacementGeometry, 'Hidden helpers release replaced source geometry immediately');
    for (const proxy of proxies) assert.equal(proxy.customDepthMaterial, customDepth);
    f.source.customDepthMaterial = undefined; f.prepare();
    assert.equal(f.proxy(0).customDepthMaterial, nativeDepth);
    f.culler.orthographicDepthEnabled = false; f.prepare();
    assert.equal(f.proxy(0).customDepthMaterial, undefined, 'Disabling the optimization restores the source depth binding');
    f.culler.orthographicDepthEnabled = true; replacementMaterial.alphaTest = .5; f.prepare();
    assert.equal(f.proxy(0).customDepthMaterial, undefined, 'Changing material eligibility also removes the depth override');
    replacementMaterial.alphaTest = 0; f.culler.shadowGeometryForSource = undefined; f.prepare();
    assert.equal(f.proxy(0).geometry, replacementGeometry, 'Changing the shadow geometry resolver restores original geometry');
    assert.equal(f.proxy(0).customDepthMaterial, nativeDepth);
  } finally { f.close(); shadowGeometry.dispose(); replacementGeometry.dispose(); replacementMaterial.dispose(); customDepth.dispose(); }
});

test('constant-time source membership follows registration, duplicate rejection, removal and disposal', () => {
  const f = fixture(), extra = new THREE.InstancedMesh(f.geometry, f.material, 1);
  try {
    assert.equal(f.culler.hasSource(f.source), true); assert.equal(f.culler.hasSource(extra), false);
    assert.equal(f.culler.hasSource(f.proxy(0)), false);
    f.scene.add(extra); f.scene.updateMatrixWorld(true); f.culler.addSources([extra]);
    assert.equal(f.culler.hasSource(extra), true);
    assert.throws(() => f.culler.addSources([extra]), /already registered/);
    f.culler.removeSources([extra]); assert.equal(f.culler.hasSource(extra), false);
    assert.throws(() => f.culler.addSources([extra, extra]), /already registered/);
    assert.equal(f.culler.hasSource(extra), false, 'Duplicate input validation remains atomic');
    f.culler.dispose(); assert.equal(f.culler.hasSource(f.source), false);
  } finally { extra.dispose(); f.close(); }
});
