// Same-scene queue diagnostic only. No production-loop or quality changes.
// Run only after the root agent releases the GPU and final source gates pass.
import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {finalWorldInputs} from './environments/runtime-validation-inputs.mjs';
import {withDeadline} from './environments/profile-timing.mjs';

const output='artifacts/four-horizons/comparisons/frame-queue';
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const inputEvidence=await finalWorldInputs(manifest,{requireQuiet:true});
const biome=process.env.BIOME??'verdant-airfield',origin=process.env.GAME_URL??'http://127.0.0.1:5173';
if(!manifest.biomes.some(value=>value.id===biome))throw Error('Unknown diagnostic biome');
await mkdir(output,{recursive:true});
const report={timestamp:new Date().toISOString(),biome,inputEvidence,origin,
 scope:'Low-count scheduling diagnostic: one loaded scene, full authored geometry, shadows, aircraft, clouds and VFX retained. Simulation/presentation delta is zero during measurement. Completed GPU fences are not proof of display presentation and are not game FPS.',
 limits:{framesPerMode:4,modeDeadlineMs:30000,totalMeasurementDeadlineMs:120000},rows:[],errors:[],complete:false};
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
page.on('pageerror',error=>report.errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
page.on('requestfailed',request=>report.errors.push(request.url()));
let baselinePixels=null;
try{
 await page.route('**/src/game/Game.ts*',async route=>{
  const response=await route.fetch(),body=await response.text();
  if(!body.includes('this.expose();'))throw Error('Diagnostic injection site changed');
  await route.fulfill({response,body:body.replace('this.expose();','window.__queueAuditGame=this; this.expose();')});
 });
 await page.goto(`${origin}/?review=1`,{timeout:120000});
 await page.waitForFunction(()=>window.__queueAuditGame?.world?.diagnostics.ready,null,{timeout:300000});
 report.fixture=await page.evaluate(biome=>{
  const game=window.__queueAuditGame;game.loop.stop();window.__AIRPLANE_EXPERIENCE__.reviewBiome(biome,120);game.loop.stop();
  const renderer=game.rendering.renderer,gl=renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
  const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!gl.fenceSync||!gl.clientWaitSync)throw Error('WebGL2 sync objects unavailable');
  const world=game.world.diagnostics;delete world.resourceIdentities;
  window.__frameQueueDiagnostic={game,renderer,gl,ext,started:performance.now()};
  return{renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),gpuTimerAvailable:!!ext,world,
   viewport:[gl.drawingBufferWidth,gl.drawingBufferHeight],depthMode:renderer.capabilities.logarithmicDepthBuffer?'logarithmic':'standard',near:game.rendering.camera.near,far:game.rendering.camera.far};
 },biome);
 if(!/NVIDIA.*RTX 3080/i.test(report.fixture.renderer))throw Error(`Unexpected hardware: ${report.fixture.renderer}`);
 // Install an in-page runner. Every mode uses the same flush and fence polling.
 await page.evaluate(()=>{
  const fixture=window.__frameQueueDiagnostic,{game,renderer,gl,ext}=fixture;
  const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const state=()=>{
   let effectsHash=2166136261;
   const mix=value=>{const bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);for(const byte of bytes)effectsHash=Math.imul(effectsHash^byte,16777619);};
   mix(game.atmosphere.clouds.instanceMatrix.array);
   game.vfx.root.traverse(object=>{if(object.geometry)for(const attribute of Object.values(object.geometry.attributes))mix(attribute.array);});
   const camera=game.rendering.camera;
   return{camera:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray(),flight:window.__AIRPLANE_EXPERIENCE__.state,
    cloudAndVfxHash:effectsHash>>>0,aircraftVisible:game.aircraft.root.visible,cloudsVisible:game.atmosphere.clouds.visible,vfxVisible:game.vfx.root.visible};
  };
  fixture.run=async(mode,target=4)=>{
   const maximumPending=mode==='normal'?Infinity:mode==='max-1'?1:2;
   const started=performance.now(),records=[];let rafCallbacks=0,gateWaitCallbacks=0,maxObservedPending=0,deadlineReached=false;
   const pending=()=>records.filter(record=>record.fenceCompletedAt===null).length;
   const poll=()=>{
    const now=performance.now();
    for(const record of records){
     if(record.fenceCompletedAt===null){
      const status=gl.clientWaitSync(record.sync,0,0);
      if(status===gl.WAIT_FAILED)throw Error('GPU fence wait failed');
      if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED){record.fenceCompletedAt=now;record.fenceLatencyObservedMs=now-record.submittedAt;record.afterReturnFenceLatencyMs=now-record.returnedAt;gl.deleteSync(record.sync);record.sync=null;}
     }
     if(record.query&&!record.queryCollected&&gl.getQueryParameter(record.query,gl.QUERY_RESULT_AVAILABLE)){
      const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);
      record.gpuTimeMs=disjoint?null:gl.getQueryParameter(record.query,gl.QUERY_RESULT)/1e6;
      record.gpuDisjoint=!!disjoint;record.queryCollected=true;
     }
    }
   };
   try{
    while(records.length<target||pending()){
     if(performance.now()-started>=30000||performance.now()-fixture.started>=120000){deadlineReached=true;break;}
     await nextFrame();rafCallbacks++;poll();
     if(records.length>=target)continue;
     if(pending()>=maximumPending){gateWaitCallbacks++;continue;}
     const submittedAt=performance.now(),record={index:records.length,submittedAt,prepareMs:0,renderSubmissionMs:0,fenceCompletedAt:null,fenceLatencyObservedMs:null,afterReturnFenceLatencyMs:null,gpuTimeMs:null,gpuDisjoint:null,queryCollected:false,sync:null,query:null};
     game.syncPresentation(0);record.prepareMs=performance.now()-submittedAt;
     if(ext){record.query=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,record.query);}
     const drawStarted=performance.now();game.rendering.render(true);record.renderSubmissionMs=performance.now()-drawStarted;
     if(ext)gl.endQuery(ext.TIME_ELAPSED_EXT);
     record.sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!record.sync)throw Error('GPU fence allocation failed');
     gl.flush();record.returnedAt=performance.now();record.passes=structuredClone(game.rendering.passes);records.push(record);
     maxObservedPending=Math.max(maxObservedPending,pending());
    }
    poll();
    const completed=records.filter(record=>record.fenceCompletedAt!==null),last=completed.length?Math.max(...completed.map(record=>record.fenceCompletedAt)):started;
    return{mode,requestedFrames:target,submittedFrames:records.length,completedFrames:completed.length,complete:records.length===target&&completed.length===target,
     deadlineReached,elapsedMs:performance.now()-started,rafCallbacks,gateWaitCallbacks,maxObservedPending,
     completedFenceRateHz:completed.length?completed.length*1000/(last-started):null,
     observation:'Fence completion is observed on RAF polling. fenceLatencyObservedMs starts before CPU preparation; afterReturnFenceLatencyMs starts after render/fence/flush return. Both include observation delay. GPU queries span commands between timer markers: CPU preparation precedes the first marker, but CPU-fed GPU idle gaps during submission can contribute, so this is not isolated shader execution time. RAF callbacks are never reported as rendered FPS.',
     confidence:'low: four frames per mode, fixed camera and zero simulation delta',
     records:records.map(({query,sync,...record})=>record),state:state(),glError:gl.getError()};
   }finally{for(const record of records){if(record.sync)gl.deleteSync(record.sync);if(record.query)gl.deleteQuery(record.query);}}
  };
 });
 // First-frame programs and buffers are warmed identically before comparisons.
 report.warmup=await withDeadline(page.evaluate(()=>window.__frameQueueDiagnostic.run('max-1',2)),35000,'Queue diagnostic warmup');
 if(!report.warmup.complete)throw Error('Warmup did not complete within its bounded window');
 for(const mode of ['normal','max-1','max-2']){
  const row=await withDeadline(page.evaluate(mode=>window.__frameQueueDiagnostic.run(mode),mode),35000,`${mode} queue measurement`);
  report.rows.push(row);await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
  if(!row.complete)break;
  const capture=await page.screenshot({path:`${output}/${mode}.png`,timeout:15000});
  const pixels=PNG.sync.read(capture);
  if(!baselinePixels){baselinePixels=pixels;row.pixelComparison={baseline:true,width:pixels.width,height:pixels.height};}
  else{
   if(pixels.width!==baselinePixels.width||pixels.height!==baselinePixels.height)throw Error('Capture dimensions changed');
   let changedPixels=0,maxChannelDelta=0;
   for(let i=0;i<pixels.data.length;i+=4){let changed=false;for(let c=0;c<3;c++){const delta=Math.abs(pixels.data[i+c]-baselinePixels.data[i+c]);changed ||= delta>0;maxChannelDelta=Math.max(maxChannelDelta,delta);}if(changed)changedPixels++;}
   row.pixelComparison={changedPixels,maxChannelDelta,width:pixels.width,height:pixels.height};
  }
  console.log('QUEUE',JSON.stringify({mode,submitted:row.submittedFrames,completed:row.completedFrames,elapsedMs:row.elapsedMs,pending:row.maxObservedPending,pixels:row.pixelComparison}));
 }
 report.sameFrozenState=report.rows.length===3&&report.rows.every(row=>JSON.stringify(row.state)===JSON.stringify(report.rows[0].state));
 report.pixelEquivalent=report.rows.length===3&&report.rows.slice(1).every(row=>row.pixelComparison?.changedPixels===0);
 report.complete=report.rows.length===3&&report.rows.every(row=>row.complete&&row.glError===0)&&report.sameFrozenState&&report.pixelEquivalent&&report.errors.length===0;
 if(!report.complete)process.exitCode=1;
}catch(error){report.errors.push(String(error?.stack??error));process.exitCode=1;}
finally{await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await browser.close();}
