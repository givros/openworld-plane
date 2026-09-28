import test from 'node:test';
import assert from 'node:assert/strict';
import {Loop} from '../src/core/Loop.ts';

function clock(run){
  const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  let callback,handle=0;
  globalThis.requestAnimationFrame=next=>{callback=next;return ++handle;};
  globalThis.cancelAnimationFrame=()=>{callback=undefined;};
  try{run(now=>{const next=callback;callback=undefined;next?.(now);});}
  finally{globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
}

test('30 FPS rendering uses wall-clock simulation time on a 60 Hz display',()=>clock(advance=>{
  const ticks=[],loop=new Loop((...args)=>ticks.push(args));loop.start();
  for(let frame=1;frame<=120;frame++)advance(frame*1000/60);
  assert.equal(ticks.length,60);
  for(const [dt,simulation,raw]of ticks){assert.ok(Math.abs(raw-1/30)<1e-10);assert.equal(dt,simulation);}
  loop.stop();
}));

test('missed frames do not replay renders or make the camera lag behind flight',()=>clock(advance=>{
  const ticks=[],loop=new Loop((...args)=>ticks.push(args));loop.start();
  advance(10);advance(210);
  assert.equal(ticks.length,2);assert.deepEqual(ticks[1],[.12,.12,.2]);
  advance(211);assert.equal(ticks.length,2);loop.stop();
}));

test('uncapped diagnostics and stop inside a tick leave no extra queued rendering',()=>clock(advance=>{
  let ticks=0;const loop=new Loop(()=>{ticks++;if(ticks===3)loop.stop();},0);loop.start();
  for(let i=1;i<=8;i++)advance(i*1000/120);
  assert.equal(ticks,3);
  loop.start();advance(500);assert.equal(ticks,4);loop.dispose();
}));
