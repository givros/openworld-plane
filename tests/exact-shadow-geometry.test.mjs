import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { registerExactShadowGeometry,registerExactShadowGeometryCooperatively,exactShadowGeometry,exactShadowIndexBytes,loadExactShadowIndexPack } from '../src/world/ExactShadowGeometry.ts';
import { createOrthographicShadowDepth,supportsOrthographicShadowDepth } from '../src/systems/OrthographicShadowDepth.ts';

test('optional shadow manifest failures preserve canonical loading and cancellation',async()=>{
  const originalFetch=globalThis.fetch,originalWarn=console.warn;
  const source='canonical source manifest';
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  const hash=Buffer.from(digest).toString('hex');
  const valid={version:1,complete:true,sourceManifestSha256:hash,geometries:[]};
  try{
    console.warn=()=>{};
    for(const response of [()=>Promise.reject(new TypeError('offline')),()=>new Response('{invalid'),
      ()=>new Response('',{status:404}),()=>Response.json(null),()=>Response.json({...valid,geometries:null}),
      ()=>Response.json({...valid,sourceManifestSha256:'stale'})]){
      globalThis.fetch=async()=>response();
      assert.equal(await loadExactShadowIndexPack('/optional.json',source),undefined);
    }
    globalThis.fetch=async()=>Response.json(valid);
    assert.deepEqual(await loadExactShadowIndexPack('/optional.json',source),valid);
    const controller=new AbortController();controller.abort();
    globalThis.fetch=async()=>{throw new DOMException('cancelled','AbortError');};
    await assert.rejects(loadExactShadowIndexPack('/optional.json',source,controller.signal),{name:'AbortError'});
  }finally{globalThis.fetch=originalFetch;console.warn=originalWarn;}
});

function fixture(){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,0,0,0,1,0,0,0,1,0],3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2,3,4,5]),1));
  const mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial());
  registerExactShadowGeometry(g,new Uint16Array([0,1,2,0,1,2]));return mesh;
}
test('cooperative shadow-index preparation checks the entire buffer before exposing acceleration',async()=>{
  const source=new THREE.BoxGeometry(),controller=new AbortController();let yields=0,charges=0;
  const budget={checkpoint:()=>yields++===0?Promise.resolve():undefined,charge:()=>charges++};
  const array=source.index.array.slice();
  await registerExactShadowGeometryCooperatively(source,array,budget,controller.signal);
  assert.ok(exactShadowGeometry(new THREE.Mesh(source,new THREE.MeshStandardMaterial())));
  assert.equal(charges,1);source.dispose();
});
test('cancelled or mutated cooperative shadow preparation never exposes partial acceleration',async()=>{
  for(const mode of ['cancel','mutate','bad-index']){
    const source=new THREE.BoxGeometry(),controller=new AbortController(),array=source.index.array.slice();let yielded=false;
    if(mode==='bad-index')array[array.length-1]=source.attributes.position.count;
    const budget={checkpoint:()=>{
      if(yielded)return undefined;yielded=true;
      return Promise.resolve().then(()=>{if(mode==='cancel')controller.abort();if(mode==='mutate')source.attributes.position.needsUpdate=true;});
    },charge:()=>{}};
    await assert.rejects(registerExactShadowGeometryCooperatively(source,array,budget,controller.signal),mode==='cancel'?{name:'AbortError'}:mode==='mutate'?/changed while preparing/:/outside the source positions/);
    assert.equal(exactShadowIndexBytes(source),0);assert.equal(exactShadowGeometry(new THREE.Mesh(source,new THREE.MeshStandardMaterial())),undefined);source.dispose();
  }
});
test('shadow data shares source positions, retains all triangles and follows draw metadata',()=>{
  const mesh=fixture(),source=mesh.geometry,shadow=exactShadowGeometry(mesh);
  assert.ok(shadow);assert.equal(shadow.getAttribute('position'),source.getAttribute('position'));
  assert.equal(shadow.index.count,source.index.count);assert.equal(exactShadowIndexBytes(source),12);
  for(let i=0;i<source.index.count;i++)for(let c=0;c<3;c++)assert.equal(shadow.attributes.position.array[shadow.index.array[i]*3+c],source.attributes.position.array[source.index.array[i]*3+c]);
  source.groups=[{start:0,count:3,materialIndex:0}];source.setDrawRange(0,3);
  assert.equal(exactShadowGeometry(mesh).groups,source.groups);assert.equal(shadow.drawRange,source.drawRange);
});
test('mutations and non-opaque/custom shadow materials retain canonical geometry',()=>{
  for(const mutate of [m=>m.geometry.attributes.position.needsUpdate=true,m=>m.geometry.index.needsUpdate=true,
    m=>m.geometry.attributes.position.array=m.geometry.attributes.position.array.slice(),m=>m.geometry.index=m.geometry.index.clone(),
    m=>m.material.alphaTest=.5,m=>m.material.displacementMap=new THREE.Texture(),m=>m.customDepthMaterial=new THREE.MeshDepthMaterial()]){
    const mesh=fixture();mutate(mesh);assert.equal(exactShadowGeometry(mesh),undefined);
  }
});
test('resource release disposes owned indices once without disposing shared position buffers',()=>{
  const mesh=fixture(),source=mesh.geometry,shadow=exactShadowGeometry(mesh);let disposed=0;
  shadow.addEventListener('dispose',()=>{disposed++;assert.equal(shadow.getAttribute('position'),undefined);});
  source.dispose();assert.equal(disposed,1);assert.ok(source.getAttribute('position'));assert.equal(exactShadowGeometry(mesh),undefined);assert.equal(exactShadowIndexBytes(source),0);
  source.dispose();assert.equal(disposed,1);
});
test('invalid index dimensions/range are rejected before registration',()=>{
  const g=new THREE.BoxGeometry();assert.throws(()=>registerExactShadowGeometry(g,new Uint16Array(1)));
  assert.throws(()=>registerExactShadowGeometry(g,new Uint32Array(g.index.count).fill(g.attributes.position.count)));
});
test('orthographic depth retains shader body and excludes incompatible materials',()=>{
  const mesh=fixture(),depth=createOrthographicShadowDepth();
  assert.equal(supportsOrthographicShadowDepth(mesh),true);
  const shader={fragmentShader:'void main(){\n#include <logdepthbuf_fragment>\n gl_FragColor=vec4(1.); }'};
  depth.onBeforeCompile(shader,{});assert.ok(shader.fragmentShader.includes('gl_FragColor=vec4(1.)'));assert.ok(!shader.fragmentShader.includes('logdepthbuf_fragment'));
  for(const property of ['map','alphaMap','displacementMap']){mesh.material[property]=new THREE.Texture();assert.equal(supportsOrthographicShadowDepth(mesh),false);mesh.material[property]=null;}
  mesh.customDepthMaterial=new THREE.MeshDepthMaterial();assert.equal(supportsOrthographicShadowDepth(mesh),false);
  assert.throws(()=>depth.onBeforeCompile({fragmentShader:'changed upstream shader'},{}));depth.dispose();
});
