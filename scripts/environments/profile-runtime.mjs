import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalWorldInputs} from './runtime-validation-inputs.mjs';
import {sampleFrameWindow,withDeadline} from './profile-timing.mjs';
const output=new URL('../../artifacts/four-horizons/viewer/',import.meta.url);
await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile(new URL('../../public/environments/world-manifest.json',import.meta.url),'utf8'));
const inputEvidence=await finalWorldInputs(manifest,{requireQuiet:true});
const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:['--enable-webgl','--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
try{
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('requestfailed',r=>errors.push(r.url()));
const start=performance.now();await page.goto((process.env.GAME_URL??'http://127.0.0.1:4173')+'/?review=1');
await page.waitForFunction(()=>!!window.__AIRPLANE_EXPERIENCE__?.reviewBiome,null,{timeout:300000});
const startupMs=performance.now()-start;
const scriptURLs=await page.evaluate(()=>Array.from(document.scripts).map(script=>script.src).filter(Boolean));
const productionBundle=[];
for(const url of scriptURLs){const response=await page.request.get(url);const bytes=await response.body();productionBundle.push({url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const actualGPU=await withDeadline(page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}),30000,'Hardware identification');
if(!/NVIDIA.*RTX 3080/i.test(actualGPU))throw new Error(`Expected RTX 3080 hardware, received ${actualGPU}`);
console.log('LOADED',startupMs);
const views=[];
for(const biome of manifest.biomes){
 await withDeadline(page.evaluate(id=>window.__AIRPLANE_EXPERIENCE__.reviewBiome(id,120),biome.id),30000,`${biome.id} camera setup`);
 const warmup=await withDeadline(page.evaluate(sampleFrameWindow,{maxFrames:90,maxDurationMs:30000}),60000,`${biome.id} warmup`);
 const sample=await withDeadline(page.evaluate(sampleFrameWindow,{maxFrames:180,maxDurationMs:60000}),90000,`${biome.id} sample`);
 const intervals=[...sample.intervals].sort((a,b)=>a-b);
 const diagnostics=await withDeadline(page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.diagnostics),30000,`${biome.id} diagnostics`);
 const measurements={frames:sample.frames,frameIntervalP50:intervals[Math.floor(intervals.length*.5)]??null,frameIntervalP95:intervals[Math.floor(intervals.length*.95)]??null,
  warmup:{frames:warmup.frames,elapsedMs:warmup.elapsedMs,timeBoundReached:warmup.timeBoundReached},sampling:{elapsedMs:sample.elapsedMs,timeBoundReached:sample.timeBoundReached,intervals:sample.intervals},
  confidence:sample.frames<30?'low':'standard',gpuTimeMs:null,cpuTimeMs:null,diagnostics};
 const file=`${biome.id}.png`;await page.screenshot({path:new URL(file,output).pathname.replace(/^\/(\w:)/,'$1'),timeout:30000});
 views.push({id:biome.id,screenshot:file,...measurements});console.log('PROFILE',biome.id,measurements.frameIntervalP50,measurements.frameIntervalP95);
}
const renderer=await withDeadline(page.evaluate(()=>{
 const canvas=document.querySelector('canvas');const gl=canvas.getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');
 return {backend:'WebGL2',renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,width:canvas.width,height:canvas.height,dpr:window.devicePixelRatio};
}),30000,'Final renderer diagnostics');
const report={timestamp:new Date().toISOString(),url:process.env.GAME_URL??'http://127.0.0.1:4173',browser:browser.version(),renderer,startupMs,errors,inputEvidence,quality:{depthMode:views[0]?.diagnostics.renderer.depthMode,cameraNear:.15,cameraFar:16000,compression:false,decimation:false,lod:false,adaptiveResolution:false,shadowMap:4096,shadowCascades:4,shadowSplitMeters:[100,450,1700,6000],shadowDepthCache:false,shadowFilter:'Receiver-plane-corrected 5-position / 20-comparison PCF, evaluated before divergent cascade selection',normalMapAnisotropy:'maximum supported',shadowCasterCulling:'Fade-expanded receiver volume extruded toward sun; full source geometry',renderResolution:'native'},checks:{productionLoading:{status:errors.length?'failed':'passed'},backend:{status:'passed',reason:'Existing aircraft simulator intentionally retains its WebGL2 renderer.'},hardwareAcceleration:{status:/NVIDIA.*RTX 3080/i.test(renderer.renderer??'')?'passed':'failed',reason:renderer.renderer},geometryTransfer:{status:views.every(v=>v.diagnostics.world.trianglePreservation)?'passed':'failed'},walking:{status:'not_applicable',reason:'Integration targets existing aircraft game, not a separate walking viewer.'},gpuTimestamps:{status:'not_applicable',reason:'Frame intervals are not GPU timings; scripts/profile-shadow-passes.mjs supplies separate hardware GPU timer queries.'}},warmupFrames:90,samplingFrames:180,views};
report.productionBundle=productionBundle;
report.quality.instanceCulling='Conservative per-instance AABBs for beauty and each shadow cascade, using complete original geometry and independent pass buffers.';
report.samplingPolicy={warmup:{maxFrames:90,maxDurationMs:30000},sample:{maxFrames:180,maxDurationMs:60000},lowConfidenceBelowIntervals:30,slowFramesDiscarded:false};
report.checks.frameCadenceSample={status:views.every(view=>view.frames>0)?'passed':'failed',reason:'Actual complete intervals are reported; fewer than 30 intervals is marked low confidence.'};
// Legacy fields express maxima; per-view fields above contain actual counts.
report.warmupFrames='up to 90';report.samplingFrames='up to 180';
await writeFile(new URL('runtime_validation.json',output),JSON.stringify(report,null,2));
if(errors.length||views.some(view=>view.frames===0)||Object.values(report.checks).some(check=>check.status==='failed'))process.exitCode=1;
}finally{await browser.close();}
