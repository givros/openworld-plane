// A private headless desktop browser; never connects to the user's browser.
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.env.PROFILE_ROOT??'artifacts/resident-map-20260926';
const origin=process.env.GAME_URL??'http://127.0.0.1:4173';
const resident=Number(process.env.RESIDENT_PERCENT??70);
const tag=resident?`resident-${resident}`:'streamed';
await mkdir(output,{recursive:true});
const query=new URLSearchParams({review:'1',fragmentShadows:'1',cacheShadows:'1',pruneTraversal:'1',immutableWorld:'1',clearView:'1',view:'300'});
if(process.env.RAM_PRELOAD==='1')query.set('preload','1');
if(resident)query.set('resident',String(resident));
const report={complete:false,startedAt:new Date().toISOString(),url:`${origin}/?${query}`,resident,viewport:[1440,900],errors:[],rows:[]};
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
page.on('pageerror',error=>{report.errors.push(String(error));console.log(`PAGE ERROR: ${error}`);});
page.on('console',message=>{if(message.type()==='error'){report.errors.push(message.text());console.log(`CONSOLE ERROR: ${message.text()}`);}});
let assetRequests=0,progressTimer;
page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/environments/'))assetRequests++;});
try{
  const started=Date.now();
  await page.goto(report.url,{timeout:120000,waitUntil:'domcontentloaded'});
  progressTimer=setInterval(async()=>{
    try{console.log(JSON.stringify({elapsedSeconds:Math.round((Date.now()-started)/1000),loading:await page.locator('#loading p').first().textContent({timeout:1000})}));}catch{}
  },20000);
  await page.waitForFunction(()=>window.__AIRPLANE_EXPERIENCE__?.getStreamingStats().ready||document.querySelector('#loading')?.textContent.includes('THE WORLD COULD NOT LOAD'),null,{timeout:420000});
  clearInterval(progressTimer);progressTimer=undefined;
  if(!await page.evaluate(()=>Boolean(window.__AIRPLANE_EXPERIENCE__)))throw Error(await page.locator('#loading').textContent());
  report.startupMs=Date.now()-started;
  report.initial=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.getStreamingStats());
  if(resident){
    const s=report.initial.streaming;
    if(!s.preparationComplete||s.preparedResidentChunks<Math.ceil(s.totalChunks*resident/100))throw Error('Requested residency was not prepared before flight');
    if(!report.initial.startup.gpu)throw Error('GPU startup preparation did not run');
  }
  console.log(JSON.stringify({startupMs:report.startupMs,residentChunks:report.initial.streaming.residentChunks,pinnedChunks:report.initial.streaming.pinnedChunks,gpu:report.initial.startup.gpu}));
  if(process.env.TRACK_RESIDENT_UPLOADS==='1'){
    report.tracksGpuAllocations=true;
    await page.evaluate(()=>{
      const gl=document.querySelector('#flight-canvas').getContext('webgl2');
      const counts=window.__residentGpuOperations={};
      for(const name of ['createBuffer','bufferData','createVertexArray','compileShader','linkProgram']){
        counts[name]=0;const original=gl[name];
        gl[name]=function(...args){counts[name]++;return original.apply(this,args);};
      }
    });
  }
  const requestsAtStart=assetRequests;
  for(const distance of (process.env.DISTANCES??'300,600').split(',').map(Number)){
    await page.evaluate(distance=>{
      const api=window.__AIRPLANE_EXPERIENCE__;
      api.setReviewMode(true);api.setRenderDistance(distance);api.visitBiome('azure-port');
      api.setFlightState({pitch:.025,bank:0,verticalSpeed:0,flightPathAngle:0});
    },distance);
    await page.waitForFunction(()=>{const s=window.__AIRPLANE_EXPERIENCE__.getStreamingStats();return s.ready&&s.streaming.loadingChunks===0;},null,{timeout:180000});
    await page.waitForTimeout(2500);
    const before=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.getStreamingStats());
    await page.screenshot({path:`${output}/${tag}-${distance}-before.png`});
    const result=await page.evaluate(async()=>{
      const api=window.__AIRPLANE_EXPERIENCE__,before=api.getStreamingStats().renderedFrames,intervals=[];
      const beforeGpu=window.__residentGpuOperations?{...window.__residentGpuOperations}:undefined;
      let previous=null,handle=0;
      const sample=time=>{if(previous!==null)intervals.push(time-previous);previous=time;handle=requestAnimationFrame(sample);};
      const start=performance.now();api.setReviewMode(false);handle=requestAnimationFrame(sample);
      await new Promise(resolve=>setTimeout(resolve,20000));
      const elapsed=performance.now()-start;api.setReviewMode(true);cancelAnimationFrame(handle);
      const frames=api.getStreamingStats().renderedFrames-before,sorted=[...intervals].sort((a,b)=>a-b);
      return{elapsedMs:elapsed,renderedFrames:frames,drawnFps:frames*1000/elapsed,rafFrames:intervals.length+1,
        rafFrameMs:{median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)},
        streaming:api.getStreamingStats(),renderer:api.diagnostics.renderer,intervals,
        gpuOperations:beforeGpu?Object.fromEntries(Object.entries(window.__residentGpuOperations).map(([key,value])=>[key,value-beforeGpu[key]])):undefined};
    });
    report.rows.push({distance,before,...result});
    await page.screenshot({path:`${output}/${tag}-${distance}-after.png`});
    console.log(JSON.stringify({distance,fps:result.drawnFps,frameMs:result.rafFrameMs,residentChunks:result.streaming.streaming.residentChunks,pinned:result.streaming.streaming.preparedResidentChunks,loadsDuringFlight:result.streaming.streaming.loads-before.streaming.loads,evictionsDuringFlight:result.streaming.streaming.evictions-before.streaming.evictions,gpuOperations:result.gpuOperations}));
    if(resident&&result.streaming.streaming.preparedResidentChunks!==report.initial.streaming.preparedResidentChunks)throw Error('Prepared sectors were evicted during flight');
  }
  report.postStartupAssetRequests=assetRequests-requestsAtStart;
  report.complete=report.errors.length===0;
  if(!report.complete)throw Error(report.errors[0]);
}finally{
  clearInterval(progressTimer);
  await writeFile(`${output}/${tag}.json`,JSON.stringify(report,null,2));
  await browser.close();
}
