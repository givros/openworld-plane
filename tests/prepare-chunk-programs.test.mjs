import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChunkPrograms } from '../src/core/prepareChunkPrograms.ts';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const program=(ready=false)=>({program:{},ready,calls:0,isReady(){this.calls++;return this.ready;}});
function fixture(variants){
  const chunk={},camera={},scene={},material={},cache=new Map(variants.map((value,index)=>[index,value]));
  let compilations=0,propertyReads=0;
  const renderer={
    compile(actualChunk,actualCamera,actualScene){
      compilations++;assert.equal(actualChunk,chunk);assert.equal(actualCamera,camera);assert.equal(actualScene,scene);
      return new Set([material]);
    },
    properties:{get(actualMaterial){
      propertyReads++;assert.equal(actualMaterial,material);
      return {programs:cache,get currentProgram(){throw Error('Must snapshot every variant, not currentProgram');}};
    }},
  };
  const start=signal=>prepareChunkPrograms(renderer,chunk,camera,scene,signal);
  return {start,renderer,cache,get compilations(){return compilations;},get propertyReads(){return propertyReads;}};
}

test('preparation snapshots and awaits every unique material layout variant',async()=>{
  const earlier=program(false),latest=program(true),f=fixture([earlier,latest,earlier]);
  const controller=new AbortController();let complete=false;
  const prepared=f.start(controller.signal).then(()=>{complete=true;});
  assert.equal(earlier.calls,0,'Readiness must not block the compile call');
  f.cache.clear(); // Material disposal/rebinding must not change the captured set.
  await delay(15);
  assert.equal(complete,false,'A ready latest variant must not conceal an earlier pending variant');
  assert.equal(latest.calls,1,'Shared program references are deduplicated and ready entries removed');
  earlier.ready=true;await prepared;
  assert.equal(complete,true);assert.equal(f.compilations,1);assert.equal(f.propertyReads,1);
});

test('an already aborted chunk never starts compilation',async()=>{
  const f=fixture([program()]),controller=new AbortController();controller.abort();
  await assert.rejects(f.start(controller.signal),{name:'AbortError'});
  assert.equal(f.compilations,0);assert.equal(f.propertyReads,0);
});

test('aborting preparation removes the listener and timer before disposed programs are touched',async()=>{
  const p=program(),f=fixture([p]),controller=new AbortController();
  let listeners=0;
  const add=controller.signal.addEventListener.bind(controller.signal),remove=controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener=(...args)=>{listeners++;return add(...args);};
  controller.signal.removeEventListener=(...args)=>{listeners--;return remove(...args);};
  const rejected=assert.rejects(f.start(controller.signal),{name:'AbortError'});
  controller.abort();
  Object.defineProperty(p,'program',{get(){throw Error('Disposed program was accessed after cancellation');}});
  await rejected;await delay(25);
  assert.equal(p.calls,0);assert.equal(listeners,0);
});

test('unexpected program destruction rejects without polling its released WebGL handle',async()=>{
  const p=program(),f=fixture([p]),controller=new AbortController();
  const rejected=assert.rejects(f.start(controller.signal),/released before preparation completed/);
  p.program=undefined;await rejected;assert.equal(p.calls,0);
});

test('cancellation during a readiness check takes precedence over later destroyed variants',async()=>{
  const controller=new AbortController(),first=program(),second=program(),f=fixture([first,second]);
  first.isReady=()=>{controller.abort();second.program=undefined;return false;};
  await assert.rejects(f.start(controller.signal),{name:'AbortError'});
  assert.equal(second.calls,0);
});

test('a synchronous compilation error is returned as a rejected promise',async()=>{
  const f=fixture([]),controller=new AbortController();
  f.renderer.compile=()=>{throw Error('Compilation failed');};
  await assert.rejects(f.start(controller.signal),/Compilation failed/);
});
