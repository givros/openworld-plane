import { chromium } from '@playwright/test';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import {finalWorldInputs} from './environments/runtime-validation-inputs.mjs';
import {withDeadline} from './environments/profile-timing.mjs';
import {profileMovingShadowRoute} from './environments/moving-shadow-route.mjs';
const pixelOnly=!!process.env.PIXEL_ONLY;
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const inputEvidence=await finalWorldInputs(manifest,{requireQuiet:!pixelOnly});
// Every default run gets its own directory; historical baseline evidence is immutable.
const out=process.env.PASS_PROFILE_OUTPUT_DIR??`artifacts/four-horizons/comparisons/csm-audit/runs/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.text().startsWith('PASS '))console.log(message.text());if(message.type()==='error')errors.push(message.text());});page.on('requestfailed',request=>errors.push(request.url()));
try{
 await page.route('**/src/game/Game.ts*',async route=>{
  const response=await route.fetch();const body=(await response.text()).replace('this.expose();','window.__auditGame = this; this.expose();');
  await route.fulfill({response,body});
 });
 await page.goto('http://127.0.0.1:5173/?review=1');
 await page.waitForFunction(()=>window.__auditGame?.world?.diagnostics.ready,null,{timeout:240000});console.log('World loaded');
 const actualGPU=await withDeadline(page.evaluate(()=>{const gl=window.__auditGame.rendering.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}),30000,'Hardware identification');
 if(!/NVIDIA.*RTX 3080/i.test(actualGPU))throw new Error(`Expected RTX 3080 hardware, received ${actualGPU}`);
 const report=await withDeadline(page.evaluate(async(pixelOnly)=>{
  const game=window.__auditGame;game.loop.stop();
  const renderer=game.rendering.renderer,gl=renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const rendererExt=gl.getExtension('WEBGL_debug_renderer_info');
  const shadow=renderer.shadowMap,originalShadowRender=shadow.render;
  const previousAutoReset=renderer.info.autoReset;
  const previousVolumeStates=game.atmosphere.casterVolumes.map(volume=>volume.enabled);
  const rows=[],profileStarted=performance.now(),profileLimitMs=180000;let timeBoundReached=false;
 biomeLoop:for(const biome of ['verdant-airfield','azure-port','alpine-lake','sunstone-oasis']){
   if(performance.now()-profileStarted>=profileLimitMs){timeBoundReached=true;break;}
   window.__AIRPLANE_EXPERIENCE__.reviewBiome(biome,120);
   for(let i=0;i<3;i++){
    game.atmosphere.prepareRender();game.rendering.prepareWorldCulling();
    renderer.render(game.rendering.scene,game.rendering.camera);
   }
   gl.finish();
   let baselinePixels;
   for(const mode of (pixelOnly?['full-unfiltered','full-caster-volume']:['full-unfiltered','full-caster-volume','cached-shadow-diagnostic'])){
    game.atmosphere.casterVolumes.forEach(volume=>volume.enabled=mode!=='full-unfiltered');
    const timings=[],passes=[];let pixels;
    for(let i=0;i<(pixelOnly?1:3);i++){
     if(performance.now()-profileStarted>=profileLimitMs){timeBoundReached=true;break biomeLoop;}
     // Direct native draws bypass Renderer.render's preparation hook. Refresh
     // exact light/caster volumes and every pass selection after mode toggles.
     // Keep this CPU cost outside the shadow/beauty GPU timer queries.
     const preparationStarted=performance.now();
     game.atmosphere.prepareRender();
     const atmospherePreparationMs=performance.now()-preparationStarted;
     const cullingPreparationStarted=performance.now();game.rendering.prepareWorldCulling();
     const cullingPreparationMs=performance.now()-cullingPreparationStarted;
     const preparationMs=performance.now()-preparationStarted;
     renderer.info.autoReset=false;renderer.info.reset();
     const shadowQuery=ext?gl.createQuery():null,beautyQuery=ext?gl.createQuery():null;
     let shadowStats;
     shadow.render=function(...args){
      if(shadowQuery)gl.beginQuery(ext.TIME_ELAPSED_EXT,shadowQuery);
      if(mode!=='cached-shadow-diagnostic')originalShadowRender.apply(this,args);
      if(shadowQuery)gl.endQuery(ext.TIME_ELAPSED_EXT);
      shadowStats={...renderer.info.render};
      if(beautyQuery)gl.beginQuery(ext.TIME_ELAPSED_EXT,beautyQuery);
     };
     const start=performance.now();renderer.render(game.rendering.scene,game.rendering.camera);
     if(beautyQuery)gl.endQuery(ext.TIME_ELAPSED_EXT);
     const submissionMs=performance.now()-start;gl.finish();
     // Read before yielding: the default framebuffer may be discarded after
     // browser composition, which would make an asynchronous comparison empty.
     pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
     gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
     const synchronizedFrameMs=performance.now()-start;
     const queryStart=performance.now();
     if(ext)while(!gl.getQueryParameter(beautyQuery,gl.QUERY_RESULT_AVAILABLE)&&performance.now()-queryStart<1000)await new Promise(resolve=>setTimeout(resolve,2));
     const gpuValid=ext&&gl.getQueryParameter(beautyQuery,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(ext.GPU_DISJOINT_EXT);
     timings.push({preparationMs,atmospherePreparationMs,cullingPreparationMs,submissionMs,synchronizedFrameMs,shadowGpuMs:gpuValid?gl.getQueryParameter(shadowQuery,gl.QUERY_RESULT)/1e6:null,beautyGpuMs:gpuValid?gl.getQueryParameter(beautyQuery,gl.QUERY_RESULT)/1e6:null});
     passes.push({shadow:shadowStats,all:{...renderer.info.render},beauty:{calls:renderer.info.render.calls-shadowStats.calls,triangles:renderer.info.render.triangles-shadowStats.triangles}});
     if(shadowQuery)gl.deleteQuery(shadowQuery);if(beautyQuery)gl.deleteQuery(beautyQuery);
    }
    const median=key=>{const values=timings.map(row=>row[key]).filter(value=>value!==null).sort((a,b)=>a-b);return values.length?values[Math.floor(values.length/2)]:null;};
    let pixelComparison=null;
    if(mode==='full-unfiltered')baselinePixels=pixels;
    else if(mode==='full-caster-volume'){
      let changedPixels=0,maxRGBDelta=0,totalRGBDelta=0;
      for(let p=0;p<pixels.length;p+=4){const delta=Math.abs(pixels[p]-baselinePixels[p])+Math.abs(pixels[p+1]-baselinePixels[p+1])+Math.abs(pixels[p+2]-baselinePixels[p+2]);if(delta)changedPixels++;maxRGBDelta=Math.max(maxRGBDelta,delta);totalRGBDelta+=delta;}
      let minBaselineLuminance=765,maxBaselineLuminance=0;
      for(let p=0;p<baselinePixels.length;p+=4){const luminance=baselinePixels[p]+baselinePixels[p+1]+baselinePixels[p+2];minBaselineLuminance=Math.min(minBaselineLuminance,luminance);maxBaselineLuminance=Math.max(maxBaselineLuminance,luminance);}
      pixelComparison={changedPixels,maxRGBDelta,totalRGBDelta,nonemptyBaseline:maxBaselineLuminance-minBaselineLuminance>3};
    }
    rows.push({biome,mode,samples:timings.length,median:{preparationMs:median('preparationMs'),atmospherePreparationMs:median('atmospherePreparationMs'),cullingPreparationMs:median('cullingPreparationMs'),submissionMs:median('submissionMs'),synchronizedFrameMs:median('synchronizedFrameMs'),shadowGpuMs:median('shadowGpuMs'),beautyGpuMs:median('beautyGpuMs')},passes:passes[0],instanceCulling:game.rendering.instanceCulling?.diagnostics??null,timings,pixelComparison});
    console.log('PASS '+biome+' '+mode+' '+JSON.stringify(pixelComparison));
   }
   shadow.render=originalShadowRender;
  }
  shadow.render=originalShadowRender;renderer.info.autoReset=previousAutoReset;
  game.atmosphere.casterVolumes.forEach((volume,index)=>volume.enabled=previousVolumeStates[index]);
  game.atmosphere.prepareRender();game.rendering.prepareWorldCulling();
  const multiDraw=gl.getExtension('WEBGL_multi_draw');
  return{timestamp:new Date().toISOString(),world:game.world.diagnostics,renderer:rendererExt?gl.getParameter(rendererExt.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),depthMode:renderer.capabilities.logarithmicDepthBuffer?'logarithmic':renderer.capabilities.reversedDepthBuffer?'reversed':'standard',cameraNear:game.rendering.camera.near,cameraFar:game.rendering.camera.far,gpuTimerAvailable:!!ext,webglMultiDraw:{available:!!multiDraw,indexedInstancedDrawAvailable:typeof multiDraw?.multiDrawElementsInstancedWEBGL==='function'},viewport:[1440,900],rows,
   bounds:{maxDurationMs:profileLimitMs,elapsedMs:performance.now()-profileStarted,timeBoundReached,complete:rows.length===(pixelOnly?8:12),maxSamplesPerMode:pixelOnly?1:3},glError:gl.getError()};
 },pixelOnly),240000,'Combined shadow/beauty GPU profile');
 // This optional candidate is imported only after the complete GPU baseline.
 // The active game's receiver object remains the original implementation.
 if(process.env.RECEIVER_BOUNDS_COMPARE==='1'){
  try{
   report.receiverBoundsCandidateComparison=await withDeadline(page.evaluate(async()=>{
    const game=window.__auditGame;game.loop.stop();
    const {ShadowReceiverBounds}=await import('/src/systems/ShadowReceiverBounds.ts');
    const candidate=new ShadowReceiverBounds(),current=game.atmosphere.receiverBounds;
    const originalRender=game.rendering.render,started=performance.now(),maxDurationMs=60000,rows=[];
    let timeBoundReached=false;
    // reviewBiome also draws once; suppress only that diagnostic setup draw.
    // No renderer setting, scene geometry, or active receiver object is changed.
    game.rendering.render=()=>{};
    try{
     for(const biome of ['verdant-airfield','azure-port','alpine-lake','sunstone-oasis']){
      if(performance.now()-started>=maxDurationMs){timeBoundReached=true;break;}
      window.__AIRPLANE_EXPERIENCE__.reviewBiome(biome,120);
      game.rendering.scene.updateMatrixWorld(true);
      const samples={current:[],candidate:[]},mismatches=[];let warmupPairs=0,samplePairs=0,lastBounds;
      for(let pair=0;pair<25;pair++){
       if(performance.now()-started>=maxDurationMs){timeBoundReached=true;break;}
       const bounds={};
       for(const name of pair%2?['candidate','current']:['current','candidate']){
        const before=performance.now(),box=(name==='current'?current:candidate).update(game.rendering.scene);
        const elapsedMs=performance.now()-before;
        bounds[name]=[...box.min.toArray(),...box.max.toArray()];
        if(pair>=5)samples[name].push(elapsedMs);
       }
       if(!bounds.current.every((value,index)=>value===bounds.candidate[index]))mismatches.push({pair,bounds});
       lastBounds=bounds;
       if(pair<5)warmupPairs++;else samplePairs++;
      }
      const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return{samples:values.length,medianMs:sorted[Math.floor(sorted.length*.5)]??null,p95Ms:sorted[Math.floor(sorted.length*.95)]??null,intervalsMs:values};};
      rows.push({biome,warmupPairs,samplePairs,current:summarize(samples.current),candidate:summarize(samples.candidate),exactBoundsEqual:mismatches.length===0,mismatches,bounds:lastBounds});
      if(timeBoundReached)break;
     }
    }finally{game.rendering.render=originalRender;}
    return{status:rows.length===4&&rows.every(row=>row.samplePairs===20&&row.exactBoundsEqual)?'passed':'failed',instrumentation:'CPU-only receiver-bound updates after all GPU baseline samples; each pose uses five warmup pairs followed by twenty pairs with alternating call order.',candidateModule:'/src/systems/ShadowReceiverBounds.ts',currentModule:'/src/systems/ShadowCasterVolume.ts',activeReceiverUnchanged:game.atmosphere.receiverBounds===current,gpuRenderCallsDuringComparison:0,bounds:{maxDurationMs,elapsedMs:performance.now()-started,timeBoundReached},rows};
   }),90000,'CPU receiver-bounds candidate comparison');
  }catch(error){report.receiverBoundsCandidateComparison={status:'failed',error:String(error),baselineGpuSamplesUnaffected:true};}
 }
 report.inputEvidence=inputEvidence;
 if(process.env.MOVING_CAMERA_PROFILE==='1'){
  try{
   const replay=process.env.MOVING_ROUTE_REPLAY?JSON.parse(await readFile(process.env.MOVING_ROUTE_REPLAY,'utf8')).movingCamera:null;
   if(process.env.MOVING_ROUTE_REPLAY&&!replay)throw new Error('Replay report has no movingCamera route.');
   report.movingCamera=await withDeadline(page.evaluate(profileMovingShadowRoute,{replay,maxDurationMs:120000}),150000,'Moving-camera shadow profile');
  }catch(error){report.movingCamera={status:'failed',error:String(error),baselineStaticSamplesUnaffected:true};}
 }
 if(process.env.INSTANCE_CULLING_STATS==='1'){
  report.instanceCullingEligibility=await withDeadline(page.evaluate(async()=>{
   const {isInstanceCullingCandidate,isPassInstanceProxy}=await import('/src/world/PassInstanceCuller.ts');
   const thresholds=[512,2048,4096,8192].map(minimumPrototypeTriangles=>({minimumPrototypeTriangles,batches:0,activeInstances:0,allocatedInstanceSlots:0,weightedTriangles:0,fiveMatrixBuffersBytes:0}));
   let canonicalInstancedBatches=0,eligibleInstancedBatches=0;
   window.__auditGame.rendering.scene.traverse(object=>{
    if(!object.isInstancedMesh||isPassInstanceProxy(object))return;
    canonicalInstancedBatches++;
    if(!isInstanceCullingCandidate(object,0,2,{isMaterialCompatible:window.__auditGame.atmosphere.canCullInstanceMaterial}))return;
    eligibleInstancedBatches++;
    const triangles=(object.geometry.index?.count??object.geometry.getAttribute('position').count)/3;
    for(const row of thresholds)if(triangles>=row.minimumPrototypeTriangles){row.batches++;row.activeInstances+=object.count;row.allocatedInstanceSlots+=object.instanceMatrix.count;row.weightedTriangles+=triangles*object.count;row.fiveMatrixBuffersBytes+=object.instanceMatrix.count*64*5;}
   });
   return{policyModule:'/src/world/PassInstanceCuller.ts',policy:'isInstanceCullingCandidate(source, threshold, 2, {isMaterialCompatible: atmosphere.canCullInstanceMaterial}); only captured compatible CSM hooks are allowed; transparent, transmission, shader/morph/custom callbacks, custom instanced attributes or custom raycasting excluded.',cullerConstructed:!!window.__auditGame.rendering.instanceCulling,activeCuller:window.__auditGame.rendering.instanceCulling?.diagnostics??null,inventoryScope:'Canonical render-scene InstancedMeshes; render proxies excluded.',canonicalInstancedBatches,eligibleInstancedBatches,thresholds,memoryScope:'Five matrix attributes only, at allocated capacity; canonical matrices, indices, colors and acceleration-tree overhead excluded.'};
  }),30000,'Canonical instance eligibility inventory');
 }
 report.url='http://127.0.0.1:5173/?review=1';
 report.instrumentation='Development module injection for per-pass GPU attribution. Camera/light/caster-volume preparation and current instance selections are refreshed before every direct draw; their CPU time is reported separately outside GPU queries. Direct draws retain native scene-matrix traversal for baseline attribution continuity. Production frame cadence is measured separately by scripts/environments/profile-runtime.mjs.';
 if(!/NVIDIA.*RTX 3080/i.test(report.renderer))throw new Error(`Expected RTX 3080 hardware, received ${report.renderer}`);
 report.errors=errors;report.timingConditions=process.env.TIMING_CONDITIONS??'Caller must run with no concurrent Blender GPU renders. submissionMs is CPU submission duration; synchronizedFrameMs includes framebuffer readback; GPU times are reported separately only when timer queries are valid.';
 const reportPath=`${out}/${process.env.PIXEL_ONLY?'world-pixel-comparison':'world-pass-profile'}.json`;
 await writeFile(reportPath,JSON.stringify(report,null,2),{flag:'wx'});
 console.log('REPORT '+reportPath);
 console.log(JSON.stringify({renderer:report.renderer,gpuTimerAvailable:report.gpuTimerAvailable,rows:report.rows.map(({timings,...row})=>row),errors,glError:report.glError},null,2));
 if(errors.length||report.glError||!report.bounds.complete||report.movingCamera&&(report.movingCamera.status!=='passed'||report.movingCamera.glError)||report.receiverBoundsCandidateComparison?.status==='failed'||report.rows.some(row=>row.pixelComparison&&(row.pixelComparison.changedPixels>0||!row.pixelComparison.nonemptyBaseline)))process.exitCode=1;
}finally{await browser.close();}
