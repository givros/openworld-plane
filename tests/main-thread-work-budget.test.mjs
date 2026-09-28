import test from 'node:test';
import assert from 'node:assert/strict';
import { MainThreadWorkBudget } from '../src/world/MainThreadWorkBudget.ts';

test('concurrent preparation requests share one frame budget and recheck after resuming',async()=>{
  const previousRAF=globalThis.requestAnimationFrame,previousDocument=globalThis.document,frames=[],completed=[];
  globalThis.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  globalThis.document={hidden:false};
  try{
    const budget=new MainThreadWorkBudget(3);budget.charge(3);
    const work=async id=>{let waiting;while((waiting=budget.checkpoint()))await waiting;completed.push(id);budget.charge(3);};
    const first=work('first'),second=work('second');assert.equal(frames.length,1);
    frames.shift()();await Promise.resolve();
    assert.deepEqual(completed,['first']);assert.equal(frames.length,1);
    frames.shift()();await Promise.all([first,second]);assert.deepEqual(completed,['first','second']);
  }finally{
    if(previousRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previousRAF;
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
  }
});
