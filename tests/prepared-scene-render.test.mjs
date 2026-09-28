import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {renderSceneWithPreparedMatrices} from '../src/core/renderSceneWithPreparedMatrices.ts';
import {Atmosphere} from '../src/systems/Atmosphere.ts';
import {FlightVfx} from '../src/systems/FlightVfx.ts';
import {ManualFlightController} from '../src/systems/ManualFlightController.ts';

test('prepared draw skips only the renderer matrix traversal and restores its flag on errors',()=>{
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();let updates=0,renders=0;
 const update=scene.updateMatrixWorld.bind(scene);scene.updateMatrixWorld=()=>{updates++;update();};
 const renderer={render(s,c){renders++;if(s.matrixWorldAutoUpdate)s.updateMatrixWorld();assert.equal(c,camera);}};
 renderer.render(scene,camera);assert.equal(updates,1);
 renderSceneWithPreparedMatrices(renderer,scene,camera);assert.equal(updates,1);assert.equal(renders,2);assert.equal(scene.matrixWorldAutoUpdate,true);
 assert.throws(()=>renderSceneWithPreparedMatrices({render(){throw Error('draw failed');}},scene,camera),/draw failed/);
 assert.equal(scene.matrixWorldAutoUpdate,true);
 scene.matrixWorldAutoUpdate=false;renderSceneWithPreparedMatrices(renderer,scene,camera);assert.equal(scene.matrixWorldAutoUpdate,false);
});

test('post-presentation preparation preserves real atmosphere, lights, clouds and VFX at draw time',()=>{
 const documentBefore=globalThis.document;
 globalThis.document={createElement(){return{width:0,height:0,getContext(){return{createRadialGradient(){return{addColorStop(){}};},fillRect(){}};}};}};
 function run(prepared){
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1.6,.15,16000);
  scene.fog=new THREE.Fog('#fff',100,6000);
  const ground=new THREE.Mesh(new THREE.BoxGeometry(1000,2,1000),new THREE.MeshStandardMaterial());ground.receiveShadow=true;scene.add(ground);
  const aircraft=new THREE.Group();scene.add(aircraft);
  const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true}},camera),vfx=new FlightVfx(()=>0);scene.add(vfx.root);
  const state=new ManualFlightController(()=>0).state;
  const frames=[];let traversals=0;
  const update=scene.updateMatrixWorld.bind(scene);scene.updateMatrixWorld=(...args)=>{traversals++;return update(...args);};
  const renderer={render(s,c){
   // This matches WebGLRenderer's matrix-preparation order without a GPU.
   if(s.matrixWorldAutoUpdate)s.updateMatrixWorld();
   if(c.parent===null&&c.matrixWorldAutoUpdate)c.updateMatrixWorld();
   atmosphere.sunlight.lights.forEach(light=>light.shadow.updateMatrices(light));
   const objects=[];s.traverse(object=>{objects.push({name:object.name,type:object.type,matrix:object.matrixWorld.toArray(),visible:object.visible});});
   frames.push({objects,camera:c.matrixWorld.toArray(),clouds:Array.from(atmosphere.clouds.instanceMatrix.array),
    particles:[vfx.smoke,vfx.dust].map(pool=>Object.fromEntries(Object.entries(pool.mesh.geometry.attributes).map(([key,attribute])=>[key,Array.from(attribute.array)]))),
    trails:vfx.trails.map(line=>({positions:Array.from(line.geometry.attributes.position.array),range:{...line.geometry.drawRange},visible:line.visible})),
    fog:s.fog,
    shadows:atmosphere.sunlight.lights.map(light=>({matrix:light.shadow.matrix.toArray(),camera:light.shadow.camera.matrixWorld.toArray(),projection:light.shadow.camera.projectionMatrix.toArray()})),
    volumes:atmosphere.casterVolumes.map(volume=>({empty:volume.empty,planes:volume.planes.map(plane=>[...plane.normal.toArray(),plane.constant])})),
   });
  }};
  try{
   for(let i=0;i<18;i++){
    const dt=i%3===0?.1:1/60;
    state.position.set(i*4,i<6?0:(i-5)*3,-i*2);state.altitude=state.position.y;state.grounded=i<6;state.rpm=2200;state.speed=30;
    aircraft.position.copy(state.position);aircraft.rotation.set(.02*i,.08*i,-.01*i);aircraft.updateMatrixWorld(true);
    camera.position.set(i*4-40,50+i*2,80-i);camera.lookAt(state.position);camera.fov=40+i;camera.updateProjectionMatrix();
    atmosphere.update(dt,state.position,state.altitude,!prepared);
    vfx.update(dt,state,aircraft);
    if(prepared){atmosphere.prepareRender();renderSceneWithPreparedMatrices(renderer,scene,camera);}
    else renderer.render(scene,camera);
   }
   return{frames,traversals};
  }finally{vfx.dispose();atmosphere.dispose();ground.geometry.dispose();ground.material.dispose();}
 }
 try{
  const baseline=run(false),prepared=run(true);
  assert.deepEqual(prepared.frames,baseline.frames);
  assert.equal(baseline.traversals,36);assert.equal(prepared.traversals,18);
  assert.ok(prepared.frames.some(frame=>frame.particles.some(attributes=>attributes.alpha.some(alpha=>alpha>0))));
  assert.ok(prepared.frames.some(frame=>frame.trails.some(trail=>trail.range.count>0)));
 }finally{if(documentBefore===undefined)delete globalThis.document;else globalThis.document=documentBefore;}
});
