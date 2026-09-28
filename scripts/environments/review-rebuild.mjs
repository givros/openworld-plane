import { chromium } from '@playwright/test';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {finalWorldInputs} from './runtime-validation-inputs.mjs';
const root=path.resolve('artifacts/four-horizons');
const output=path.join(root,'viewer','reference-rebuild');await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const inputEvidence=process.env.FINAL_WORLD_READY==='1'?await finalWorldInputs(manifest):null;
const selectedViews=(process.env.VIEWS??'aerial,hero,street,village,shore,landscape,ground-cover,human-network,vineyard-ground').split(',');
const sourcePassViews=(process.env.SOURCE_PASS_VIEWS??selectedViews.join(',')).split(',');
const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
try{
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('requestfailed',r=>errors.push(r.url()));
const start=performance.now();await page.goto((process.env.GAME_URL??'http://127.0.0.1:5173')+'/?review=1');
await page.waitForFunction(()=>!!window.__AIRPLANE_EXPERIENCE__?.reviewCamera,null,{timeout:300000});
const startupMs=performance.now()-start;console.log('READY',startupMs);const frames=[];
const actualGPU=await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
if(!/NVIDIA.*RTX 3080/i.test(actualGPU))throw new Error(`Expected RTX 3080 hardware, received ${actualGPU}`);
const scriptURLs=await page.evaluate(()=>Array.from(document.scripts).map(script=>script.src).filter(Boolean));
const productionBundle=[];
for(const url of scriptURLs){const response=await page.request.get(url);const bytes=await response.body();productionBundle.push({url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
for(const biome of manifest.biomes){
 if(process.env.BIOME&&biome.id!==process.env.BIOME)continue;
 const cameras=JSON.parse(await readFile(path.join(root,biome.id,'inspection_cameras.json'),'utf8'));
 const sourceValidation=JSON.parse(await readFile(path.join(root,biome.id,'source_validation.json'),'utf8'));
 const validatedSources=new Map(sourceValidation.renders.map(file=>[path.basename(file).replace(/^pass-\d+-/,'').replace(/\.png$/,''),file]));
 await page.evaluate(id=>window.__AIRPLANE_EXPERIENCE__.reviewBiome(id,100),biome.id);
 for(const camera of cameras.filter(c=>selectedViews.includes(c.id))){
  const changedSourceView=process.env.SOURCE_PASS&&sourcePassViews.includes(camera.id);
  const source=changedSourceView?`renders/pass-${process.env.SOURCE_PASS}-${camera.id}.png`:(validatedSources.get(camera.id)??camera.source);
  if(changedSourceView)await readFile(path.join(root,biome.id,source));
  await page.evaluate(c=>window.__AIRPLANE_EXPERIENCE__.reviewCamera(c.camera,c.target,c.fov),camera);
  // reviewCamera places and renders the exact pose immediately. Require two
  // additional game frames to exercise the live renderer without an arbitrary
  // eight-frame delay, then verify the pose stayed fixed.
  await page.evaluate(()=>new Promise(resolve=>{const first=window.__AIRPLANE_EXPERIENCE__.diagnostics.frame;const frame=()=>window.__AIRPLANE_EXPERIENCE__.diagnostics.frame>=first+2?resolve():requestAnimationFrame(frame);requestAnimationFrame(frame);}));
  const file=`${biome.id}-${camera.id}.png`;await page.screenshot({path:path.join(output,file),timeout:120000});
  const diagnostics=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.diagnostics);
  const actual=diagnostics.camera;
  if(Math.hypot(actual.position.x-camera.camera[0],actual.position.y-camera.camera[1],actual.position.z-camera.camera[2])>1e-7||Math.abs(actual.fov-camera.fov)>1e-7)throw new Error(`${biome.id}/${camera.id}: review camera moved before capture`);
  frames.push({biome:biome.id,view:camera.id,file,source,camera:{...camera,source},diagnostics});
  console.log('VIEW',biome.id,camera.id);
 }
}
await writeFile(path.join(output,process.env.BIOME?`${process.env.BIOME}-review.json`:'review.json'),JSON.stringify({timestamp:new Date().toISOString(),errors,startupMs,inputEvidence,actualGPU,productionBundle,selectedViews,capturePolicy:'Exact review pose rendered immediately, followed by two additional game frames and a fixed-position/FOV assertion before accepting each capture.',scope:inputEvidence?'Current final exports / visual integration':'Intermediate asset snapshot / visual integration only',frames},null,2));
if(!process.env.BIOME)await writeFile(path.join(output,'production-bundle.json'),JSON.stringify({timestamp:new Date().toISOString(),scripts:productionBundle},null,2));
if(errors.length){console.error(errors);process.exitCode=1;}
}finally{await browser.close();}
