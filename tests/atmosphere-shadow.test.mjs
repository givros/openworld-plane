import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/systems/Atmosphere.ts';
import { FlightSequence } from '../src/systems/FlightSequence.ts';
import { CinematicCamera } from '../src/systems/CinematicCamera.ts';

test('sun illumination agrees with the visible sky',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1.6,.15,16000);
  const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true}},camera);
  try{
    assert.ok(atmosphere.sunlight.lightDirection.clone().negate().distanceTo(
      new THREE.Vector3(-.48,.58,-.65).normalize())<1e-12);
  }finally{atmosphere.dispose();}
});

test('CSM transition-edge receivers remain inside the contributing map after projection changes',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1.6,.15,16000);
  scene.fog=new THREE.Fog('#ffffff',100,6000);
  const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true}},camera);
  const csm=atmosphere.sunlight;
  let checked=0;
  try{
    for(const fov of [42,48,70])for(const aspect of [1.3,1.6,2])
      for(const pitch of [0,-.25,-.7,-1.2])for(const yaw of [0,.5,1,1.5,2,2.5,3]){
        camera.fov=fov;camera.aspect=aspect;camera.updateProjectionMatrix();
        camera.position.set(100,180,0);camera.rotation.set(pitch,yaw,0,'YXZ');
        atmosphere.update(0,new THREE.Vector3(100,180,0),180);
        scene.updateMatrixWorld(true);csm.lights.forEach(light=>light.shadow.updateMatrices(light));
        for(let cascade=0;cascade<3;cascade++){
          const edge=[100,450,1700][cascade];
          const fadeMargin=.25*(edge/6000)**2*6000;
          // This sample has nonzero CSM shader weight just beyond its nominal
          // cascade. The upstream max/min mismatch used to miss some corners.
          const depth=edge+fadeMargin*.4;
          for(const x of [-1,1])for(const y of [-1,1]){
            const point=new THREE.Vector3(x*depth*Math.tan(fov*Math.PI/360)*aspect,
              y*depth*Math.tan(fov*Math.PI/360),-depth)
              .applyMatrix4(camera.matrixWorld).applyMatrix4(csm.lights[cascade].shadow.matrix);
            assert.ok(point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1,
              `cascade=${cascade}, fov=${fov}, aspect=${aspect}, pitch=${pitch}, yaw=${yaw}`);
            checked++;
          }
        }
      }
    assert.equal(checked,3024);
  }finally{atmosphere.dispose();}
});

test('deferred review preparation preserves final atmosphere and shadow coverage at every cinematic shot',()=>{
  function run(deferred){
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1.6,.15,16000);
    scene.fog=new THREE.Fog('#ffffff',100,6000);
    const material=new THREE.MeshStandardMaterial(),geometry=new THREE.BoxGeometry(8,3,10);
    const aircraft=new THREE.Mesh(geometry,material);aircraft.receiveShadow=true;scene.add(aircraft);
    const ground=new THREE.Mesh(new THREE.BoxGeometry(3200,3,3200),material);
    ground.position.y=-1.5;ground.receiveShadow=true;scene.add(ground);
    const trees=new THREE.InstancedMesh(geometry,material,3);trees.receiveShadow=true;
    for(let i=0;i<3;i++)trees.setMatrixAt(i,new THREE.Matrix4().makeTranslation(30+i*25,8,-160+i*85));
    trees.instanceMatrix.needsUpdate=true;scene.add(trees);
    const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true}},camera);
    const sequence=new FlightSequence(()=>0);sequence.start();const cinematic=new CinematicCamera(camera);
    const prepare=atmosphere.prepareRender.bind(atmosphere);let preparations=0,steps=0;
    atmosphere.prepareRender=()=>{preparations++;prepare();};
    const views=[];
    try{
      for(const time of [12,21,40.5,42.2,48,55.2]){
        let remaining=time-sequence.state.elapsed;
        while(remaining>1e-9){
          const dt=Math.min(remaining,1/120);sequence.update(dt);steps++;
          const state=sequence.state;
          aircraft.position.copy(state.position);aircraft.rotation.set(-state.pitch,state.yaw,state.bank,'YXZ');
          aircraft.updateMatrixWorld(true);cinematic.update(dt,state);
          atmosphere.update(dt,state.position,state.altitude,!deferred);remaining-=dt;
        }
        if(deferred)atmosphere.prepareRender();
        scene.updateMatrixWorld(true);
        atmosphere.sunlight.lights.forEach(light=>light.shadow.updateMatrices(light));
        views.push({
          elapsed:sequence.state.elapsed,phase:sequence.state.phase,shot:cinematic.shot,
          aircraft:aircraft.matrixWorld.toArray(),camera:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray(),
          sky:atmosphere.sky.matrixWorld.toArray(),root:atmosphere.root.matrixWorld.toArray(),
          clouds:Array.from(atmosphere.clouds.instanceMatrix.array),fog:scene.fog,
          receiverBounds:[...atmosphere.receiverBounds.bounds.min.toArray(),...atmosphere.receiverBounds.bounds.max.toArray()],
          shadows:atmosphere.sunlight.lights.map(light=>({matrix:light.shadow.matrix.toArray(),projection:light.shadow.camera.projectionMatrix.toArray(),light:light.matrixWorld.toArray(),target:light.target.matrixWorld.toArray()})),
          volumes:atmosphere.casterVolumes.map(volume=>({empty:volume.empty,enabled:volume.enabled,planes:volume.planes.map(plane=>[...plane.normal.toArray(),plane.constant])})),
        });
      }
      return {views,preparations,steps};
    }finally{atmosphere.dispose();trees.dispose();geometry.dispose();ground.geometry.dispose();material.dispose();}
  }
  const ordinary=run(false),deferred=run(true);
  assert.equal(ordinary.preparations,ordinary.steps);assert.equal(ordinary.steps,6624);
  assert.equal(deferred.steps,ordinary.steps);assert.equal(deferred.preparations,6);
  assert.deepEqual(deferred.views,ordinary.views);
});
