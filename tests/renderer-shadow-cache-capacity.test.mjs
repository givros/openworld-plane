import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Renderer } from '../src/core/Renderer.ts';
import { PassInstanceCuller } from '../src/world/PassInstanceCuller.ts';

/** In-memory depth attachments exercise the actual cache and renderer bridge
 * without a browser or GPU. Blits and clears retain their native pixel semantics.
 */
function depthRenderer(){
  const properties=new WeakMap(),buffers=new WeakMap();
  const gl={READ_FRAMEBUFFER:1,DRAW_FRAMEBUFFER:2,READ_FRAMEBUFFER_BINDING:3,DRAW_FRAMEBUFFER_BINDING:4,SCISSOR_TEST:5,DEPTH_BUFFER_BIT:6,NEAREST:7};
  let current=null,read=null,draw=null,scissor=false;
  const state={setScissorTest:value=>{scissor=value;},bindFramebuffer(kind,value){if(kind===gl.READ_FRAMEBUFFER)read=value;else draw=value;}};
  gl.getParameter=kind=>kind===gl.READ_FRAMEBUFFER_BINDING?read:draw;
  gl.isEnabled=()=>scissor;
  gl.blitFramebuffer=(x0,y0,x1,y1,tx0,ty0,tx1,ty1,mask,filter)=>{
    assert.equal(mask,gl.DEPTH_BUFFER_BIT);assert.equal(filter,gl.NEAREST);assert.equal(scissor,false);
    assert.equal(x1-x0,tx1-tx0);assert.equal(y1-y0,ty1-ty0);
    const source=buffers.get(read.target),destination=buffers.get(draw.target);
    for(let y=0;y<y1-y0;y++)for(let x=0;x<x1-x0;x++)destination[(ty0+y)*draw.target.width+tx0+x]=source[(y0+y)*read.target.width+x0+x];
  };
  const renderer={
    shadowMap:{type:THREE.PCFShadowMap,needsUpdate:false},capabilities:{maxTextureSize:8192},info:{render:{frame:0}},state,
    properties:{get:target=>properties.get(target)},getContext:()=>gl,
    getRenderTarget:()=>current,getActiveCubeFace:()=>0,getActiveMipmapLevel:()=>0,
    initRenderTarget(target){if(!properties.has(target)){properties.set(target,{__webglFramebuffer:{target}});buffers.set(target,new Float64Array(target.width*target.height).fill(NaN));}},
    setRenderTarget(target){current=target;read=draw=target?properties.get(target).__webglFramebuffer:null;scissor=target?.scissorTest??false;},
    clear(){if(!current)return;const rect=scissor?current.scissor:new THREE.Vector4(0,0,current.width,current.height),array=buffers.get(current);
      for(let y=rect.y;y<rect.y+rect.w;y++)for(let x=rect.x;x<rect.x+rect.z;x++)array[y*current.width+x]=Infinity;},
  };
  return{renderer,buffers};
}

test('renderer admits and reuses all three configured middle/far shadow caches without losing dynamic depth',()=>{
  const previousWindow=globalThis.window;globalThis.window={location:{search:'?middleShadowCache=1&cacheShadows=1'}};
  const scene=new THREE.Scene(),world=new THREE.Group(),culler=new PassInstanceCuller([],4),{renderer,buffers}=depthRenderer();
  scene.add(world,culler.beautyGroup,...culler.shadowGroups);
  const lights=Array.from({length:4},()=>{
    const light=new THREE.DirectionalLight(),camera=light.shadow.camera;
    camera.left=0;camera.right=4;camera.bottom=0;camera.top=4;camera.near=1;camera.far=100;
    camera.updateProjectionMatrix();camera.updateMatrixWorld();light.shadow.mapSize.set(4,4);
    light.shadow.map=new THREE.WebGLRenderTarget(4,4,{depthBuffer:true,stencilBuffer:false});
    light.shadow.map.depthTexture=new THREE.DepthTexture(4,4,THREE.UnsignedIntType);renderer.initRenderTarget(light.shadow.map);
    return light;
  });
  const owner=Object.assign(Object.create(Renderer.prototype),{
    renderer,scene,instanceCulling:{culler},cullingWorld:world,residentShadowRegionPasses:new Set(),
    untrackedShadowCasters:new Set(),untrackedWorldRenderables:new Set(),shadowCacheResults:new Map(),shadowCacheRevisions:new Map(),
    shadowRegionProjection:new THREE.Matrix4(),shadowRegionFrustum:new THREE.Frustum(),
  });
  const indices=[1,2,3],staticDraws=[0,0,0,0],dynamicDraws=[0,0,0,0];let dynamicPixel=0;
  try{
    owner.configureStaticShadowCache(index=>indices.includes(index),indices);
    culler.deferredShadowPasses=new Set(indices);
    culler.prepare(new THREE.Frustum(),lights.map(light=>({light,frustum:light.shadow.getFrustum()})));culler.enable();
    const dispatch=index=>{
      const light=lights[index],group=culler.shadowGroups[index],native=light.shadow.map;group.visible=true;
      culler.shadowPassDispatcher(index,light,group,()=>{
        const previous=renderer.getRenderTarget(),target=light.shadow.map;renderer.setRenderTarget(target);renderer.clear();
        const array=buffers.get(target);
        if(group.visible){staticDraws[index]++;for(let pixel=0;pixel<array.length;pixel++)array[pixel]=100+index*10+pixel;}
        else{dynamicDraws[index]++;array[dynamicPixel]=-index;}
        renderer.setRenderTarget(previous);renderer.shadowMap.needsUpdate=false;light.shadow.needsUpdate=false;
      });
      group.visible=false;assert.equal(light.shadow.map,native);assert.equal(renderer.getRenderTarget(),null);assert.equal(world.visible,true);
      return owner.shadowCacheResults.get(index);
    };
    for(const index of indices){const result=dispatch(index);assert.equal(result.cached,true,`Cascade ${index}: ${result.reason}`);assert.equal(result.reason,'initial');}
    assert.deepEqual(staticDraws,[0,1,1,1]);
    dynamicPixel=1;
    for(const index of indices){
      const result=dispatch(index);assert.equal(result.reason,'unchanged');assert.equal(result.staticDraws,0);assert.equal(result.reusedTexels,16);
      const depth=buffers.get(lights[index].shadow.map);
      assert.equal(depth[0],100+index*10,'The previous dynamic shadow is replaced by this cascade\'s own cached static depth');
      assert.equal(depth[1],-index,'Current dynamic shadows are composed separately in every cached cascade');
    }
    assert.deepEqual(staticDraws,[0,1,1,1]);assert.deepEqual(dynamicDraws,[0,2,2,2]);
    assert.equal(owner.shadowCacheDiagnostics.statistics.fallbackFrames,0);
    assert.equal(owner.shadowCacheDiagnostics.allocatedBytes,3*4*4*8*2);
    owner.shadowCache.dispose();assert.equal(owner.shadowCacheDiagnostics.allocatedBytes,0);
  }finally{
    owner.shadowCache?.dispose();culler.dispose();
    for(const light of lights){light.shadow.map.dispose();light.shadow.map.depthTexture.dispose();}
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  }
});
