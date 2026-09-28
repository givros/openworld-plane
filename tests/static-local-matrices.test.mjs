import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {freezeStaticLocalMatrices} from '../src/world/freezeStaticLocalMatrices.ts';

function fixture(){
 const scene=new THREE.Scene(),parent=new THREE.Group(),world=new THREE.Group(),region=new THREE.Group();
 scene.add(parent);parent.add(world);world.add(region);
 const geometry=new THREE.BoxGeometry(2,3,4),material=new THREE.MeshStandardMaterial();
 const fixed=new THREE.Mesh(geometry,material);fixed.matrixAutoUpdate=false;fixed.matrix.makeRotationY(.3).setPosition(4,2,7);
 const repeated=new THREE.InstancedMesh(geometry,material,2);repeated.position.set(10,4,-3);repeated.rotation.z=.1;
 repeated.setMatrixAt(0,new THREE.Matrix4().makeTranslation(1,2,3));repeated.setMatrixAt(1,new THREE.Matrix4().makeScale(2,.5,1.5));
 repeated.instanceMatrix.needsUpdate=true;region.add(fixed,repeated);scene.updateMatrixWorld(true);
 return{scene,parent,world,region,fixed,repeated,geometry,material,dispose(){geometry.dispose();material.dispose();repeated.dispose();}};
}

test('freezing static locals preserves source matrices and mutable parent/world placement',()=>{
 const original=fixture(),frozen=fixture();const before=Array.from(frozen.repeated.instanceMatrix.array);
 const restore=freezeStaticLocalMatrices(frozen.world);
 try{
  assert.equal(frozen.world.matrixAutoUpdate,true);assert.equal(frozen.region.matrixAutoUpdate,false);
  assert.equal(frozen.repeated.matrixAutoUpdate,false);assert.equal(frozen.repeated.matrixWorldAutoUpdate,true);
  for(let i=0;i<5;i++){
   for(const f of [original,frozen]){
    f.parent.position.set(i*5,12-i,-i*3);f.parent.rotation.set(.1*i,.2*i,-.05*i);f.parent.scale.set(1+i*.1,1.2,.8);
    f.world.position.set(9-i,2*i,-11);f.world.rotation.y=.17*i;f.scene.updateMatrixWorld(i%2===0);
   }
   for(const key of ['parent','world','region','fixed','repeated'])assert.deepEqual(frozen[key].matrixWorld.elements,original[key].matrixWorld.elements,key);
  }
  assert.deepEqual(Array.from(frozen.repeated.instanceMatrix.array),before);
  assert.equal(frozen.fixed.matrixAutoUpdate,false);restore();restore();
  assert.equal(frozen.repeated.matrixAutoUpdate,true);assert.equal(frozen.region.matrixAutoUpdate,true);assert.equal(frozen.fixed.matrixAutoUpdate,false);
 }finally{restore();original.dispose();frozen.dispose();}
});

test('explicit static local edits and newly added dynamic children still update normally',()=>{
 const f=fixture(),restore=freezeStaticLocalMatrices(f.world);
 try{
  f.repeated.position.set(-8,3,12);f.repeated.updateMatrix();f.scene.updateMatrixWorld();
  assert.deepEqual(f.repeated.matrixWorld.elements,new THREE.Matrix4().multiplyMatrices(f.region.matrixWorld,f.repeated.matrix).elements);
  const dynamic=new THREE.Object3D();f.region.add(dynamic);dynamic.position.x=23;f.scene.updateMatrixWorld();
  assert.equal(dynamic.matrixAutoUpdate,true);assert.equal(dynamic.matrixWorld.elements[12],23);
  dynamic.position.x=31;f.scene.updateMatrixWorld();assert.equal(dynamic.matrixWorld.elements[12],31);
  f.repeated.setMatrixAt(1,new THREE.Matrix4().makeTranslation(45,0,0));f.repeated.instanceMatrix.needsUpdate=true;
  const matrix=new THREE.Matrix4();f.repeated.getMatrixAt(1,matrix);assert.equal(matrix.elements[12],45);
 }finally{restore();f.dispose();}
});
