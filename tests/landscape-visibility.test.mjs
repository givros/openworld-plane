import test from 'node:test';
import assert from 'node:assert/strict';
import {landscapeVisibility} from '../src/systems/LandscapeVisibility.ts';

test('the selected landscape footprint stays inside the far plane without a fog fade',()=>{
  for(const altitude of [0,8,80,320,1000,10000]){
    const range=landscapeVisibility(300,altitude);
    assert.ok(range.cameraFar>=Math.hypot(300,altitude),'ceil retains the selected ground footprint');
    assert.deepEqual(Object.keys(range),['cameraFar']);
  }
});

test('invalid visibility values cannot create a broken projection',()=>{
  for(const [range,altitude] of [[0,0],[-1,0],[NaN,0],[300,NaN],[300,-1],[Infinity,0]])
    assert.throws(()=>landscapeVisibility(range,altitude));
});
