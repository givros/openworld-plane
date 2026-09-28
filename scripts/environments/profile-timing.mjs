/** Collect complete frame intervals without discarding slow frames. */
export function sampleFrameWindow({maxFrames,maxDurationMs},scheduler={
 now:()=>performance.now(),frame:callback=>requestAnimationFrame(callback),cancelFrame:id=>cancelAnimationFrame(id),
 timer:(callback,delay)=>setTimeout(callback,delay),cancelTimer:id=>clearTimeout(id),
}){
 return new Promise(resolve=>{
  const started=scheduler.now(),intervals=[];let previous=null,frameHandle,timerHandle,finished=false;
  const finish=reason=>{
   if(finished)return;finished=true;scheduler.cancelFrame(frameHandle);scheduler.cancelTimer(timerHandle);
   resolve({intervals,frames:intervals.length,elapsedMs:scheduler.now()-started,reason,timeBoundReached:reason==='time-limit'});
  };
  const frame=timestamp=>{
   if(finished)return;
   if(previous!==null)intervals.push(timestamp-previous);
   previous=timestamp;
   if(intervals.length>=maxFrames)finish('frame-limit');
   else if(scheduler.now()-started>=maxDurationMs)finish('time-limit');
   else frameHandle=scheduler.frame(frame);
  };
  timerHandle=scheduler.timer(()=>finish('time-limit'),maxDurationMs);
  frameHandle=scheduler.frame(frame);
 });
}

/** Node-side guard also catches an unresponsive browser event loop. */
export async function withDeadline(operation,maxDurationMs,label){
 let timer;
 try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded ${maxDurationMs} ms.`)),maxDurationMs);})]);}
 finally{clearTimeout(timer);}
}
