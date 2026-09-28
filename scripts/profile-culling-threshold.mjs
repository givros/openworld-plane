// Diagnostic only: run after an explicit GPU slot and final-source approval.
// No source geometry, production threshold or production loop is modified.
import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {finalWorldInputs} from './environments/runtime-validation-inputs.mjs';
import {withDeadline} from './environments/profile-timing.mjs';

const output='artifacts/four-horizons/comparisons/culling-threshold';
const origin=process.env.GAME_URL??'http://127.0.0.1:5173';
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const inputEvidence=await finalWorldInputs(manifest,{requireQuiet:true});
const ids=['verdant-airfield','azure-port','alpine-lake','sunstone-oasis'];
const poses=[];
for(const biome of ids){
 const cameras=JSON.parse(await readFile(`artifacts/four-horizons/${biome}/inspection_cameras.json`,'utf8'));
 const view=cameras.find(camera=>camera.id==='aerial');
 if(!view)throw Error(`Missing aerial pose: ${biome}`);
 poses.push({biome,...view});
}
const codeInputs=[];
for(const file of ['src/core/FullDetailWorldCulling.ts','src/world/PassInstanceCuller.ts','src/core/Renderer.ts','src/systems/Atmosphere.ts']){
 const bytes=await readFile(file);codeInputs.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await mkdir(output,{recursive:true});
const report={timestamp:new Date().toISOString(),origin,inputEvidence,codeInputs,poses,
 scope:'Low-count threshold diagnostic on one fully loaded scene. Two warmup frames and three completed measured GPU frames per threshold and pose. Full geometry, textures, materials, shadows, aircraft, clouds and VFX retained; zero simulation delta during each comparison. No FPS claim.',
 limits:{thresholds:[4096,2048],warmupFrames:2,measuredFrames:3,frameCompletionDeadlineMs:15000,thresholdDeadlineMs:90000,measurementDeadlineMs:240000},rows:[],errors:[],complete:false};
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
page.on('pageerror',error=>report.errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
page.on('requestfailed',request=>report.errors.push(request.url()));
const save=()=>writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
try{
 await page.route('**/src/game/Game.ts*',async route=>{
  const response=await route.fetch(),body=await response.text();
  if(!body.includes('this.expose();'))throw Error('Diagnostic injection site changed');
  await route.fulfill({response,body:body.replace('this.expose();','window.__thresholdGame=this; this.expose();')});
 });
 const started=performance.now();
 await page.goto(`${origin}/?review=1`,{timeout:120000});
 await page.waitForFunction(()=>window.__thresholdGame?.world?.diagnostics.ready,null,{timeout:300000});
 report.startupMs=performance.now()-started;
 report.fixture=await page.evaluate(async()=>{
  const game=window.__thresholdGame;game.loop.stop();
  const {FullDetailWorldCulling}=await import('/src/core/FullDetailWorldCulling.ts');
  const renderer=game.rendering.renderer,gl=renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
  const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!ext||!gl.fenceSync)throw Error('Completed WebGL2 GPU timing is required');
  game.rendering.disposeWorldCulling();
  const attributes=new Map(),objects=[];
  const remember=attribute=>{
   if(!attribute||attributes.has(attribute))return;
   const data=attribute.isInterleavedBufferAttribute?attribute.data:attribute;
   attributes.set(attribute,{data,array:data.array,version:data.version,count:attribute.count,itemSize:attribute.itemSize,normalized:attribute.normalized});
  };
  game.world.root.traverse(object=>{
   if(!object.isMesh)return;
   const geometry=object.geometry;
   remember(geometry.index);for(const attribute of Object.values(geometry.attributes))remember(attribute);
   for(const attributes of Object.values(geometry.morphAttributes))for(const attribute of attributes)remember(attribute);
   remember(object.instanceMatrix);remember(object.instanceColor);
   objects.push({object,geometry,material:object.material,count:object.count,
    index:geometry.index,attributes:{...geometry.attributes},morphAttributes:Object.fromEntries(Object.entries(geometry.morphAttributes).map(([key,value])=>[key,[...value]])),
    instanceMatrix:object.instanceMatrix,instanceColor:object.instanceColor,
    matrix:object.matrix.clone(),worldMatrix:object.matrixWorld.clone(),
    instanceValues:object.instanceMatrix?object.instanceMatrix.array.slice():null});
  });
  const canonicalCheck=()=>{
   let failures=0,matricesChecked=0;
   for(const row of objects){
    const o=row.object,g=o.geometry;
    if(g!==row.geometry||o.material!==row.material||o.count!==row.count||g.index!==row.index||
       o.instanceMatrix!==row.instanceMatrix||o.instanceColor!==row.instanceColor||
       !o.matrix.equals(row.matrix)||!o.matrixWorld.equals(row.worldMatrix))failures++;
    if(Object.keys(g.attributes).length!==Object.keys(row.attributes).length)failures++;
    for(const [key,value]of Object.entries(row.attributes))if(g.attributes[key]!==value)failures++;
    if(Object.keys(g.morphAttributes).length!==Object.keys(row.morphAttributes).length)failures++;
    for(const [key,values]of Object.entries(row.morphAttributes))if(values.length!==g.morphAttributes[key]?.length||values.some((value,index)=>g.morphAttributes[key][index]!==value))failures++;
    if(row.instanceValues){matricesChecked+=o.count;for(let i=0;i<row.instanceValues.length;i++)if(row.instanceValues[i]!==o.instanceMatrix.array[i]){failures++;break;}}
   }
   for(const [attribute,row]of attributes){const data=attribute.isInterleavedBufferAttribute?attribute.data:attribute;if(data!==row.data||data.array!==row.array||data.version!==row.version||attribute.count!==row.count||attribute.itemSize!==row.itemSize||attribute.normalized!==row.normalized)failures++;}
   return{passes:failures===0,failures,sourceMeshesChecked:objects.length,attributesChecked:attributes.size,instanceMatricesChecked:matricesChecked,
    method:'Canonical object/geometry/material/attribute identity and revision invariance, plus exact world/local and every canonical instance-matrix value. No source arrays are compacted or rewritten.'};
  };
  const state=()=>{
   let effectsHash=2166136261;
   const mix=array=>{const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);for(const byte of bytes)effectsHash=Math.imul(effectsHash^byte,16777619);};
   mix(game.atmosphere.clouds.instanceMatrix.array);
   game.vfx.root.traverse(object=>{if(object.geometry)for(const attribute of Object.values(object.geometry.attributes))mix(attribute.array);});
   return{camera:game.rendering.camera.matrixWorld.toArray(),projection:game.rendering.camera.projectionMatrix.toArray(),flight:window.__AIRPLANE_EXPERIENCE__.state,effectsHash:effectsHash>>>0,
    aircraftVisible:game.aircraft.root.visible,cloudsVisible:game.atmosphere.clouds.visible,vfxVisible:game.vfx.root.visible};
  };
  const frame=async()=>{
   const record={presentationPrepareMs:0,cullingCPUMs:0,cullingPrepareCalls:0,renderCallMs:0,gpuTimeMs:null,gpuDisjoint:null,completed:false};
   const begin=performance.now();game.syncPresentation(0);record.presentationPrepareMs=performance.now()-begin;
   const query=gl.createQuery();let sync=null,queryActive=false;
   const original=game.rendering.prepareWorldCulling;
   game.rendering.prepareWorldCulling=function(){
    const start=performance.now();original.call(this);record.cullingCPUMs+=performance.now()-start;record.cullingPrepareCalls++;
    if(record.cullingPrepareCalls!==1)throw Error('Unexpected duplicate culling preparation');
    gl.beginQuery(ext.TIME_ELAPSED_EXT,query);queryActive=true;
   };
   try{
    const renderStarted=performance.now();game.rendering.render(true);record.renderCallMs=performance.now()-renderStarted;
    if(!queryActive)throw Error('Renderer bypassed prepareWorldCulling');
    gl.endQuery(ext.TIME_ELAPSED_EXT);queryActive=false;
    sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!sync)throw Error('Cannot allocate GPU fence');gl.flush();
    record.returnedAt=performance.now();record.passes=structuredClone(game.rendering.passes);
    while(performance.now()-record.returnedAt<15000){
     await new Promise(resolve=>requestAnimationFrame(resolve));
     const status=gl.clientWaitSync(sync,0,0);if(status===gl.WAIT_FAILED)throw Error('GPU fence failed');
     if((status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)&&gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
      record.gpuDisjoint=!!gl.getParameter(ext.GPU_DISJOINT_EXT);
      record.gpuTimeMs=record.gpuDisjoint?null:gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
      record.completedAt=performance.now();record.afterReturnWaitMs=record.completedAt-record.returnedAt;
      record.completed=!record.gpuDisjoint;break;
     }
    }
    record.glError=gl.getError();return record;
   }finally{game.rendering.prepareWorldCulling=original;if(queryActive)gl.endQuery(ext.TIME_ELAPSED_EXT);if(sync)gl.deleteSync(sync);gl.deleteQuery(query);}
  };
  window.__thresholdFixture={game,renderer,gl,FullDetailWorldCulling,canonicalCheck,state,frame,started:performance.now()};
  const world=game.world.diagnostics;delete world.resourceIdentities;
  return{backend:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),world,viewport:[gl.drawingBufferWidth,gl.drawingBufferHeight],
   logarithmicDepth:renderer.capabilities.logarithmicDepthBuffer,initialSourceCheck:canonicalCheck()};
 });
 if(!/NVIDIA.*RTX 3080/i.test(report.fixture.backend))throw Error(`Unexpected hardware: ${report.fixture.backend}`);
 for(const pose of poses){
  await withDeadline(page.evaluate(pose=>{
   const game=window.__thresholdFixture.game;game.loop.stop();
   window.__AIRPLANE_EXPERIENCE__.reviewBiome(pose.biome,120);
   window.__AIRPLANE_EXPERIENCE__.reviewCamera(pose.camera,pose.target,pose.fov);game.loop.stop();
  },pose),30000,'Frozen pose setup');
  let baselinePixels=null,baselineState=null;
  for(const threshold of [4096,2048]){
   const row=await withDeadline(page.evaluate(async threshold=>{
    const f=window.__thresholdFixture,{game,renderer,FullDetailWorldCulling}=f;
    if(performance.now()-f.started>240000)throw Error('Threshold diagnostic deadline reached');
    const disposeStarted=performance.now();game.rendering.disposeWorldCulling();const disposeMs=performance.now()-disposeStarted;
    const constructStarted=performance.now();
    const adapter=new FullDetailWorldCulling(game.world.root,game.rendering.scene,game.rendering.camera,game.atmosphere.instanceShadowPasses,game.atmosphere.canCullInstanceMaterial,threshold);
    adapter.automaticSelection=false;
    game.rendering.instanceCulling=adapter;renderer.setOpaqueSort(adapter.culler.opaqueSort);
    const constructMs=performance.now()-constructStarted,warmup=[],measured=[];
    for(let i=0;i<5;i++){
     const frame=await f.frame();(i<2?warmup:measured).push(frame);
     if(!frame.completed||frame.glError)throw Error('A full measured GPU frame did not complete cleanly');
    }
    return{threshold,disposeMs,constructMs,warmup,measured,culling:adapter.diagnostics,state:f.state(),sourceCheck:f.canonicalCheck()};
   },threshold),90000,`${pose.biome}/${threshold}`);
   row.biome=pose.biome;row.pose=pose.id;
   report.rows.push(row);await save();
   const capture=await page.screenshot({path:`${output}/${pose.biome}-${threshold}.png`,timeout:20000});
   const pixels=PNG.sync.read(capture);
   if(!baselinePixels){baselinePixels=pixels;baselineState=row.state;row.pixelComparison={baseline:true,width:pixels.width,height:pixels.height};row.sameFrozenState=true;}
   else{
    if(pixels.width!==baselinePixels.width||pixels.height!==baselinePixels.height)throw Error('Native capture dimensions changed');
    let changedPixels=0,maxChannelDelta=0;
    for(let i=0;i<pixels.data.length;i+=4){let changed=false;for(let c=0;c<3;c++){const delta=Math.abs(pixels.data[i+c]-baselinePixels.data[i+c]);changed||=delta>0;maxChannelDelta=Math.max(maxChannelDelta,delta);}if(changed)changedPixels++;}
    row.pixelComparison={changedPixels,maxChannelDelta,width:pixels.width,height:pixels.height};row.sameFrozenState=JSON.stringify(row.state)===JSON.stringify(baselineState);
   }
   console.log('THRESHOLD',JSON.stringify({biome:row.biome,threshold,constructMs:row.constructMs,matrixBytes:row.culling.allocatedMatrixBufferBytes,gpuMs:row.measured.map(frame=>frame.gpuTimeMs),cullingMs:row.measured.map(frame=>frame.cullingCPUMs),pixels:row.pixelComparison,sourcePreserved:row.sourceCheck.passes}));
   await save();
  }
 }
 report.complete=report.rows.length===8&&report.rows.every(row=>row.sourceCheck.passes&&row.sameFrozenState&&row.measured.length===3&&row.measured.every(frame=>frame.completed&&!frame.glError)&& (row.pixelComparison.baseline||row.pixelComparison.changedPixels===0))&&!report.errors.length;
 report.measurementNotes='Three measured frames per setting are a low-count diagnostic, not game FPS. Query markers begin after culling preparation, but GPU idle gaps during CPU command submission may contribute. One full frame is completed before the next submission, identically for both thresholds. Screenshots and canonical-source checks are outside timed intervals. Threshold order is fixed and not randomized.';
 if(!report.complete)process.exitCode=1;
}catch(error){report.errors.push(String(error?.stack??error));process.exitCode=1;}
finally{await save();await browser.close();}
