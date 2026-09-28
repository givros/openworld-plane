import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShadowReceiverBounds } from '../src/systems/ShadowReceiverBounds.ts';

function fixture(){
  const scene=new THREE.Scene(),parent=new THREE.Group(),geometry=new THREE.BoxGeometry(2,4,6),material=new THREE.MeshStandardMaterial();
  const mesh=new THREE.Mesh(geometry,material);mesh.receiveShadow=true;parent.add(mesh);scene.add(parent);
  const bounds=new ShadowReceiverBounds();
  const read=()=>{scene.updateMatrixWorld(true);const box=bounds.update(scene);return [box.min.toArray(),box.max.toArray()];};
  const dispose=()=>{geometry.dispose();material.dispose();};
  return {scene,parent,geometry,material,mesh,bounds,read,dispose};
}

test('cached receiver boxes follow parent movement, visibility, membership and displacement',()=>{
  const f=fixture();
  try{
    assert.deepEqual(f.read(),[[-3,-4,-5],[3,4,5]]);
    assert.deepEqual(f.read(),[[-3,-4,-5],[3,4,5]]);
    f.parent.position.set(10,20,30);assert.deepEqual(f.read(),[[7,16,25],[13,24,35]]);
    f.material.displacementMap=new THREE.Texture();f.material.displacementScale=3;f.material.displacementBias=-1;
    assert.deepEqual(f.read(),[[3,12,21],[17,28,39]]);
    f.material.displacementScale=7;assert.deepEqual(f.read(),[[-1,8,17],[21,32,43]]);
    f.material.displacementMap.dispose();f.material.displacementMap=null;
    assert.deepEqual(f.read(),[[7,16,25],[13,24,35]]);
    for(const disable of ['hidden','no-shadow','removed']){
      if(disable==='hidden')f.parent.visible=false;
      if(disable==='no-shadow')f.mesh.receiveShadow=false;
      if(disable==='removed')f.mesh.removeFromParent();
      f.read();assert.ok(f.bounds.bounds.isEmpty(),disable);
      f.parent.visible=true;f.mesh.receiveShadow=true;f.parent.add(f.mesh);
      assert.deepEqual(f.read(),[[7,16,25],[13,24,35]]);
    }
  }finally{f.dispose();}
});

test('cached shared geometry reacts to edited, replaced and interleaved position buffers',()=>{
  const f=fixture();
  try{
    f.read();const position=f.geometry.getAttribute('position');
    for(let i=0;i<position.count;i++)position.setX(i,position.getX(i)*3);
    position.needsUpdate=true;assert.deepEqual(f.read(),[[-5,-4,-5],[5,4,5]]);
    position.array=Float32Array.from(position.array,(value,index)=>index%3===0?value*2:value);
    assert.deepEqual(f.read(),[[-8,-4,-5],[8,4,5]]);
    const data=new THREE.InterleavedBuffer(new Float32Array([-8,-2,-3,99,8,2,3,99]),4);
    f.geometry.setAttribute('position',new THREE.InterleavedBufferAttribute(data,3,0));
    assert.deepEqual(f.read(),[[-10,-4,-5],[10,4,5]]);
    data.array[0]=-20;data.needsUpdate=true;assert.deepEqual(f.read(),[[-22,-4,-5],[10,4,5]]);
    f.geometry.morphAttributes.position=[new THREE.Float32BufferAttribute([-30,-2,-3,30,2,3],3)];
    assert.deepEqual(f.read(),[[-32,-4,-5],[32,4,5]]);
    f.geometry.morphAttributes.position=[];assert.deepEqual(f.read(),[[-22,-4,-5],[10,4,5]]);
  }finally{f.dispose();}
});

test('cached instanced receivers follow source edits, instance matrices, counts and replacements',()=>{
  const f=fixture(),instances=new THREE.InstancedMesh(f.geometry,f.material,2);instances.receiveShadow=true;
  f.mesh.removeFromParent();f.parent.add(instances);
  try{
    instances.setMatrixAt(0,new THREE.Matrix4().makeTranslation(0,0,0));
    instances.setMatrixAt(1,new THREE.Matrix4().makeTranslation(20,0,0));
    assert.deepEqual(f.read(),[[-3,-4,-5],[23,4,5]]);
    instances.setMatrixAt(1,new THREE.Matrix4().makeTranslation(40,0,0));instances.instanceMatrix.needsUpdate=true;
    assert.deepEqual(f.read(),[[-3,-4,-5],[43,4,5]]);
    instances.count=1;assert.deepEqual(f.read(),[[-3,-4,-5],[3,4,5]]);
    instances.instanceMatrix=instances.instanceMatrix.clone();instances.setMatrixAt(0,new THREE.Matrix4().makeTranslation(5,0,0));
    assert.deepEqual(f.read(),[[2,-4,-5],[8,4,5]]);
    const originalArray=instances.instanceMatrix.array;
    instances.instanceMatrix.array=originalArray.slice();instances.instanceMatrix.array[12]=10;
    assert.deepEqual(f.read(),[[7,-4,-5],[13,4,5]]);
    instances.instanceMatrix.array=originalArray;assert.deepEqual(f.read(),[[2,-4,-5],[8,4,5]]);
    f.geometry.scale(2,2,2);assert.deepEqual(f.read(),[[1,-6,-8],[9,6,8]]);
    f.parent.scale.set(2,1,1);assert.deepEqual(f.read(),[[4,-6,-8],[16,6,8]]);
  }finally{instances.dispose();f.dispose();}
});
