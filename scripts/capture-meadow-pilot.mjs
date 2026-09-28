import { chromium } from '@playwright/test';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

if(process.env.MEADOW_PILOT_EXPORTED!=='1')throw new Error('Wait for MEADOW_PILOT_EXPORTED before capturing the new asset.');
const root=path.resolve('artifacts/four-horizons'),biome='verdant-airfield';
const output=path.join(root,'viewer','landscape-pilot');await mkdir(output,{recursive:true});
const registryPath=path.join(root,biome,'asset_registry.json');
const registryBytes=await readFile(registryPath),registry=JSON.parse(registryBytes);
const cameraSource='scripts/environments/review_landscape_pilot.py';
// Evaluate only the author's camera list and the shared pure terrain function.
// Neither bpy nor Blender is imported or launched by this read-only extraction.
const views=JSON.parse(execFileSync('python',['-c',
 `import ast,json,sys; from pathlib import Path; sys.path.insert(0,'scripts/environments'); from draw_layout import load_ground; tree=ast.parse(Path('${cameraSource}').read_text()); node=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='views' for t in n.targets)); env={'ground':load_ground()}; exec(compile(ast.Module(body=[node],type_ignores=[]),'pilot_cameras','exec'),env); print(json.dumps(env['views']))`
],{encoding:'utf8'}));
const width=1280,height=800,lensMm=32,sensorWidthMm=36;
const fov=2*Math.atan(sensorWidthMm*height/width/(2*lensMm))*180/Math.PI;
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('requestfailed',request=>errors.push(`${request.url()}: ${request.failure()?.errorText}`));
try{
 const started=performance.now();await page.goto('http://127.0.0.1:5173/?review=1',{timeout:120000});
 await page.waitForFunction(()=>!!window.__AIRPLANE_EXPERIENCE__?.reviewCamera,null,{timeout:240000});
 const startupMs=performance.now()-started;
 const backend=await page.evaluate(()=>{
  const gl=document.querySelector('#flight-canvas').getContext('webgl2'),extension=gl.getExtension('WEBGL_debug_renderer_info');
  return{renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),glError:gl.getError()};
 });
 if(!/NVIDIA.*RTX 3080/i.test(backend.renderer))throw new Error(`Expected the actual RTX 3080 backend, received ${backend.renderer}`);
 await page.evaluate(id=>window.__AIRPLANE_EXPERIENCE__.reviewBiome(id,100),biome);
 const frames=[];
 for(const [name,camera,target] of views){
  await page.evaluate(({camera,target,fov})=>window.__AIRPLANE_EXPERIENCE__.reviewCamera(camera,target,fov),{camera,target,fov});
  await page.evaluate(()=>new Promise(resolve=>{let count=0;function step(){if(++count>=4)resolve();else requestAnimationFrame(step);}requestAnimationFrame(step);}));
  const file=`game-after-${name}.png`;await page.screenshot({path:path.join(output,file),timeout:120000});
  const diagnostics=await page.evaluate(()=>{
   const d=window.__AIRPLANE_EXPERIENCE__.diagnostics;
   return{camera:d.camera,renderer:d.renderer,world:{sourceTriangles:d.world.sourceTriangles,trianglePreservation:d.world.trianglePreservation,
    biomeTransfers:d.world.biomeTransfers,sourceObjects:d.world.sourceObjects,renderBatches:d.world.renderBatches},mode:d.mode};
  });
  frames.push({name,file,camera,target,fov,sourceBefore:`${biome}/comparisons/landscape-before-${name}.png`,
   sourceAfter:`${biome}/comparisons/landscape-after-${name}.png`,diagnostics});
  console.log('PILOT_VIEW',name);
 }
 const transfer=frames[0].diagnostics.world.biomeTransfers.find(item=>item.id===biome);
 const report={timestamp:new Date().toISOString(),url:'http://127.0.0.1:5173/?review=1',backend,startupMs,
  scope:'Actual game integration at the three matching Blender pilot camera coordinates; no performance conclusions while Blender is active.',
  cameraSource,cameraSourceSha256:createHash('sha256').update(await readFile(cameraSource)).digest('hex'),
  sourceLensMm:lensMm,sourceSensorWidthMm:sensorWidthMm,viewport:{width,height,dpr:1},
  registrySha256:createHash('sha256').update(registryBytes).digest('hex'),expectedMeadowSource:registry.source,
  loadedMeadowTransfer:transfer,checks:{newMeadowTrianglesMatch:transfer.sourceTriangles===registry.source.triangles,
   sourceGeometryPreserved:transfer.sourceTriangles===transfer.renderedTriangles,threeViewsCaptured:frames.length===3,
   noBrowserErrors:errors.length===0,hardwareRenderer:!/(SwiftShader|Software)/i.test(backend.renderer)},frames,errors};
 await writeFile(path.join(output,'meadow-pilot-runtime.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({backend,loadedMeadowTransfer:transfer,expected:registry.source,checks:report.checks,errors},null,2));
 if(Object.values(report.checks).some(value=>!value)||backend.glError)process.exitCode=1;
}finally{await browser.close();}
