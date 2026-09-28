import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const out='artifacts/four-horizons/comparisons/optimization-baseline/port-shadow-pixel';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('requestfailed',request=>errors.push(request.url()));
 await page.route('**/src/game/Game.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('this.expose();','window.__auditGame=this;this.expose();')});});
 await page.goto('http://127.0.0.1:5173/?review=1');
 await page.waitForFunction(()=>window.__auditGame?.world?.diagnostics.ready,null,{timeout:240000});
 const setup=await page.evaluate(()=>{
  const game=window.__auditGame;game.loop.stop();
  window.__AIRPLANE_EXPERIENCE__.reviewBiome('verdant-airfield',120);
  window.__AIRPLANE_EXPERIENCE__.reviewBiome('azure-port',120);
  game.atmosphere.prepareRender();window.__portPixelEvidence=[];
  const renderer=game.rendering.renderer,gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  return{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),camera:{position:game.rendering.camera.position.toArray(),quaternion:game.rendering.camera.quaternion.toArray(),fov:game.rendering.camera.fov},world:game.world.diagnostics,depthMode:renderer.capabilities.logarithmicDepthBuffer?'logarithmic':'other'};
 });
 if(!/NVIDIA.*RTX 3080/i.test(setup.renderer))throw new Error(`Unexpected renderer ${setup.renderer}`);
 const frames=[];
 for(const [index,mode]of ['unfiltered','caster-volume','unfiltered','caster-volume'].entries()){
  const result=await page.evaluate(mode=>{
   const game=window.__auditGame,renderer=game.rendering.renderer,gl=renderer.getContext();
   game.atmosphere.casterVolumes.forEach(volume=>volume.enabled=mode==='caster-volume');
   renderer.render(game.rendering.scene,game.rendering.camera);
   const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
   gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   window.__portPixelEvidence.push({mode,pixels});
   return{png:renderer.domElement.toDataURL('image/png'),width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,glError:gl.getError()};
  },mode);
  const file=`${index}-${mode}.png`;await writeFile(`${out}/${file}`,Buffer.from(result.png.split(',')[1],'base64'));delete result.png;frames.push({index,mode,file,...result});
 }
 const comparisons=await page.evaluate(()=>{
  const frames=window.__portPixelEvidence,width=1440,height=900;
  return [[0,1],[2,3],[0,2],[1,3]].map(([a,b])=>{
   const first=frames[a].pixels,second=frames[b].pixels;let changedPixels=0,maxChannelDelta=0,totalRGBDelta=0;const differences=[];
   for(let p=0;p<first.length;p+=4){const delta=[0,1,2].map(c=>Math.abs(first[p+c]-second[p+c]));if(delta.some(Boolean)){changedPixels++;totalRGBDelta+=delta.reduce((sum,value)=>sum+value,0);maxChannelDelta=Math.max(maxChannelDelta,...delta);if(differences.length<128)differences.push({x:(p/4)%width,y:height-1-Math.floor(p/4/width),firstRGB:Array.from(first.slice(p,p+3)),secondRGB:Array.from(second.slice(p,p+3))});}}
   return{a,b,changedPixels,maxChannelDelta,totalRGBDelta,differences};
  });
 });
 const report={timestamp:new Date().toISOString(),purpose:'Untimed repeated localization of the strict baseline port shadow-culling pixel mismatch. One loaded scene, frozen camera/clouds/aircraft, no quality setting changes.',...setup,frames,comparisons,errors,strictBitwiseEqual:comparisons.every(row=>row.changedPixels===0)};
 await writeFile(`${out}/comparison.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({comparisons,errors,strictBitwiseEqual:report.strictBitwiseEqual},null,2));
 if(errors.length||frames.some(frame=>frame.glError))process.exitCode=1;
}finally{await browser.close();}
