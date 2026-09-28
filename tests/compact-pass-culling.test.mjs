import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PassInstanceCuller,isPassInstanceProxy} from '../src/world/PassInstanceCuller.ts';

function box(min=-5,max=5){return new THREE.Frustum(
  new THREE.Plane(new THREE.Vector3(1,0,0),-min),new THREE.Plane(new THREE.Vector3(-1,0,0),max),
  new THREE.Plane(new THREE.Vector3(0,1,0),5),new THREE.Plane(new THREE.Vector3(0,-1,0),5),
  new THREE.Plane(new THREE.Vector3(0,0,1),5),new THREE.Plane(new THREE.Vector3(0,0,-1),5));}
function fixture(){
  const scene=new THREE.Scene(),world=new THREE.Group(),order=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
  order.renderOrder=8;world.add(order);scene.add(world);
  const sources=[0,3,50].map((x,index)=>{
    const source=new THREE.InstancedMesh(geometry,material,2);source.name=`source ${index}`;source.castShadow=true;
    source.setMatrixAt(0,new THREE.Matrix4().makeTranslation(x,0,0));source.setMatrixAt(1,new THREE.Matrix4().makeTranslation(x+1,0,0));
    (index===1?order:world).add(source);return source;
  });
  scene.updateMatrixWorld(true);
  const culler=new PassInstanceCuller(sources,2),lights=[new THREE.DirectionalLight(),new THREE.DirectionalLight()];
  const passes=lights.map(light=>({light,frustum:box()}));scene.add(culler.beautyGroup,...culler.shadowGroups);
  const prepare=()=>{scene.updateMatrixWorld(true);culler.prepare(box(),passes);};prepare();culler.enable();
  return {scene,world,order,sources,culler,lights,passes,prepare,
    close:()=>{culler.dispose();sources.forEach(source=>source.dispose());geometry.dispose();material.dispose();}};
}
function visibleProxies(root){const result=[];root.traverseVisible(object=>{if(isPassInstanceProxy(object)&&object instanceof THREE.InstancedMesh)result.push(object);});return result;}
function snapshot(root){const result=[];root.traverse(object=>{if(object instanceof THREE.Group)result.push([object,object.children]);});return result;}
function assertRestored(saved){for(const [group,children] of saved)assert.equal(group.children,children);}

test('beauty compact traversal preserves native selected sequence and picking identity',()=>{
  const f=fixture();
  try{
    const expected=visibleProxies(f.culler.beautyGroup),saved=snapshot(f.culler.beautyGroup);
    assert.equal(expected.length,2);
    f.culler.withCompactBeauty(()=>{
      assert.deepEqual(visibleProxies(f.culler.beautyGroup),expected);
      for(const proxy of expected){assert.equal(f.culler.resolveProxyInstance(proxy,0).source.uuid,proxy.userData.canonicalSourceUUID);assert.ok(proxy.parent);}
    });
    assertRestored(saved);assert.ok(f.culler.compactRenderStatistics.passes[0].skippedChildren>0);
    f.culler.compactRenderLists=false;let all=0;
    f.culler.withCompactBeauty(()=>f.culler.beautyGroup.traverse(object=>{if(object instanceof THREE.InstancedMesh)all++;}));
    assert.equal(all,3);
    f.culler.compactRenderLists=true;f.order.renderOrder=19;f.prepare();
    const reordered=visibleProxies(f.culler.beautyGroup);
    f.culler.withCompactBeauty(()=>assert.deepEqual(visibleProxies(f.culler.beautyGroup),reordered));
  }finally{f.close();}
});

test('native shadow dispatch compacts both full and deferred region selections inside beauty',()=>{
  const f=fixture(),shadow={enabled:true,autoUpdate:true,needsUpdate:false,type:THREE.PCFShadowMap},camera=new THREE.PerspectiveCamera();
  try{
    f.culler.deferredShadowPasses=new Set([1]);f.prepare();
    const beauty=snapshot(f.culler.beautyGroup),shadowSaved=f.culler.shadowGroups.map(snapshot),calls=[];
    f.culler.withCompactBeauty(()=>f.culler.renderShadowPasses(lights=>{
      const index=f.lights.indexOf(lights[0]),group=f.culler.shadowGroups[index],drawn=visibleProxies(group);
      assert.equal(drawn.length,2);assert.ok(drawn.every(proxy=>!!proxy.userData.shadowRegionProxy===(index===1)));
      assert.ok(drawn.every(proxy=>proxy.castShadow));calls.push(index);
    },shadow,f.lights,f.scene,camera));
    assert.deepEqual(calls,[0,1]);assertRestored(beauty);shadowSaved.forEach(assertRestored);
    assert.ok(f.culler.compactRenderStatistics.passes[1].skippedChildren>0);
    assert.ok(f.culler.compactRenderStatistics.passes[2].skippedChildren>0);
  }finally{f.close();}
});

test('repeated cached strips preserve region sibling order and restore after native failure',()=>{
  const f=fixture(),shadow={enabled:true,autoUpdate:false,needsUpdate:true,type:THREE.PCFShadowMap};
  try{
    const recorded=[];f.culler.shadowPassDispatcher=(index,_light,group,draw)=>{
      if(index)return;
      for(const region of [box(-1,1.5),box(2.5,4.5)])f.culler.withShadowRegion(0,region,()=>{
        const expected=visibleProxies(group);recorded.push(expected);draw();
      });
    };
    let drawIndex=0;f.culler.renderShadowPasses(()=>{
      assert.deepEqual(visibleProxies(f.culler.shadowGroups[0]),recorded[drawIndex++]);
    },shadow,f.lights,f.scene,new THREE.PerspectiveCamera());
    assert.equal(drawIndex,2);
    const saved=f.culler.shadowGroups.map(snapshot),beauty=snapshot(f.culler.beautyGroup);
    shadow.needsUpdate=true;
    assert.throws(()=>f.culler.withCompactBeauty(()=>f.culler.renderShadowPasses(()=>{throw Error('GPU draw failed');},shadow,f.lights,f.scene,new THREE.PerspectiveCamera())),/GPU draw failed/);
    saved.forEach(assertRestored);assertRestored(beauty);
    assert.ok(f.culler.shadowGroups.every(group=>!group.visible));
    assert.ok(f.culler.shadowGroups.flatMap(visibleProxies).every(proxy=>!proxy.userData.shadowRegionProxy));
  }finally{f.close();}
});

test('source removal cannot leave a detached selected proxy in native traversal',()=>{
  const f=fixture();
  try{
    f.culler.removeSources([f.sources[0]]);
    f.culler.withCompactBeauty(()=>assert.equal(visibleProxies(f.culler.beautyGroup).length,1));
    f.prepare();f.culler.withCompactBeauty(()=>assert.equal(visibleProxies(f.culler.beautyGroup).length,1));
  }finally{f.close();}
});

test('selected-pass wrapper receives beauty, ordinary shadows and deferred-region selections',()=>{
  const f=fixture(),shadow={enabled:true,autoUpdate:true,needsUpdate:false,type:THREE.PCFShadowMap};
  const calls=[],value={rendered:true};
  try{
    f.culler.deferredShadowPasses.add(1);f.prepare();
    f.culler.renderSelectedPass=(root,selected,pass,draw)=>{
      assert.equal(root,[f.culler.beautyGroup,...f.culler.shadowGroups][pass]);
      assert.equal(selected.length,2);
      assert.ok(selected.every(proxy=>proxy.visible&&proxy.count>0));
      assert.ok(selected.every(proxy=>!!proxy.userData.shadowRegionProxy===(pass===2)));
      assert.deepEqual([...selected],visibleProxies(root));
      calls.push(pass);return draw();
    };
    const actual=f.culler.withCompactBeauty(()=>{
      f.culler.renderShadowPasses(()=>{},shadow,f.lights,f.scene,new THREE.PerspectiveCamera());return value;
    });
    assert.equal(actual,value);assert.deepEqual(calls,[0,1,2]);
    f.culler.compactRenderLists=false;
    assert.equal(f.culler.withCompactBeauty(()=>value),value);assert.equal(calls.length,3);
    f.culler.compactRenderLists=true;f.culler.disable();
    assert.equal(f.culler.withCompactBeauty(()=>value),value);assert.equal(calls.length,3);
  }finally{f.close();}
});

test('selected-pass wrapper can restore temporary lists after nested shadow draw failures',()=>{
  const f=fixture(),shadow={enabled:true,autoUpdate:true,needsUpdate:false,type:THREE.PCFShadowMap};
  try{
    const saved=[f.culler.beautyGroup,...f.culler.shadowGroups].map(snapshot),active=[];
    f.culler.renderSelectedPass=(root,selected,pass,draw)=>{
      const children=root.children;root.children=[...selected];active.push(pass);
      try{return draw();}finally{assert.equal(active.pop(),pass);root.children=children;}
    };
    assert.throws(()=>f.culler.withCompactBeauty(()=>f.culler.renderShadowPasses(()=>{
      assert.deepEqual(active,[0,1]);throw Error('draw interrupted');
    },shadow,f.lights,f.scene,new THREE.PerspectiveCamera())),/draw interrupted/);
    assert.deepEqual(active,[]);saved.forEach(assertRestored);
    assert.ok(f.culler.shadowGroups.every(group=>!group.visible));
    f.culler.renderSelectedPass=undefined;
    f.culler.withCompactBeauty(()=>assert.equal(visibleProxies(f.culler.beautyGroup).length,2));
    assert.ok(f.culler.compactRenderStatistics.passes[0].skippedChildren>0,'Removing wrapper restores normal compact traversal');
  }finally{f.close();}
});

test('alternating spatial cells retain registration order when inherited order groups are created or changed',()=>{
  const scene=new THREE.Scene(),world=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
  world.renderOrder=8;scene.add(world);
  const sources=Array.from({length:4},(_,index)=>{
    const source=new THREE.InstancedMesh(geometry,material,1);source.castShadow=true;source.name=`alternating ${index}`;
    source.userData.spatialCell=index%2?'B':'A';source.setMatrixAt(0,new THREE.Matrix4());world.add(source);return source;
  });
  scene.updateMatrixWorld(true);
  const culler=new PassInstanceCuller(sources,1),light=new THREE.DirectionalLight(),passes=[{light,frustum:box()}];
  scene.add(culler.beautyGroup,...culler.shadowGroups);
  const expected=sources.map(source=>source.id);
  const orderOf=root=>{
    const result=[];root.traverse(object=>{if(object instanceof THREE.InstancedMesh&&object.visible)result.push(object.userData.canonicalSourceId);});return result;
  };
  try{
    for(const groupOrder of [8,19,0,8]){
      world.renderOrder=groupOrder;scene.updateMatrixWorld(true);culler.prepare(box(),passes);culler.enable();
      assert.deepEqual(orderOf(culler.beautyGroup),expected,`beauty order at inherited order ${groupOrder}`);
      assert.deepEqual(orderOf(culler.shadowGroups[0]),expected,`shadow order at inherited order ${groupOrder}`);
      culler.withCompactBeauty(()=>assert.deepEqual(orderOf(culler.beautyGroup),expected));
      culler.renderShadowPasses(()=>assert.deepEqual(orderOf(culler.shadowGroups[0]),expected),
        {enabled:true,autoUpdate:true,needsUpdate:false,type:THREE.PCFShadowMap},[light],scene,new THREE.PerspectiveCamera());
    }
  }finally{culler.dispose();sources.forEach(source=>source.dispose());geometry.dispose();material.dispose();}
});
