// Isolated desktop, production-build profiling. Never attaches to a user's browser.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const tag = process.env.PROFILE_TAG ?? 'baseline';
if (!/^[\w-]+$/.test(tag)) throw Error('Invalid profile tag');
const output = path.resolve(process.env.PROFILE_ROOT??'artifacts/performance-20260926', tag);
await mkdir(output, { recursive: true });
const origin = process.env.GAME_URL ?? 'http://127.0.0.1:4173';
const distances = (process.env.DISTANCES ?? '100,300').split(',').map(Number);
const biomes = (process.env.BIOMES ?? 'verdant-airfield,azure-port,alpine-lake,sunstone-oasis').split(',');
const report = { timestamp: new Date().toISOString(), origin, tag, build: 'production, unminified for controlled instrumentation', viewport: [1440,900], dpr: 1, distances, errors: [], rows: [], complete: false };
report.clearView=process.env.CLEAR_VIEW==='1';
report.ramPreload=process.env.RAM_PRELOAD==='1';
report.depthMode=process.env.DEPTH_MODE==='reversed'?'reversed':'log';
report.fragmentShadows=process.env.FRAGMENT_SHADOWS==='1';
report.floatDepth=process.env.FLOAT_DEPTH==='1';
report.shadowClip=process.env.SHADOW_CLIP==='1';
report.stableShadows=process.env.STABLE_SHADOWS==='1';
report.cacheShadows=process.env.CACHE_SHADOWS==='1';
report.pruneTraversal=process.env.PRUNE_TRAVERSAL==='1';
report.immutableWorld=process.env.IMMUTABLE_WORLD==='1';
const browser = await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page = await browser.newPage({ viewport:{width:1440,height:900},deviceScaleFactor:1 });
const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
page.on('pageerror', e => report.errors.push(String(e)));
page.on('console', m => { if(m.type()==='error')report.errors.push(m.text()); });
let assetRequests=0;
page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/environments/'))assetRequests++;});
let exposed = false;
if(process.env.EARLY_SHADOWS==='1')await page.route('**/assets/three-*.js',async route=>{
  const response=await route.fetch(),source=await response.text();let changes=0;
  const body=source.replace(/depth_frag: "([^\n]*)"/,match=>{changes++;return match.replace('#include <logdepthbuf_fragment>','');});
  if(changes!==1)throw Error('Expected exactly one orthographic depth shader');
  report.experimentalShadowDepth=true;await route.fulfill({response,body});
});
await page.route('**/assets/index-*.js', async route => {
  const response = await route.fetch(), source = await response.text();
  if(!source.includes('this.expose();'))throw Error('Use vite build --minify false for the controlled benchmark');
  report.bundleSha256 = createHash('sha256').update(source).digest('hex');
  exposed = true;
  let body=source.replace('this.expose();','window.__benchmarkGame = this; this.expose();');
  if(['0','1'].includes(process.env.EXACT_CASCADES)){
    if(!body.includes('#define CROPPER_SELECT_CONTRIBUTING_CASCADES'))throw Error('Missing cascade selection experiment switch');
    body=body.replaceAll(/#define CROPPER_SELECT_CONTRIBUTING_CASCADES [01]/g,`#define CROPPER_SELECT_CONTRIBUTING_CASCADES ${process.env.EXACT_CASCADES}`);
    report.scopedCascadeSelection=process.env.EXACT_CASCADES==='1';
  }
  if(['1','2'].includes(process.env.CASCADE_SELECTION)){
    const original='cropperShadowVisibility[ i ] = cropperReceiverPlaneShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity, directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ], cropperShadowGradient[ i ] );';
    if(!body.includes(original))throw Error('Receiver-plane shader changed');
    body=body.replace(original,`bool sampleCascade = receiveShadow;
      #if defined(USE_CSM) && defined(CSM_CASCADES) && defined(CSM_FADE)
        float candidateDepth = vViewPosition.z / (shadowFar - cameraNear);
        vec2 candidateCascade = CSM_cascades[ i ];
        float candidateCenter = (candidateCascade.x + candidateCascade.y) / 2.0;
        float candidateEdge = candidateDepth < candidateCenter ? candidateCascade.x : candidateCascade.y;
        float candidateMargin = 0.25 * pow(candidateEdge, 2.0);
        sampleCascade = sampleCascade && candidateDepth >= candidateCascade.x - candidateMargin / 2.0 &&
          (candidateDepth < candidateCascade.y + candidateMargin / 2.0 || UNROLLED_LOOP_INDEX == CSM_CASCADES - 1);
      #endif
      cropperShadowVisibility[ i ] = 1.0;
      if (sampleCascade) { ${original} }`);
    if(process.env.CASCADE_SELECTION==='2'){
      const gradient='cropperShadowGradient[ i ] = cropperReceiverPlaneGradient( vDirectionalShadowCoord[ i ] );';
      body=body.replace(gradient,`${gradient}
    }
    #pragma unroll_loop_end
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {`);
    }
    report.experimentalCascadeSelection=true;
  }
  await route.fulfill({response,body});
});
const save = () => writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
try {
  const started=Date.now();
  const query=new URLSearchParams({review:'1'});
  if(process.env.RESIDENT_PERCENT)query.set('resident',process.env.RESIDENT_PERCENT);
  if(report.ramPreload)query.set('preload','1');
  if(report.depthMode==='reversed')query.set('depth','reversed');
  if(report.fragmentShadows)query.set('fragmentShadows','1');
  if(report.floatDepth)query.set('floatDepth','1');
  if(report.shadowClip)query.set('shadowClip','1');
  if(report.stableShadows)query.set('stableShadows','1');
  if(report.cacheShadows)query.set('cacheShadows','1');
  if(report.pruneTraversal)query.set('pruneTraversal','1');
  if(report.immutableWorld)query.set('immutableWorld','1');
  await page.goto(`${origin}/?${query}`,{timeout:120000});
  await page.waitForFunction(()=>window.__benchmarkGame?.world?.isViewReady,null,{timeout:300000});
  if(!exposed)throw Error('Missing benchmark access');
  report.startupMs=Date.now()-started;
  if(process.env.COMPACT_RENDER_LISTS!==undefined||process.env.STATIC_STREAM_LEASES!==undefined){
    await page.evaluate(({compact,leases})=>{
      const c=window.__benchmarkGame.rendering.instanceCulling.culler;
      if(compact!==undefined)c.compactRenderLists=compact==='1';
      if(leases!==undefined)c.staticStreamLeasesEnabled=leases==='1';
    },{compact:process.env.COMPACT_RENDER_LISTS,leases:process.env.STATIC_STREAM_LEASES});
  }
  report.startupPreload=await page.evaluate(()=>window.__benchmarkGame.world.streamingStats.preload);
  if(report.ramPreload&&!report.startupPreload?.complete)throw Error('The requested full-map preload did not complete');
  report.actualDepth=await page.evaluate(()=>window.__benchmarkGame.rendering.depthStatus);
  if(report.floatDepth&&report.actualDepth?.mode!=='reversed-float32')throw Error(`Float32 experiment was not active: ${JSON.stringify(report.actualDepth)}`);
  report.hardware=await page.evaluate(async()=>{
    const g=window.__benchmarkGame,r=g.rendering.renderer,gl=r.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
    return {browser:navigator.userAgent,gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),msaaSamples:gl.getParameter(gl.SAMPLES),gpuTimers:!!gl.getExtension('EXT_disjoint_timer_query_webgl2'),multiDraw:!!gl.getExtension('WEBGL_multi_draw'),clipControl:!!gl.getExtension('EXT_clip_control'),webgpu:adapter?{info:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description},features:[...adapter.features]}:null};
  });
  if(/swiftshader|llvmpipe|software/i.test(report.hardware.gpu))throw Error('Software GPU is not a valid performance baseline');
  console.log(JSON.stringify({startupMs:report.startupMs,hardware:report.hardware}));
  await page.evaluate(()=>{
    const g=window.__benchmarkGame;
    window.__measureWindow=async function(durationMs,motion=false){
      const intervals=[],cpu={},g=window.__benchmarkGame,longTasks=[],renderSpikes=[];let skippedFrames=0;
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push({startTime:entry.startTime,duration:entry.duration});});
      observer.observe({type:'longtask'});
      const wrap=(object,key,label)=>{const original=object[key];object[key]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{(cpu[label]??=[]).push(performance.now()-start);}};return()=>object[key]=original;};
      const restores=[wrap(g,'simulate','simulation'),wrap(g,'syncPresentation','presentation'),wrap(g.world,'updateStreaming','streaming'),wrap(g.atmosphere,'prepareRender','shadowPreparation'),wrap(g.rendering,'prepareWorldCulling','instanceCulling'),wrap(g.rendering,'render','renderSubmission'),wrap(g.rendering.instanceCulling,'addSources','sourceRegistration')];
      if(motion){const gl=g.rendering.renderer.getContext();for(const method of ['bufferData','bufferSubData','compileShader','linkProgram','getProgramParameter','getShaderParameter','texImage2D','generateMipmap'])restores.push(wrap(gl,method,method));}
      const originalTick=g.loop.tick;g.loop.tick=function(...args){const before=g.renderedFrames;originalTick.apply(this,args);if(g.renderedFrames===before)skippedFrames++;};
      const original=g.rendering.render;let last=null,frames=0;
      g.rendering.render=function(...args){const begin=performance.now(),beforePrograms=g.rendering.renderer.info.programs.length,beforeGeometries=g.rendering.renderer.info.memory.geometries;
        const result=original.apply(this,args),now=performance.now();if(last!==null)intervals.push(now-last);last=now;frames++;
        if(now-begin>80)renderSpikes.push({duration:now-begin,newPrograms:g.rendering.renderer.info.programs.length-beforePrograms,newGeometries:g.rendering.renderer.info.memory.geometries-beforeGeometries});return result;};
      const begin=performance.now();
      window.__AIRPLANE_EXPERIENCE__.setReviewMode(!motion);g.loop.start();
      await new Promise(resolve=>setTimeout(resolve,durationMs));
      const elapsedMs=performance.now()-begin;g.loop.stop();window.__AIRPLANE_EXPERIENCE__.setReviewMode(true);
      g.rendering.render=original;g.loop.tick=originalTick;for(const restore of restores.reverse())restore();
      for(const entry of observer.takeRecords())longTasks.push({startTime:entry.startTime,duration:entry.duration});observer.disconnect();
      const summary=a=>{const s=[...a].sort((a,b)=>a-b);return{count:s.length,median:s[Math.floor(s.length*.5)]??null,p95:s[Math.min(s.length-1,Math.ceil(s.length*.95)-1)]??null,mean:s.length?s.reduce((a,b)=>a+b,0)/s.length:null,max:s.at(-1)??null};};
      return{elapsedMs,frames,fps:frames*1000/elapsedMs,frameMs:summary(intervals),intervals,skippedFrames,renderSpikes,longTasks:longTasks.filter(t=>t.startTime>=begin),cpu:Object.fromEntries(Object.entries(cpu).map(([key,value])=>[key,summary(value)])),streaming:g.world.streamingStats};
    };
    window.__measurePasses=async function(skipShadows=false){
      const g=window.__benchmarkGame,r=g.rendering.renderer,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
      g.loop.stop();const original=r.shadowMap.render,timings=[];
      try{for(let i=0;i<16;i++){
        g.syncPresentation(0);let sq=null,bq=null;
        r.shadowMap.render=function(...args){
          if(ext){sq=gl.createQuery();bq=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,sq);}
          if(!skipShadows)original.apply(this,args);
          if(ext){gl.endQuery(ext.TIME_ELAPSED_EXT);gl.beginQuery(ext.TIME_ELAPSED_EXT,bq);}
        };
        const before=performance.now();g.rendering.render(true);const submissionMs=performance.now()-before;
        if(ext)gl.endQuery(ext.TIME_ELAPSED_EXT);
        // Let the GPU finish asynchronously; no finish/readback in cadence measurement.
        const wait=performance.now();if(ext)while(!gl.getQueryParameter(bq,gl.QUERY_RESULT_AVAILABLE)&&performance.now()-wait<5000)await new Promise(resolve=>setTimeout(resolve,4));
        const valid=ext&&!gl.getParameter(ext.GPU_DISJOINT_EXT)&&gl.getQueryParameter(bq,gl.QUERY_RESULT_AVAILABLE);
        if(i>=4)timings.push({submissionMs,shadowGpuMs:valid?gl.getQueryParameter(sq,gl.QUERY_RESULT)/1e6:null,beautyGpuMs:valid?gl.getQueryParameter(bq,gl.QUERY_RESULT)/1e6:null});
        if(sq)gl.deleteQuery(sq);if(bq)gl.deleteQuery(bq);
      }}finally{r.shadowMap.render=original;}
      return{diagnosticOnly:skipShadows,timings,passes:structuredClone(g.rendering.passes)};
    };
  });
  for(const distance of distances)for(const biome of biomes){
    console.log(`SETUP ${biome} ${distance}m`);
    const setup=Date.now();
    await page.evaluate(({distance,biome,clearView})=>{
      const api=window.__AIRPLANE_EXPERIENCE__,g=window.__benchmarkGame;g.loop.stop();api.setReviewMode(true);api.setRenderDistance(distance);api.visitBiome(biome);
      const fog=g.rendering.scene.fog;
      if(clearView&&fog){
        // Older baseline builds retain fog. Keep their shader variant while
        // moving its fade beyond the camera; current builds have no scene fog.
        Object.defineProperty(fog,'near',{configurable:true,get:()=>1e6,set:()=>{}});
        Object.defineProperty(fog,'far',{configurable:true,get:()=>2e6,set:()=>{}});
      }
      api.setFlightState({pitch:.025,bank:0,verticalSpeed:0,flightPathAngle:0});
    },{distance,biome,clearView:process.env.CLEAR_VIEW==='1'});
    await page.evaluate(async()=>{const g=window.__benchmarkGame;await g.world.whenReady();g.syncPresentation(0,true);await g.world.whenReady();});
    // Include preloading in setup, not in steady-state GPU/CPU cost.
    await page.waitForFunction(()=>window.__benchmarkGame.world.streamingStats.loadingChunks===0,null,{timeout:180000});
    const setupExperiment=await page.evaluate(({reuse,early,pack})=>{
      const g=window.__benchmarkGame,c=g.rendering.instanceCulling.culler;
      c.orthographicDepthEnabled=early;
      if(!reuse){if(!pack)c.shadowGeometryForSource=undefined;return{precomputedShadowPack:pack,orthographicDepth:early};}
      const geometries=new Map(),bySource=new Map();let addedIndexBytes=0,changedSources=0;
      const start=performance.now();
      for(const {source}of c.canonicalSources){
        if(!source.castShadow)continue;
        let optimized=geometries.get(source.geometry);
        if(!optimized){optimized=window.__reuseExactShadowVertices(source);geometries.set(source.geometry,optimized);if(optimized!==source.geometry)addedIndexBytes+=optimized.index.array.byteLength;}
        if(optimized!==source.geometry){bySource.set(source,optimized);changedSources++;}
      }
      c.shadowGeometryForSource=source=>bySource.get(source);
      return{cpuBuildMs:performance.now()-start,addedIndexBytes,changedSources,geometries:geometries.size};
    },{reuse:process.env.SHADOW_REUSE==='1',early:process.env.RUNTIME_EARLY==='1',pack:process.env.SHADOW_PACK==='1'});
    await page.evaluate(()=>window.__measureWindow(2500));
    const row={biome,distance,setupMs:Date.now()-setup,setupExperiment};
    row.stationary=await page.evaluate(()=>window.__measureWindow(5000));
    row.diagnostics=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.diagnostics);
    row.streaming=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.getStreamingStats());
    row.shadowCache=await page.evaluate(()=>window.__benchmarkGame.rendering.shadowCacheDiagnostics??null);
    row.browserMetrics=(await cdp.send('Performance.getMetrics')).metrics.filter(m=>['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','LayoutCount','RecalcStyleCount'].includes(m.name));
    row.heap=await cdp.send('Runtime.getHeapUsage');
    row.gpu=await page.evaluate(()=>window.__measurePasses());
    if(process.env.DORMANT_PAIRED==='1'){
      row.dormantPaired=[];
      for(const [name,compact,leases] of [
        ['legacy',false,false],['compact-only',true,false],['leases-only',false,true],
        ['combined',true,true],['legacy-repeat',false,false],['combined-repeat',true,true],
      ]){
        await page.evaluate(({compact,leases})=>{
          const c=window.__benchmarkGame.rendering.instanceCulling.culler;
          c.compactRenderLists=compact;c.staticStreamLeasesEnabled=leases;
        },{compact,leases});
        await page.evaluate(()=>window.__measureWindow(1500));
        const cadence=await page.evaluate(()=>window.__measureWindow(5000));
        const selection=await page.evaluate(()=>{
          const g=window.__benchmarkGame,c=g.rendering.instanceCulling.culler;
          return{passes:structuredClone(g.rendering.passes),lease:c.staticLeaseStatistics??null,compact:c.compactRenderStatistics??null};
        });
        row.dormantPaired.push({name,compact,leases,cadence,selection});
        console.log(JSON.stringify({experiment:name,fps:cadence.fps,frameMs:cadence.frameMs,cullingMs:cadence.cpu.instanceCulling,selection}));
      }
    }
    if(process.env.PAIRED==='1'){
      row.paired=[];
      await page.evaluate(()=>{const c=window.__benchmarkGame.rendering.instanceCulling.culler;window.__savedShadowLookup=c.shadowGeometryForSource;});
      for(const enabled of [false,true,false,true]){
        await page.evaluate(enabled=>{const c=window.__benchmarkGame.rendering.instanceCulling.culler;c.orthographicDepthEnabled=enabled;c.shadowGeometryForSource=enabled?window.__savedShadowLookup:undefined;},enabled);
        await page.evaluate(()=>window.__measureWindow(1500));
        const cadence=await page.evaluate(()=>window.__measureWindow(4000));
        const gpu=await page.evaluate(()=>window.__measurePasses());
        row.paired.push({enabled,cadence,gpu});
      }
    }
    if(distance===300)row.shadowReuseDiagnostic=await page.evaluate(()=>window.__measurePasses(true));
    await page.evaluate(()=>{const g=window.__benchmarkGame;g.syncPresentation(0);g.rendering.render(true);});
    await page.screenshot({path:path.join(output,`${biome}-${distance}.png`)});
    // Deterministic world-only evidence; dynamic effects are restored immediately.
    const pixels=await page.evaluate(()=>{
      const g=window.__benchmarkGame,hidden=[g.aircraft.root,g.vfx.root,g.atmosphere.clouds],states=hidden.map(o=>o.visible);
      hidden.forEach(o=>o.visible=false);g.atmosphere.prepareRender();g.rendering.render(true);
      const gl=g.rendering.renderer.getContext(),data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
      const encoded=btoa(Array.from({length:Math.ceil(data.length/8192)},(_,i)=>String.fromCharCode(...data.subarray(i*8192,(i+1)*8192))).join(''));
      hidden.forEach((o,i)=>o.visible=states[i]);return {base64:encoded,camera:g.rendering.camera.matrixWorld.toArray()};
    });
    await writeFile(path.join(output,`${biome}-${distance}.rgba`),Buffer.from(pixels.base64,'base64'));row.pixelCamera=pixels.camera;
    if(process.env.MOTION!=='0'){
      const requestsBefore=assetRequests;
      if(process.env.CPU_PROFILE==='1'){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
      row.motion=await page.evaluate(ms=>window.__measureWindow(ms,true),Number(process.env.FLIGHT_SECONDS??7)*1000);
      if(process.env.CPU_PROFILE==='1'){
        const {profile}=await cdp.send('Profiler.stop');await cdp.send('Profiler.disable');
        await writeFile(path.join(output,`${biome}-${distance}.cpuprofile`),JSON.stringify(profile));
      }
      row.motion.assetRequests=assetRequests-requestsBefore;
      row.motion.shadowCache=await page.evaluate(()=>window.__benchmarkGame.rendering.shadowCacheDiagnostics??null);
      row.motion.heap=await cdp.send('Runtime.getHeapUsage');
    }
    report.rows.push(row);await save();
    if(report.errors.length)throw Error(`Browser validation failed: ${report.errors[0]}`);
    console.log(JSON.stringify({biome,distance,fps:row.stationary.fps,frameMs:row.stationary.frameMs,cpu:row.stationary.cpu,gpu:row.gpu.timings[5],motion:row.motion?.fps,passes:row.diagnostics.renderer.passes}));
  }
  if(process.env.PROFILE_CPU==='1'){
    await page.waitForFunction(()=>window.__benchmarkGame.world.streamingStats.loadingChunks===0,null,{timeout:180000});
    await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start');
    await page.evaluate(()=>window.__measureWindow(5000));
    const {profile}=await cdp.send('Profiler.stop');await writeFile(path.join(output,'steady-state.cpuprofile'),JSON.stringify(profile));
    const nodes=new Map(profile.nodes.map(n=>[n.id,n])),counts=new Map();
    for(const id of profile.samples??[]){const frame=nodes.get(id)?.callFrame,name=frame?.functionName||'(anonymous)';counts.set(name,(counts.get(name)??0)+1);}
    report.cpuProfile={samples:profile.samples?.length,topFunctions:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,25),note:'Sampling time includes idle and driver submission waits; not summed on top of GPU elapsed time.'};
  }
  report.assetRequests=assetRequests;report.complete=true;
}catch(error){report.failure=String(error);throw error;}finally{await save();await browser.close();}
