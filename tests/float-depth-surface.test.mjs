import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FloatDepthSurface,checkFloatDepthSurfaceSupport } from '../src/core/FloatDepthSurface.ts';

function fakeRenderer({depthSamples=[4],defaultSamples=4,depthBits=32,complete=true}={}){
 let target=null,shadowCalls=0,validations=0;
 const size=new THREE.Vector2(1440,900),gl={
  SAMPLES:1,RGBA8:2,DEPTH_COMPONENT32F:3,RENDERBUFFER:4,FRAMEBUFFER:5,FRAMEBUFFER_COMPLETE:6,
  DEPTH_BITS:7,DEPTH_ATTACHMENT:8,FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:9,FLOAT:10,
  getParameter(key){return key===this.SAMPLES?(target?target.samples:defaultSamples):depthBits;},
  getExtension(name){return name==='EXT_clip_control'?{}:null;},
  getInternalformatParameter(_kind,format){return new Int32Array(format===this.RGBA8?[4,8]:depthSamples);},
  checkFramebufferStatus(){validations++;return complete?this.FRAMEBUFFER_COMPLETE:0;},
  getFramebufferAttachmentParameter(){return this.FLOAT;},
 };
 const renderer={
  capabilities:{reversedDepthBuffer:true,logarithmicDepthBuffer:false},outputColorSpace:THREE.SRGBColorSpace,
  getContext:()=>gl,getRenderTarget:()=>target,setRenderTarget:value=>{target=value;},
  getDrawingBufferSize:out=>out.copy(size),
  info:{autoReset:true,render:{calls:87,triangles:1000000,points:4,lines:8,frame:9}},
  shadowMap:{render:()=>{shadowCalls++;}},
  render(mesh){
   renderer.shadowMap.render([],mesh,null);
   renderer.info.render.calls++;renderer.info.render.triangles++;renderer.info.render.frame++;
   assert.equal(mesh.frustumCulled,false);assert.ok(mesh.material.isRawShaderMaterial);
  },
 };
 return {renderer,gl,size,get shadowCalls(){return shadowCalls;},get validations(){return validations;}};
}

test('support checks never lower the native sample count to accept floating depth',()=>{
 const good=fakeRenderer();assert.deepEqual(checkFloatDepthSurfaceSupport(good.gl),{supported:true,samples:4});
 const limited=fakeRenderer({depthSamples:[2]});assert.equal(checkFloatDepthSurfaceSupport(limited.gl).supported,false);
 assert.throws(()=>new FloatDepthSurface(limited.renderer),/sample count/);
 assert.equal(checkFloatDepthSurfaceSupport(fakeRenderer({defaultSamples:0}).gl).supported,false);
 const absent=fakeRenderer();absent.gl.getExtension=()=>null;assert.equal(checkFloatDepthSurfaceSupport(absent.gl).supported,false);
});

test('the pinned screen-output gate preserves per-material tone mapping and explicit color storage',()=>{
 assert.equal(THREE.REVISION,'184','Review this compatibility adapter when upgrading Three');
 const source=name=>readFileSync(new URL(`../node_modules/three/src/${name}`,import.meta.url),'utf8');
 const programs=source('renderers/webgl/WebGLPrograms.js'),renderer=source('renderers/WebGLRenderer.js');
 assert.match(programs,/if \( material\.toneMapped \) \{\s+if \( currentRenderTarget === null \|\| currentRenderTarget\.isXRRenderTarget === true \)/);
 assert.match(renderer,/if \( material\.toneMapped \) \{\s+if \( _currentRenderTarget === null \|\| _currentRenderTarget\.isXRRenderTarget === true \)/);
 assert.match(programs,/currentRenderTarget\.isXRRenderTarget === true \? currentRenderTarget\.texture\.colorSpace/);
 assert.match(renderer,/_currentRenderTarget\.isXRRenderTarget === true \? _currentRenderTarget\.texture\.colorSpace/);
 const fake=fakeRenderer(),surface=new FloatDepthSurface(fake.renderer);
 try{
  assert.equal(surface.target.isXRRenderTarget,true);assert.equal(surface.target.texture.internalFormat,'RGBA8');
  assert.equal(surface.target.texture.type,THREE.UnsignedByteType);assert.equal(surface.target.texture.colorSpace,THREE.SRGBColorSpace);
  assert.equal(surface.target.depthTexture.type,THREE.FloatType);assert.equal(surface.target.samples,4);
  assert.equal(surface.target.resolveDepthBuffer,false);assert.equal(surface.target.stencilBuffer,false);
  assert.match(surface.material.fragmentShader,/texelFetch\(surface,ivec2\(gl_FragCoord.xy\),0\)/);
  assert.doesNotMatch(surface.material.fragmentShader,/toneMapping|colorspace|texture2D/);
  assert.equal(surface.material.toneMapped,false);assert.equal(surface.material.blending,THREE.NoBlending);
 }finally{surface.dispose();}
});

test('presentation excludes its copy from scene statistics and bypasses shadow hooks',()=>{
 const fake=fakeRenderer(),surface=new FloatDepthSurface(fake.renderer),shadow=fake.renderer.shadowMap.render;
 try{
  assert.equal(fake.renderer.getRenderTarget(),null);assert.equal(fake.validations,1);
  surface.begin();assert.equal(fake.renderer.getRenderTarget(),surface.target);
  assert.throws(()=>surface.begin(),/already active/);
  surface.end();assert.equal(fake.renderer.getRenderTarget(),null);assert.equal(fake.shadowCalls,0);
  assert.equal(fake.renderer.shadowMap.render,shadow);assert.equal(fake.renderer.info.autoReset,true);
  assert.deepEqual(surface.outputPass,{calls:1,triangles:1});
  assert.deepEqual(fake.renderer.info.render,{calls:87,triangles:1000000,points:4,lines:8,frame:10});
  fake.size.set(1920,1080);surface.begin();assert.equal(fake.validations,2);
  assert.equal(surface.target.width,1920);assert.equal(surface.target.height,1080);
  assert.throws(()=>surface.resize(),/still being rendered/);surface.abort();assert.equal(fake.renderer.getRenderTarget(),null);
 }finally{surface.dispose();}
 assert.throws(()=>surface.begin(),/disposed/);
});

test('failed output and failed GPU validation restore state and dispose safely',()=>{
 const invalid=fakeRenderer({depthBits:24});assert.throws(()=>new FloatDepthSurface(invalid.renderer),/Float32/);
 assert.equal(invalid.renderer.getRenderTarget(),null);
 const fake=fakeRenderer(),surface=new FloatDepthSurface(fake.renderer),shadow=fake.renderer.shadowMap.render;
 let disposals=0;surface.target.addEventListener('dispose',()=>disposals++);
 fake.renderer.render=()=>{throw new Error('Copy failed');};surface.begin();
 assert.throws(()=>surface.end(),/Copy failed/);assert.equal(fake.renderer.getRenderTarget(),null);
 assert.equal(fake.renderer.shadowMap.render,shadow);assert.equal(fake.renderer.info.autoReset,true);
 assert.equal(fake.renderer.info.render.calls,87);
 surface.begin();surface.dispose();surface.dispose();assert.equal(disposals,1);assert.equal(fake.renderer.getRenderTarget(),null);
});
