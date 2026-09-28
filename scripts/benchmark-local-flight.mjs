// Production flight cadence without wrapping rendering or WebGL calls.
import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const output=process.env.PROFILE_ROOT??'artifacts/render-architecture-20260926';
const origin=process.env.GAME_URL??'http://127.0.0.1:4173';
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const report={complete:false,origin,viewport:[1440,900],errors:[],rows:[]};
page.on('pageerror',e=>report.errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
try{
  await page.goto(`${origin}/?review=1&preload=1&fragmentShadows=1&cacheShadows=1&pruneTraversal=1&immutableWorld=1&clearView=1&view=300`,{timeout:120000});
  await page.waitForFunction(()=>window.__AIRPLANE_EXPERIENCE__?.getStreamingStats().ready,null,{timeout:300000});
  for(const distance of (process.env.DISTANCES??'300,600').split(',').map(Number)){
    await page.evaluate(distance=>{
      const a=window.__AIRPLANE_EXPERIENCE__;a.setReviewMode(true);a.setRenderDistance(distance);a.visitBiome('azure-port');
      a.setFlightState({pitch:.025,bank:0,verticalSpeed:0,flightPathAngle:0});
    },distance);
    await page.waitForFunction(()=>{const s=window.__AIRPLANE_EXPERIENCE__.getStreamingStats();return s.ready&&s.streaming.loadingChunks===0;},null,{timeout:180000});
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,2500)));
    const result=await page.evaluate(async()=>{
      const a=window.__AIRPLANE_EXPERIENCE__,before=a.getStreamingStats().renderedFrames,intervals=[];
      let previous=null,handle=0;const sample=time=>{if(previous!==null)intervals.push(time-previous);previous=time;handle=requestAnimationFrame(sample);};
      const start=performance.now();a.setReviewMode(false);handle=requestAnimationFrame(sample);
      await new Promise(resolve=>setTimeout(resolve,20000));
      const elapsed=performance.now()-start;a.setReviewMode(true);cancelAnimationFrame(handle);
      const frames=a.getStreamingStats().renderedFrames-before,sorted=[...intervals].sort((a,b)=>a-b);
      return{elapsedMs:elapsed,renderedFrames:frames,drawnFps:frames*1000/elapsed,rafFrames:intervals.length+1,
        rafFrameMs:{median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)},
        streaming:a.getStreamingStats(),renderer:a.diagnostics.renderer,intervals};
    });
    report.rows.push({distance,...result});console.log(JSON.stringify({distance,fps:result.drawnFps,frameMs:result.rafFrameMs}));
  }
  if(report.errors.length)throw Error(report.errors[0]);report.complete=true;
}finally{await writeFile(`${output}/production-flight.json`,JSON.stringify(report,null,2));await browser.close();}
