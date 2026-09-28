import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleFrameWindow,withDeadline} from '../scripts/environments/profile-timing.mjs';
import {QualityDiagnostics} from '../src/systems/QualityDiagnostics.ts';

function scheduler(frameInterval){
 let now=0,nextId=0;const events=new Map();
 const schedule=(callback,delay)=>{const id=++nextId;events.set(id,{at:now+delay,callback});return id;};
 return{
  now:()=>now,frame:callback=>schedule(()=>callback(now),frameInterval),cancelFrame:id=>events.delete(id),
  timer:schedule,cancelTimer:id=>events.delete(id),
  run(){let steps=0;while(events.size){assert.ok(++steps<1000);const [id,event]=[...events].sort((a,b)=>a[1].at-b[1].at)[0];events.delete(id);now=event.at;event.callback();}},
 };
}

test('slow frame profiling obeys elapsed-time cap and retains every complete interval',async()=>{
 const clock=scheduler(840),pending=sampleFrameWindow({maxFrames:180,maxDurationMs:60000},clock);clock.run();
 const result=await pending;assert.equal(result.elapsedMs,60000);assert.equal(result.timeBoundReached,true);
 assert.equal(result.frames,70);assert.ok(result.intervals.every(interval=>interval===840));
});

test('frame profiling completes at its frame limit and also bounds stalled callbacks',async()=>{
 const clock=scheduler(16),pending=sampleFrameWindow({maxFrames:3,maxDurationMs:60000},clock);clock.run();
 const result=await pending;assert.deepEqual(result.intervals,[16,16,16]);assert.equal(result.timeBoundReached,false);
 const stalled=scheduler(100000),stalledPending=sampleFrameWindow({maxFrames:180,maxDurationMs:60000},stalled);stalled.run();
 const empty=await stalledPending;assert.equal(empty.frames,0);assert.equal(empty.elapsedMs,60000);assert.equal(empty.timeBoundReached,true);
 await assert.rejects(withDeadline(new Promise(()=>{}),5,'stalled page'),/stalled page exceeded/);
});

test('quality diagnostics preserves >= one-second frames instead of hiding slow frames',()=>{
 const diagnostics=new QualityDiagnostics();
 for(const duration of [.016,.84,1,1.4,2,NaN,Infinity,-1,0])diagnostics.update(duration);
 assert.equal(diagnostics.performance.samples,5);assert.equal(diagnostics.performance.medianFrameMs,1000);
 assert.equal(diagnostics.performance.p95FrameMs,2000);assert.equal(diagnostics.performance.medianFps,1);
});
