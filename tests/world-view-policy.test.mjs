import test from 'node:test';
import assert from 'node:assert/strict';
import {worldViewPolicy,FULL_WORLD_VIEW_DISTANCE} from '../src/core/WorldViewPolicy.ts';
import {RenderDistanceController} from '../src/core/RenderDistanceController.ts';

test('normal play and old trial links load the full map and retain full island visibility',()=>{
  for(const search of ['', '?view=300&resident=70', '?view=100&resident=0&clearView=0']){
    assert.deepEqual(worldViewPolicy(search),{review:false,viewDistance:6000,residentPercent:100});
  }
  assert.ok(FULL_WORLD_VIEW_DISTANCE>Math.hypot(3200,3200));
});

test('controlled reviews retain explicit distance and residency overrides',()=>{
  assert.deepEqual(worldViewPolicy('?review=1&view=300&resident=70'),{review:true,viewDistance:300,residentPercent:70});
  assert.deepEqual(worldViewPolicy('?debug=1&view=16000&resident=0'),{review:true,viewDistance:16000,residentPercent:0});
  assert.deepEqual(worldViewPolicy('?review=1&view=full'),{review:true,viewDistance:6000,residentPercent:100});
});

test('slow frames cannot shrink a deliberately selected full-world view',()=>{
  const controller=new RenderDistanceController({initialDistance:6000,maximumDistance:6000});
  controller.setOverride(6000);
  for(let frame=1;frame<=120;frame++)assert.equal(controller.update({nowMs:frame*250,frameDurationMs:250,rendered:true,ready:true,pendingLoads:0}),6000);
  assert.equal(controller.diagnostics.decisions,0);
});
