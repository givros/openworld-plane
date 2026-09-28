import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {PrecomposedShadowMatrixWriter,createPrecomposedShadowDepth,supportsPrecomposedShadowMatrices} from '../src/experiments/PrecomposedShadowMatrices.ts';

test('precomposed shadows preserve selection order, source buffers, and transformed geometry within float rounding',()=>{
  const camera=new THREE.OrthographicCamera(-230,230,180,-180,1,10000);
  camera.position.set(720,900,-1000);camera.lookAt(30,15,0);camera.updateMatrixWorld();
  const model=new THREE.Matrix4().compose(new THREE.Vector3(150,-20,380),new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,-.6,.1)),new THREE.Vector3(1.5,.7,2));
  const sources=new Float32Array(48);
  for(let i=0;i<3;i++)new THREE.Matrix4().compose(new THREE.Vector3(i*37,-i*5,13),new THREE.Quaternion().setFromEuler(new THREE.Euler(.1*i,.23*i,-.17*i)),new THREE.Vector3(i===1?-2:1,.5,1.3)).toArray(sources,i*16);
  const original=new Float32Array(sources),target=new Float32Array(48).fill(1234),writer=new PrecomposedShadowMatrixWriter();
  writer.setTransform(camera.projectionMatrix,camera.matrixWorldInverse,model);writer.writeSelected(sources,new Uint32Array([2,0]),2,target);
  const modelView=new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse,model);modelView.elements=modelView.elements.map(Math.fround);
  const projection=camera.projectionMatrix.clone();projection.elements=projection.elements.map(Math.fround);
  for(const [slot,id]of [2,0].entries())for(const values of [[0,0,0,1],[4,7,-2,1],[-9,1,11,1]]){
    const expected=new THREE.Vector4(...values).applyMatrix4(new THREE.Matrix4().fromArray(sources,id*16)).applyMatrix4(modelView).applyMatrix4(projection);
    const actual=new THREE.Vector4(...values).applyMatrix4(new THREE.Matrix4().fromArray(target,slot*16));
    for(const axis of ['x','y','z','w'])assert.ok(Math.abs(expected[axis]-actual[axis])<2e-6,`${axis}: ${expected[axis]} != ${actual[axis]}`);
  }
  assert.deepEqual(sources,original);assert.deepEqual([...target.slice(32)],new Array(16).fill(1234));
});

test('writer recomputes camera-dependent matrices from canonical input and rejects unsafe writes',()=>{
  const writer=new PrecomposedShadowMatrixWriter(),identity=new THREE.Matrix4(),source=new Float32Array(identity.elements),target=new Float32Array(16);
  assert.throws(()=>writer.writeSelected(source,[0],1,target),/Configure/);
  writer.setTransform(identity,identity,identity);writer.writeSelected(source,[0],1,target);assert.deepEqual(target,source);
  writer.setTransform(identity,new THREE.Matrix4().makeTranslation(2,3,4),identity);writer.writeSelected(source,[0],1,target);assert.equal(target[12],2);assert.equal(target[13],3);
  assert.throws(()=>writer.writeSelected(source,[1],1,target),/out of range/);
  assert.throws(()=>writer.writeSelected(source,[0],1,source),/alias/);
  assert.throws(()=>writer.writeSelected(source,[0],2,target),/capacity/);
  const invalid=identity.clone();invalid.elements[4]=Infinity;assert.throws(()=>writer.setTransform(invalid,identity,identity),/finite/);
  assert.throws(()=>writer.writeSelected(source,[0],1,target),/Configure/);
});

test('precomposed material retains native depth packing while eliminating per-vertex model-view/projection products',()=>{
  const material=createPrecomposedShadowDepth(),shader={vertexShader:THREE.ShaderLib.depth.vertexShader,fragmentShader:THREE.ShaderLib.depth.fragmentShader};
  material.onBeforeCompile(shader,{});
  assert.ok(!shader.vertexShader.includes('#include <project_vertex>'));
  assert.match(shader.vertexShader,/gl_Position = mvPosition/);
  assert.match(shader.vertexShader,/instanceMatrix \* vec4\( transformed, 1\.0 \)/);
  assert.match(shader.vertexShader,/vHighPrecisionZW = gl_Position\.zw/);
  assert.ok(!shader.fragmentShader.includes('#include <logdepthbuf_fragment>'));
  assert.match(shader.fragmentShader,/#if DEPTH_PACKING == 3200/);
  assert.throws(()=>material.onBeforeCompile({vertexShader:'changed',fragmentShader:'changed'},{}),/Review/);
  material.dispose();
});

test('eligibility rejects unsupported deformation, custom depth callbacks, projection, and clipping',()=>{
  const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial(),1),camera=new THREE.OrthographicCamera();
  assert.equal(supportsPrecomposedShadowMatrices(mesh,camera),true);
  assert.equal(supportsPrecomposedShadowMatrices(mesh,new THREE.PerspectiveCamera()),false);
  mesh.material.clippingPlanes=[new THREE.Plane()];assert.equal(supportsPrecomposedShadowMatrices(mesh,camera),false);mesh.material.clippingPlanes=null;
  mesh.onBeforeShadow=()=>{};assert.equal(supportsPrecomposedShadowMatrices(mesh,camera),false);mesh.onBeforeShadow=THREE.Object3D.prototype.onBeforeShadow;
  mesh.customDepthMaterial=new THREE.MeshDepthMaterial();assert.equal(supportsPrecomposedShadowMatrices(mesh,camera),false);mesh.customDepthMaterial.dispose();mesh.customDepthMaterial=undefined;
  mesh.geometry.morphAttributes.position=[mesh.geometry.attributes.position];assert.equal(supportsPrecomposedShadowMatrices(mesh,camera),false);
  mesh.geometry.dispose();mesh.material.dispose();mesh.dispose();
});
