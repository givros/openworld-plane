import test from 'node:test';
import assert from 'node:assert/strict';
import {Loop} from '../src/core/Loop.ts';

test('camera and simulation clocks agree through slow frames and remain bounded after suspension',()=>{
  const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  const callbacks=new Map(),samples=[];let next=1;
  globalThis.requestAnimationFrame=callback=>{const id=next++;callbacks.set(id,callback);return id;};
  globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
  const advance=now=>{const [id,callback]=callbacks.entries().next().value;callbacks.delete(id);callback(now);};
  const loop=new Loop((dt,simulationDt,rawDt)=>samples.push({dt,simulationDt,rawDt}),0);
  try{
    loop.start();loop.start();assert.equal(callbacks.size,1);
    for(const time of [1000,1016,1096,1196,2196])advance(time);
    for(const sample of samples)assert.equal(sample.dt,sample.simulationDt);
    assert.equal(samples[2].dt,.08);assert.equal(samples[3].dt,.1);
    assert.equal(samples[4].dt,.12);assert.equal(samples[4].rawDt,1);
    loop.stop();assert.equal(callbacks.size,0);
  }finally{loop.dispose();globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
});
