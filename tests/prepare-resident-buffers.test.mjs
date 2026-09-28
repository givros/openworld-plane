import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {prepareResidentBuffers} from '../src/core/prepareResidentBuffers.ts';

function fixture(){
  const target={},events=[],uploads=[],textures=[];
  let active=target,face=2,level=1,lost=false,failRender=false,wait=false,viewport=new THREE.Vector4(4,5,600,400),scissor=new THREE.Vector4(2,3,200,100),scissorTest=true;
  const gl={SYNC_GPU_COMMANDS_COMPLETE:1,ALREADY_SIGNALED:2,CONDITION_SATISFIED:3,WAIT_FAILED:4,TIMEOUT_EXPIRED:5,
    isContextLost:()=>lost,fenceSync:()=>{events.push('fence');return{};},flush:()=>events.push('flush'),
    clientWaitSync:()=>wait?gl.TIMEOUT_EXPIRED:gl.ALREADY_SIGNALED,deleteSync:()=>events.push('delete-fence')};
  const shadowRender=()=>{throw new Error('Live shadow renderer must not run');};
  const renderer={autoClear:true,sortObjects:true,xr:{enabled:true},shadowMap:{render:shadowRender},
    info:{autoReset:true,render:{frame:9,calls:8,triangles:12,points:4,lines:2}},getContext:()=>gl,
    getRenderTarget:()=>active,getActiveCubeFace:()=>face,getActiveMipmapLevel:()=>level,
    setRenderTarget(t,f=0,l=0){active=t;face=f;level=l;viewport.set(0,0,64,64);scissor.set(0,0,64,64);scissorTest=false;},
    getViewport:v=>v.copy(viewport),setViewport:v=>{viewport=v.clone();},getScissor:v=>v.copy(scissor),setScissor:v=>{scissor=v.clone();},
    getScissorTest:()=>scissorTest,setScissorTest:v=>{scissorTest=v;},
    initTexture(texture){textures.push(texture);},
    render(scene,camera){
      assert.equal(renderer.autoClear,false);assert.equal(renderer.sortObjects,false);assert.equal(renderer.xr.enabled,false);
      assert.equal(scene.matrixWorldAutoUpdate,false);assert.equal(scene.children.length,1);renderer.shadowMap.render([],scene,camera);
      const mesh=scene.children[0];assert.ok(mesh instanceof THREE.InstancedMesh);assert.equal(mesh.count,0);
      assert.equal(mesh.visible,true);assert.equal(mesh.frustumCulled,false);assert.ok(mesh.layers.test(camera.layers));
      assert.equal(mesh.children.length,0);assert.ok(mesh.material instanceof THREE.MeshBasicMaterial);
      mesh.onBeforeRender();mesh.onAfterRender();
      uploads.push({mesh,geometry:mesh.geometry,index:mesh.geometry.index,matrix:mesh.instanceMatrix});
      mesh.modelViewMatrix.makeTranslation(8,9,10);mesh.normalMatrix.set(2,0,0,0,2,0,0,0,2);
      renderer.info.render.frame++;renderer.info.render.calls++;renderer.info.render.triangles+=99;
      if(failRender)throw new Error('Upload failed');
    },
  };
  const assertRestored=()=>{
    assert.equal(renderer.autoClear,true);assert.equal(renderer.sortObjects,true);assert.equal(renderer.xr.enabled,true);
    assert.equal(renderer.shadowMap.render,shadowRender);assert.equal(renderer.info.autoReset,true);
    assert.equal(active,target);assert.equal(face,2);assert.equal(level,1);
    assert.deepEqual(viewport.toArray(),[4,5,600,400]);assert.deepEqual(scissor.toArray(),[2,3,200,100]);assert.equal(scissorTest,true);
    const {frame,...counts}=renderer.info.render;assert.deepEqual(counts,{calls:8,triangles:12,points:4,lines:2});assert.ok(frame>=9);
  };
  return{renderer,gl,events,uploads,textures,assertRestored,fail(){failRender=true;},lose(){lost=true;},wait(){wait=true;}};
}

function sources(){
  const geometry=new THREE.BoxGeometry(),texture=new THREE.Texture(),material=new THREE.MeshStandardMaterial({map:texture,normalMap:texture});
  const parent=new THREE.Group(),instance=new THREE.InstancedMesh(geometry,material,3),ordinary=new THREE.Mesh(geometry,[material]);
  const child=new THREE.Mesh(geometry,material);instance.add(child);parent.add(instance,ordinary);
  instance.visible=false;instance.layers.mask=0;instance.onBeforeRender=()=>{throw new Error('Source callback ran');};
  instance.onAfterRender=()=>{throw new Error('Source callback ran');};
  const before=instance.onBeforeRender,after=instance.onAfterRender,children=instance.children,modelView=instance.modelViewMatrix.clone(),normal=instance.normalMatrix.clone();
  const verify=()=>{
    assert.equal(instance.parent,parent);assert.equal(ordinary.parent,parent);assert.deepEqual(parent.children,[instance,ordinary]);
    assert.equal(instance.geometry,geometry);assert.equal(instance.material,material);assert.equal(instance.count,3);
    assert.equal(instance.visible,false);assert.equal(instance.frustumCulled,true);assert.equal(instance.layers.mask,0);
    assert.equal(instance.children,children);assert.deepEqual(instance.children,[child]);assert.equal(child.parent,instance);
    assert.equal(instance.onBeforeRender,before);assert.equal(instance.onAfterRender,after);
    assert.ok(instance.modelViewMatrix.equals(modelView));assert.ok(instance.normalMatrix.equals(normal));
  };
  return{geometry,texture,material,parent,instance,ordinary,verify};
}

test('warms actual instance buffers, shared indices and unique textures with no source draw-range mutation',async()=>{
  const f=fixture(),s=sources(),drawRange=s.geometry.drawRange;let disposed=0;
  s.geometry.addEventListener('dispose',()=>disposed++);s.material.addEventListener('dispose',()=>disposed++);s.texture.addEventListener('dispose',()=>disposed++);
  const metrics=await prepareResidentBuffers(f.renderer,[s.instance,s.instance,s.ordinary],new AbortController().signal);
  assert.equal(metrics.meshes,2);assert.equal(metrics.textures,1);assert.equal(metrics.geometries,1);assert.equal(metrics.completed,3);assert.equal(metrics.total,3);assert.equal(metrics.stage,'complete');
  assert.equal(metrics.bufferBytes,Object.values(s.geometry.attributes).reduce((sum,attribute)=>sum+attribute.array.byteLength,0)+s.geometry.index.array.byteLength+s.instance.instanceMatrix.array.byteLength);
  assert.deepEqual(f.textures,[s.texture]);assert.equal(f.uploads[0].mesh,s.instance);assert.equal(f.uploads[0].matrix,s.instance.instanceMatrix);
  assert.notEqual(f.uploads[1].mesh,s.ordinary);assert.equal(f.uploads[1].geometry,s.geometry);assert.equal(f.uploads[1].index,s.geometry.index);
  assert.equal(s.geometry.drawRange,drawRange);assert.equal(drawRange.count,Infinity);assert.equal(disposed,0);
  assert.deepEqual(f.events,['fence','flush','delete-fence']);assert.equal(f.renderer.info.render.frame,11);s.verify();f.assertRestored();
});

test('render failures restore every borrowed object and renderer field',async()=>{
  const f=fixture(),s=sources();f.fail();
  await assert.rejects(prepareResidentBuffers(f.renderer,[s.instance],new AbortController().signal),/Upload failed/);
  s.verify();f.assertRestored();assert.equal(f.events.includes('fence'),false);
});

test('cancellation during asynchronous completion releases the fence and leaves the live scene intact',async()=>{
  const f=fixture(),s=sources(),controller=new AbortController();f.wait();
  const pending=prepareResidentBuffers(f.renderer,[s.instance],controller.signal);
  setTimeout(()=>controller.abort(),2);
  await assert.rejects(pending,error=>error.name==='AbortError');
  assert.ok(f.events.includes('delete-fence'));s.verify();f.assertRestored();
});

test('a slice boundary exposes only restored source and renderer state',async()=>{
  const f=fixture(),s=sources(),all=Array.from({length:20},()=>new THREE.InstancedMesh(s.geometry,s.material,1));let sawSlice=false;
  const metrics=await prepareResidentBuffers(f.renderer,all,new AbortController().signal,snapshot=>{
    f.assertRestored();for(const mesh of all)assert.equal(mesh.count,1);
    if(snapshot.completed>0&&snapshot.completed<snapshot.total)sawSlice=true;
  });
  assert.equal(sawSlice,true);assert.ok(metrics.slices>0);assert.equal(metrics.meshes,20);
});

test('context loss and observer failure reject instead of reporting a prepared world',async()=>{
  const f=fixture(),s=sources();f.lose();
  await assert.rejects(prepareResidentBuffers(f.renderer,[s.instance],new AbortController().signal),/context was lost/);
  const other=fixture();
  await assert.rejects(prepareResidentBuffers(other.renderer,[s.instance],new AbortController().signal,()=>{throw new Error('Progress failed');}),/Progress failed/);
  s.verify();other.assertRestored();
});

test('buffer accounting deduplicates actual GPU owners including interleaved attribute storage',async()=>{
  const f=fixture(),geometry=new THREE.BufferGeometry(),data=new THREE.InterleavedBuffer(new Float32Array(18),6);
  geometry.setAttribute('position',new THREE.InterleavedBufferAttribute(data,3,0));
  geometry.setAttribute('normal',new THREE.InterleavedBufferAttribute(data,3,3));
  geometry.setIndex([0,1,2]);
  const material=new THREE.MeshBasicMaterial(),a=new THREE.InstancedMesh(geometry,material,2),b=new THREE.InstancedMesh(geometry,material,2);
  const color=new THREE.InstancedBufferAttribute(new Float32Array(6),3);a.instanceColor=color;b.instanceColor=color;
  const result=await prepareResidentBuffers(f.renderer,[a,b],new AbortController().signal);
  assert.equal(result.bufferBytes,data.array.byteLength+geometry.index.array.byteLength+a.instanceMatrix.array.byteLength+b.instanceMatrix.array.byteLength+color.array.byteLength);
});
