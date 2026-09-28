import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/systems/Atmosphere.ts';
import { ShadowReceiverBounds } from '../src/systems/ShadowCasterVolume.ts';

test('streamed shadow receivers follow chunk commits and dynamic aircraft without rescanning unchanged static geometry',()=>{
  const scene=new THREE.Scene(),world=new THREE.Group(),camera=new THREE.PerspectiveCamera(48,1.6,.15,304);
  scene.fog=new THREE.Fog('#ffffff',150,300);scene.add(world);
  const geometry=new THREE.BoxGeometry(4,8,6),material=new THREE.MeshStandardMaterial();
  const tree=new THREE.Mesh(geometry,material);tree.position.set(10,4,-30);tree.receiveShadow=true;world.add(tree);
  const plane=new THREE.Mesh(geometry,material);plane.receiveShadow=true;plane.position.set(0,40,0);scene.add(plane);
  const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true}},camera);let revision=1;
  atmosphere.setStaticWorld(world,()=>revision);atmosphere.setViewDistance(304);
  const reference=new ShadowReceiverBounds();
  try{
    const compare=()=>{
      atmosphere.prepareRender();
      const actual=atmosphere.combinedReceiverBounds.clone();
      scene.updateMatrixWorld(true);
      assert.deepEqual(actual,reference.update(scene).clone());
    };
    compare();const unchangedFrame=atmosphere.staticReceiverBounds.frame;
    plane.position.set(30,80,-10);compare();
    assert.equal(atmosphere.staticReceiverBounds.frame,unchangedFrame);
    const building=new THREE.Mesh(geometry,material);building.position.set(90,20,40);building.receiveShadow=true;world.add(building);revision++;
    compare();assert.equal(atmosphere.staticReceiverBounds.frame,unchangedFrame+1);
    tree.removeFromParent();revision++;compare();
    world.position.x=25;compare();
    building.removeFromParent();revision++;compare();
  }finally{atmosphere.dispose();geometry.dispose();material.dispose();}
});

test('limited visibility retains four full-resolution cascades and registers newly loaded materials',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1.6,.15,304);
  scene.fog=new THREE.Fog('#ffffff',150,300);
  const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true},capabilities:{getMaxAnisotropy:()=>16}},camera);
  const material=new THREE.MeshStandardMaterial({normalMap:new THREE.Texture()});
  try{
    atmosphere.setViewDistance(304);atmosphere.registerMaterials([material]);
    assert.equal(atmosphere.canCullInstanceMaterial(material),true);
    const compile=material.onBeforeCompile;atmosphere.registerMaterials([material]);assert.equal(material.onBeforeCompile,compile);
    atmosphere.update(0,new THREE.Vector3(0,80,0),80);
    assert.equal(material.normalMap.anisotropy,16);
    assert.equal(atmosphere.sunlight.lights.length,4);
    for(const light of atmosphere.sunlight.lights)assert.deepEqual(light.shadow.mapSize.toArray(),[4096,4096]);
    assert.equal(scene.fog,null,'landscape fog stays disabled without a URL flag');
    assert.deepEqual(atmosphere.sunlight.breaks,[.12,.32,.62,1]);
    assert.equal(atmosphere.sunlight.maxFar,304);
  }finally{material.normalMap.dispose();material.dispose();atmosphere.dispose();}
});
