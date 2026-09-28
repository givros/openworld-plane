// Private headless desktop verification of the ordinary public launch URL.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const origin='http://127.0.0.1:4173';
const output=process.env.VERIFY_OUTPUT??'artifacts/distance-detail-20260928/production';
const viewport={width:1920,height:900};
await mkdir(output,{recursive:true});
const report={complete:false,url:origin,viewport,errors:[],networkFailures:[],rows:[]};
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-renderer-backgrounding','--disable-background-timer-throttling']});
let progress;
try{
  const page=await browser.newPage({viewport,deviceScaleFactor:1});
  let assetRequests=0;
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)report.networkFailures.push({url:response.url(),status:response.status()});});
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/environments/'))assetRequests++;});
  await page.route('**/assets/index-*.js',async route=>{
    const response=await route.fetch(),source=await response.text();
    if(source.split('this.expose()').length!==2)throw Error('Expected one application exposure point');
    report.bundle=new URL(route.request().url()).pathname;
    await route.fulfill({response,body:source.replace('this.expose()','(window.__verificationGame=this,this.expose())')});
  });
  const started=Date.now();
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:120000});
  progress=setInterval(()=>console.log(JSON.stringify({phase:'startup',seconds:Math.round((Date.now()-started)/1000)})),20000);
  await page.waitForFunction(()=>window.__verificationGame?.startupReady,null,{timeout:600000});
  clearInterval(progress);report.startupMs=Date.now()-started;
  const requestsAtStartup=assetRequests;
  await page.evaluate(()=>{const g=window.__verificationGame;g.loop.stop();g.review=true;});
  report.graphics=await page.evaluate(()=>{
    const gl=window.__verificationGame.rendering.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return{renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      dpr:devicePixelRatio,samples:gl.getParameter(gl.SAMPLES),version:gl.getParameter(gl.VERSION)};
  });
  const biomes=process.env.VERIFY_BIOMES?process.env.VERIFY_BIOMES.split(','):['verdant-airfield','azure-port','alpine-lake','sunstone-oasis'];
  const margins=process.env.VERIFY_TEMPORAL_MARGINS?process.env.VERIFY_TEMPORAL_MARGINS.split(',').map(Number):[null];
  if(margins.some(value=>value!==null&&(!Number.isFinite(value)||value<=0)))throw Error('Invalid temporal margin');
  for(const biome of biomes)for(const margin of margins){
    const label=margin===null?biome:`${biome}-margin-${margin}`;
    const row=await page.evaluate(async ({id,margin})=>{
      const g=window.__verificationGame;
      if(margin!==null){const temporal=g.rendering.instanceCulling.temporalBeauty;temporal.translationMargin=margin;temporal.height=0;}
      g.visitBiome(id);g.syncPresentation(0,true);await g.world.whenReady();g.syncPresentation(0,true);
      g.rendering.render(true);
      const s=g.world.streamingStats,c=g.rendering.instanceCulling;
      if(g.viewDistance!==6000||g.rendering.scene.fog!==null||s.pinnedChunks!==422||s.preparedResidentChunks!==422||!s.preparationComplete)
        throw Error('Ordinary launch must retain the full fog-free prepared map');
      if(!g.rendering.shadowCache||!g.rendering.pruneCanonicalTraversal||!c.culler.staticStreamLeasesEnabled)
        throw Error('Measured optimizations must be active without trial URL flags');
      if(!g.rendering.distanceDetail||!g.rendering.selectedBatching||!c.temporalBeauty||!c.culler.reuseStaticBeautySelection||
        g.rendering.residentBindingPreparation?.stage!=='complete'||g.loop.targetFps!==30)
        throw Error('Distance detail, batching, temporal selection, prepared bindings and 30 FPS cadence must be enabled by default');
      return{biome:id,experimentalTemporalMargin:margin,viewDistance:g.viewDistance,cameraFar:g.rendering.camera.far,fog:false,pinnedChunks:s.pinnedChunks,
        targetFps:g.loop.targetFps,temporalMargin:c.temporalBeauty.translationMargin,distanceDetail:{...g.rendering.distanceDetail.statistics},bindingPreparation:g.rendering.residentBindingPreparation,
        passes:structuredClone(g.rendering.passes),shadowCache:structuredClone(g.rendering.shadowCacheDiagnostics),
        loads:s.loads,evictions:s.evictions,ready:g.world.isViewReady};
    },{id:biome,margin});
    report.rows.push(row);
    await page.screenshot({path:`${output}/${label}.png`});
    if(process.env.VERIFY_FLIGHTS==='1'){
      row.flight=await page.evaluate(async ({profile,id,interiorAlpine})=>{
        const g=window.__verificationGame,r=g.rendering,original=r.render;
        const interior=id==='alpine-lake'&&interiorAlpine;
        const flightSetup=interior?{position:[-650,265,1500],yaw:Math.PI/2,route:'alpine-interior-eastbound'}:{altitudeOffset:id==='alpine-lake'?100:0};
        const durations=[],intervals=[];let frames=0,previous=0,collect=false;
        const components={},restores=[];
        if(profile){
          const wrap=(object,key,label)=>{
            const method=object?.[key];if(typeof method!=='function')return;
            const item=components[label]={calls:0,totalMs:0,maxMs:0};
            object[key]=function(...args){const start=performance.now();try{return method.apply(this,args);}finally{if(collect){const ms=performance.now()-start;item.calls++;item.totalMs+=ms;item.maxMs=Math.max(item.maxMs,ms);}}};
            restores.push(()=>{object[key]=method;});
          };
          wrap(g,'syncPresentation','presentation');wrap(g.atmosphere,'prepareRender','atmosphere');
          wrap(r.instanceCulling,'prepare','cullingAdapter');wrap(r.instanceCulling.culler,'prepare','cullingPrepare');
          wrap(r.instanceCulling.culler,'renderShadowPasses','shadowDispatch');
          wrap(r.instanceCulling.culler,'prepareDeferredShadowRegion','shadowSelection');
          for(const [key,batcher]of r.selectedBatching?.batchers??[])wrap(batcher,'select',`batching:${key}`);
        }
        const indices=g.atmosphere.cacheableShadowPassIndices;
        const shadowEvents=Object.fromEntries(indices.map(index=>[index,{reasons:{},fallbackFrames:0,centerChanges:0}]));
        const previousCenters=Object.fromEntries(indices.map(index=>[index,[0,0,0]]));
        let groundedFrames=0,crashedFrames=0;
        const flightState=()=>{
          const state=g.manual.state;
          return{position:state.position.toArray(),cameraPosition:r.camera.position.toArray(),elapsed:state.elapsed,
            phase:state.phase,grounded:state.grounded,crashed:state.crashed,speed:state.speed,altitude:state.altitude};
        };
        const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return{median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)};};
        r.render=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{if(collect){
          const now=performance.now();durations.push(now-start);if(previous)intervals.push(now-previous);previous=now;frames++;
          if(g.manual.state.grounded)groundedFrames++;if(g.manual.state.crashed)crashedFrames++;
          for(const index of indices){
            const event=shadowEvents[index],result=r.shadowCacheResults.get(index);
            if(result){event.reasons[result.reason]=(event.reasons[result.reason]??0)+1;if(result.fallback)event.fallbackFrames++;}
            const view=g.atmosphere.sunlight.lights[index].shadow.camera.matrixWorldInverse.elements,center=previousCenters[index];
            if(view[12]!==center[0]||view[13]!==center[1]||view[14]!==center[2])event.centerChanges++;
            center[0]=view[12];center[1]=view[13];center[2]=view[14];
          }
        }}};
        try{
          // The native Alpine heading reaches a 260 m ridge during this 15 s route.
          // Lift only this benchmark launch so the normal moving flight remains airborne.
          if(interior){
            // Cross the lake and inland forest, keeping the whole route inside Alpine.
            g.manual.state.position.set(...flightSetup.position);g.manual.state.yaw=flightSetup.yaw;
            g.manual.state.altitude=flightSetup.position[1]-g.sampleGround(flightSetup.position[0],flightSetup.position[2]);
            g.chase.reset();g.syncPresentation(0,true);
          }else if(flightSetup.altitudeOffset){
            g.manual.state.position.y+=flightSetup.altitudeOffset;
            g.manual.state.altitude+=flightSetup.altitudeOffset;
            g.syncPresentation(0,true);
          }
          g.review=false;g.reviewPose=false;g.loop.start();
          await new Promise(resolve=>setTimeout(resolve,3000));
          const shadowCacheBefore=structuredClone(r.shadowCacheDiagnostics);
          const temporalBefore={...r.instanceCulling.temporalBeauty.statistics};
          const before=flightState(),contentRevisionBefore=r.instanceCulling.culler.contentRevision;
          for(const index of indices){
            const view=g.atmosphere.sunlight.lights[index].shadow.camera.matrixWorldInverse.elements,center=previousCenters[index];
            center[0]=view[12];center[1]=view[13];center[2]=view[14];
          }
          collect=true;const start=performance.now();
          await new Promise(resolve=>setTimeout(resolve,12000));
          const elapsedMs=performance.now()-start;g.loop.stop();
          const after=flightState(),distanceMetres=Math.hypot(...after.position.map((value,index)=>value-before.position[index]));
          return{frames,elapsedMs,fps:frames*1000/elapsedMs,frameMs:summary(intervals),submissionMs:summary(durations),passes:structuredClone(r.passes),
            flightSetup,before,after,validity:{distanceMetres,simulatedSeconds:after.elapsed-before.elapsed,groundedFrames,crashedFrames,
              airborne:!before.grounded&&!after.grounded&&groundedFrames===0,noCrash:!before.crashed&&!after.crashed&&crashedFrames===0},
            shadowEvents,components,temporalBefore,temporalAfter:{...r.instanceCulling.temporalBeauty.statistics},contentRevisionBefore,contentRevisionAfter:r.instanceCulling.culler.contentRevision,
            shadowCacheBefore,shadowCacheAfter:structuredClone(r.shadowCacheDiagnostics)};
        }finally{g.loop.stop();r.render=original;g.review=true;for(const restore of restores)restore();}
      },{profile:process.env.VERIFY_PROFILE==='1',id:biome,interiorAlpine:process.env.VERIFY_ALPINE_INTERIOR==='1'});
      if(!(row.flight.validity.distanceMetres>100)||!row.flight.validity.airborne||!row.flight.validity.noCrash)
        throw Error(`Invalid moving flight sample for ${biome}: ${JSON.stringify(row.flight.validity)}`);
      await page.screenshot({path:`${output}/${label}-flight.png`});
    }
    console.log(JSON.stringify({biome,ready:row.ready,viewDistance:row.viewDistance,triangles:row.passes.beauty.triangles}));
    if(row.flight)console.log(JSON.stringify({biome,flight:row.flight}));
  }
  report.assetRequestsAfterStartup=assetRequests-requestsAtStartup;
  if(report.assetRequestsAfterStartup||report.errors.length||report.networkFailures.length)throw Error('Unexpected asset request or runtime error');
  report.complete=true;
}catch(error){report.failure=String(error);throw error;}
finally{clearInterval(progress);await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await browser.close();}
