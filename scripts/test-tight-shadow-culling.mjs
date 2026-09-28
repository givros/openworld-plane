// Isolated, frozen-scene quality gate. Timings are GPU attribution, not RAF FPS.
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withDeadline } from './environments/profile-timing.mjs';

const output=path.resolve(process.env.TIGHT_SHADOW_OUTPUT??`artifacts/four-horizons/streaming-performance/tight-shadow-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const origin=process.env.GAME_URL??'http://127.0.0.1:5173';
const padding=Number(process.env.EXTRA_CASTER_PADDING??0);
if(!Number.isFinite(padding)||padding<0)throw Error('EXTRA_CASTER_PADDING must be nonnegative.');
await mkdir(output,{recursive:true});
const report={timestamp:new Date().toISOString(),origin,extraCasterPaddingMeters:padding,
  scope:'300m base distance, unchanged source geometry/materials, native 1440x900 4xMSAA and four 4096px PCF cascades. Frozen scene and settled streaming. GPU queries exclude CPU preparation; direct synchronized draws do not measure production frame cadence.',
  sourceFiles:[],rows:[],errors:[],complete:false};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of ['src/game/Game.ts','src/core/Renderer.ts','src/systems/Atmosphere.ts','src/world/PassInstanceCuller.ts','src/world/SpatialWorldStream.ts']){
  const bytes=await readFile(file);report.sourceFiles.push({file,sha256:hash(bytes)});
}
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
function compare(a,b,filename){
  const aa=PNG.sync.read(Buffer.from(a,'base64')),bb=PNG.sync.read(Buffer.from(b,'base64'));
  if(aa.width!==bb.width||aa.height!==bb.height)throw Error('Framebuffer size changed.');
  const diff=new PNG({width:aa.width,height:aa.height});
  let changedPixels=0,maxChannelDelta=0,totalRgbDelta=0,minX=aa.width,minY=aa.height,maxX=-1,maxY=-1;
  for(let i=0;i<aa.data.length;i+=4){let changed=false;for(let c=0;c<3;c++){
    const d=Math.abs(aa.data[i+c]-bb.data[i+c]);changed||=d!==0;maxChannelDelta=Math.max(maxChannelDelta,d);totalRgbDelta+=d;diff.data[i+c]=Math.min(255,d*12);
  }diff.data[i+3]=255;if(changed){changedPixels++;const p=i/4,x=p%aa.width,y=Math.floor(p/aa.width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
  return {stats:{changedPixels,maxChannelDelta,totalRgbDelta,meanAbsRgbDelta:totalRgbDelta/(aa.width*aa.height*3),bounds:changedPixels?[minX,minY,maxX,maxY]:null},diff:PNG.sync.write(diff),filename};
}
const browser=await chromium.launch({headless:true,args:['--enable-webgl','--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
let closing=false;
try{
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  page.on('pageerror',e=>report.errors.push({kind:'runtime',message:e.message}));
  page.on('console',m=>{if(m.type()==='error')report.errors.push({kind:'console',message:m.text()});});
  page.on('requestfailed',r=>{if(!closing)report.errors.push({kind:'network',url:r.url(),failure:r.failure()});});
  await page.route('**/src/game/Game.ts*',async route=>{
    const response=await route.fetch(),original=await response.text();
    if(!original.includes('this.expose();'))throw Error('Game injection marker missing.');
    await route.fulfill({response,body:original.replace('this.expose();','window.__auditGame = this; this.expose();')});
  });
  await page.goto(`${origin}/?review=1`,{timeout:120000});
  await page.waitForFunction(()=>window.__auditGame&&window.__AIRPLANE_EXPERIENCE__?.setTightShadowCulling,null,{timeout:180000});
  report.hardware=await page.evaluate(()=>{
    const g=window.__auditGame;g.loop.stop();const r=g.rendering.renderer,gl=r.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,samples:gl.getParameter(gl.SAMPLES),context:gl.getContextAttributes(),dpr:r.getPixelRatio()};
  });
  if(!/RTX 3080/.test(report.hardware.renderer)||report.hardware.width!==1440||report.hardware.height!==900||report.hardware.samples!==4||report.hardware.dpr!==1)throw Error('Hardware/quality prerequisites failed.');
  const poses=[{id:'meadow-pilot80',biome:'verdant-airfield',altitude:80,yawOffset:0},{id:'meadow-pilot40-turn',biome:'verdant-airfield',altitude:40,yawOffset:.6},{id:'port-pilot80',biome:'azure-port',altitude:80,yawOffset:0},{id:'alpine-pilot80',biome:'alpine-lake',altitude:80,yawOffset:0}];
  for(const pose of poses){
    await withDeadline(page.evaluate(pose=>{
      const api=window.__AIRPLANE_EXPERIENCE__;api.setReviewMode(true);api.setRenderDistance(300);api.visitBiome(pose.biome);
      const s=api.state;api.setFlightState({position:{...s.position,y:s.position.y-s.altitude+pose.altitude},yaw:s.yaw+pose.yawOffset,speed:45,throttle:.72,rpm:2002,pitch:.025,bank:0,verticalSpeed:0,flightPathAngle:0,angleOfAttack:.025,pitchRate:0,rollRate:0,yawRate:0,grounded:false,crashed:false,phase:'flight'});
    },pose),45000,'Pose setup');
    const settling=await withDeadline(page.evaluate(()=>new Promise(resolve=>{
      const start=performance.now();const poll=()=>{const stats=window.__AIRPLANE_EXPERIENCE__.getStreamingStats();
        if((stats.ready&&stats.streaming.loadingChunks===0)||performance.now()-start>=20000)resolve({elapsedMs:performance.now()-start,stats});else setTimeout(poll,100);};poll();
    })),45000,'Streaming settling');
    if(!settling.stats.ready||settling.stats.streaming.loadingChunks!==0){report.rows.push({pose,settling,status:'inconclusive: residency not settled'});await save();break;}
    const row=await withDeadline(page.evaluate(async({pose,padding})=>{
      const game=window.__auditGame,api=window.__AIRPLANE_EXPERIENCE__,rendering=game.rendering,renderer=rendering.renderer,gl=renderer.getContext();
      const {renderSceneWithPreparedMatrices}=await import('/src/core/renderSceneWithPreparedMatrices.ts');
      const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');if(!ext)throw Error('GPU timers unavailable.');
      const original=renderer.shadowMap.render,autoReset=renderer.info.autoReset,originalTight=game.atmosphere.tightShadowCulling;
      const descriptors=game.atmosphere.casterVolumes.map(v=>Object.getOwnPropertyDescriptor(v,'clippingVolume'));
      if(padding)for(const volume of game.atmosphere.casterVolumes){const getter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(volume),'clippingVolume').get;
        Object.defineProperty(volume,'clippingVolume',{configurable:true,get(){const value=getter.call(this);return {...value,planes:value.planes.map(plane=>{const copy=plane.clone();copy.constant+=padding*copy.normal.length();return copy;})};}});
      }
      const initialStats=structuredClone(api.getStreamingStats()),initialRevision=game.world.renderRevision,modes=[];
      const encode=pixels=>{const canvas=document.createElement('canvas');canvas.width=gl.drawingBufferWidth;canvas.height=gl.drawingBufferHeight;const context=canvas.getContext('2d'),data=context.createImageData(canvas.width,canvas.height),stride=canvas.width*4;
        for(let y=0;y<canvas.height;y++)data.data.set(pixels.subarray(y*stride,(y+1)*stride),(canvas.height-y-1)*stride);context.putImageData(data,0,0);return canvas.toDataURL('image/png').split(',')[1];};
      try{
        renderer.info.autoReset=false;
        for(const [name,tight] of [['baseline0',false],['baseline1',false],['tight0',true],['tight1',true],['baseline2',false]]){
          game.atmosphere.tightShadowCulling=tight;const samples=[];let png;
          for(let sample=-1;sample<3;sample++){
            const before=performance.now();game.atmosphere.prepareRender();const afterAtmo=performance.now();rendering.prepareWorldCulling();const afterCull=performance.now();renderer.info.reset();
            const shadowQ=gl.createQuery(),beautyQ=gl.createQuery();let shadowStats,startedBeauty=false;
            renderer.shadowMap.render=function(...args){gl.beginQuery(ext.TIME_ELAPSED_EXT,shadowQ);original.apply(this,args);gl.endQuery(ext.TIME_ELAPSED_EXT);shadowStats={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};gl.beginQuery(ext.TIME_ELAPSED_EXT,beautyQ);startedBeauty=true;};
            const start=performance.now();renderSceneWithPreparedMatrices(renderer,rendering.scene,rendering.camera);if(!startedBeauty)throw Error('Shadow pass missing');gl.endQuery(ext.TIME_ELAPSED_EXT);const submissionMs=performance.now()-start;
            gl.finish();const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
            const end=performance.now(),deadline=end+2000;while(!gl.getQueryParameter(beautyQ,gl.QUERY_RESULT_AVAILABLE)&&performance.now()<deadline)await new Promise(r=>setTimeout(r,2));
            const valid=gl.getQueryParameter(beautyQ,gl.QUERY_RESULT_AVAILABLE)&&gl.getQueryParameter(shadowQ,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(ext.GPU_DISJOINT_EXT);
            if(sample>=0)samples.push({atmospherePreparationMs:afterAtmo-before,cullingPreparationMs:afterCull-afterAtmo,submissionMs,synchronizedDrawReadMs:end-start,shadowGpuMs:valid?gl.getQueryParameter(shadowQ,gl.QUERY_RESULT)/1e6:null,beautyGpuMs:valid?gl.getQueryParameter(beautyQ,gl.QUERY_RESULT)/1e6:null,gpuValid:valid,shadow:shadowStats,beauty:{calls:renderer.info.render.calls-shadowStats.calls,triangles:renderer.info.render.triangles-shadowStats.triangles},glError:gl.getError()});
            gl.deleteQuery(shadowQ);gl.deleteQuery(beautyQ);if(sample===2)png=encode(pixels);
          }
          modes.push({name,tight,samples,png,culling:structuredClone(rendering.instanceCulling?.diagnostics??null)});
        }
        return {pose,camera:{position:rendering.camera.position.toArray(),quaternion:rendering.camera.quaternion.toArray(),near:rendering.camera.near,far:rendering.camera.far,fov:rendering.camera.fov},initialStats,finalStats:structuredClone(api.getStreamingStats()),initialRevision,finalRevision:game.world.renderRevision,modes};
      }finally{renderer.shadowMap.render=original;renderer.info.autoReset=autoReset;game.atmosphere.tightShadowCulling=originalTight;game.atmosphere.casterVolumes.forEach((volume,i)=>{if(descriptors[i])Object.defineProperty(volume,'clippingVolume',descriptors[i]);else delete volume.clippingVolume;});}
    },{pose,padding}),120000,`${pose.id} frozen shadow A/B`);
    row.settling=settling;row.comparisons=[];
    for(const [a,b] of [[0,1],[2,3],[0,4],[0,2]]){
      const filename=`${pose.id}-${row.modes[a].name}-${row.modes[b].name}-diff.png`,result=compare(row.modes[a].png,row.modes[b].png,filename);
      row.comparisons.push({a:row.modes[a].name,b:row.modes[b].name,...result.stats,diff:filename});await writeFile(path.join(output,filename),result.diff);
    }
    for(const mode of row.modes){mode.image=`${pose.id}-${mode.name}.png`;await writeFile(path.join(output,mode.image),Buffer.from(mode.png,'base64'));delete mode.png;}
    row.status=row.initialRevision===row.finalRevision&&row.comparisons.every(c=>c.changedPixels===0)&&row.modes.every(m=>m.samples.every(s=>s.glError===0&&s.gpuValid))?'passed':'failed';
    report.rows.push(row);await save();console.log('TIGHT_SHADOW',JSON.stringify({pose:pose.id,status:row.status,comparisons:row.comparisons,samples:row.modes.map(m=>({mode:m.name,sample:m.samples[1]}))}));
    if(row.status!=='passed')break;
  }
  report.complete=report.rows.length===4&&report.rows.every(r=>r.status==='passed');
  for(const source of report.sourceFiles)source.unchanged=hash(await readFile(source.file))===source.sha256;
  if(report.sourceFiles.some(source=>!source.unchanged))report.errors.push({kind:'source-changed-during-gate'});
}catch(error){report.errors.push({kind:'harness',message:String(error),stack:error.stack});console.error(error);}
finally{closing=true;await browser.close();await save();}
console.log('REPORT',path.join(output,'report.json'));
if(!report.complete||report.errors.length)process.exitCode=1;
