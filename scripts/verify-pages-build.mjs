// Private headless desktop smoke test. The user's browser and local preview are
// never opened or controlled; the server is loopback-only and closes on exit.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir,writeFile,stat,readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const source=path.join(root,'dist'),prefix='/openworld-plane/';
const output=path.join(root,'artifacts/pages-deployment-20260928');
const viewport={width:1920,height:900};
const report={complete:false,viewport,errors:[],networkFailures:[],startupCancelledRequests:[],invalidAssetRequests:[],rows:[]};
await mkdir(output,{recursive:true});
const html=await readFile(path.join(source,'index.html'),'utf8');
const bundle=html.match(/src="\.\/(assets\/index-[^"]+\.js)"/)?.[1];
if(!bundle||!(await readFile(path.join(source,bundle),'utf8')).includes('DecompressionStream'))
  throw new Error('Build the gzip Pages application before running its verification');
await stat(path.join(source,'environments/world-manifest.json.gz'));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json','.gz':'application/gzip','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if(!pathname.startsWith(prefix)||pathname.includes('\\')||pathname.includes('\0')){response.writeHead(404).end();return;}
    const relative=pathname.slice(prefix.length)||'index.html';
    if(relative.split('/').some(part=>part==='..'||part==='.')||path.isAbsolute(relative)){response.writeHead(404).end();return;}
    const file=path.resolve(source,relative);
    if(!file.startsWith(source+path.sep)){response.writeHead(404).end();return;}
    const info=await stat(file);
    if(!info.isFile()){response.writeHead(404).end();return;}
    response.writeHead(200,{'content-type':mime[path.extname(file)]??'application/octet-stream','content-length':info.size,'cache-control':'no-store'});
    if(request.method==='HEAD'){response.end();return;}
    const stream=createReadStream(file);stream.on('error',error=>response.destroy(error));stream.pipe(response);
  }catch(error){response.writeHead(error.code==='ENOENT'?404:500).end();}
});
let browser,progress;
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  report.url=`http://127.0.0.1:${server.address().port}${prefix}`;
  browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-renderer-backgrounding','--disable-background-timer-throttling']});
  const page=await browser.newPage({viewport,deviceScaleFactor:1});let assetRequests=0,startupComplete=false;
  const assetURLs=new Set();
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)report.networkFailures.push({url:response.url(),status:response.status()});});
  page.on('requestfailed',request=>{
    const item={url:request.url(),failure:request.failure()?.errorText};
    // The initial nearby stream cancels superseded requests when the full-world
    // residency pass takes ownership. Preparation and all 422 loaded cells are
    // asserted below; a cancellation after readiness remains an error.
    if(!startupComplete&&item.failure==='net::ERR_ABORTED')report.startupCancelledRequests.push(item);
    else report.networkFailures.push(item);
  });
  page.on('request',request=>{
    const pathname=new URL(request.url()).pathname;
    if(pathname.includes('/environments/')){
      assetRequests++;assetURLs.add(pathname);
      if(!pathname.startsWith(prefix+'environments/')||!pathname.endsWith('.gz'))report.invalidAssetRequests.push(pathname);
    }
  });
  await page.route('**/assets/index-*.js',async route=>{
    const response=await route.fetch(),code=await response.text();
    if(code.split('this.expose()').length!==2)throw new Error('Expected one application exposure point');
    report.bundle=new URL(route.request().url()).pathname;
    await route.fulfill({response,body:code.replace('this.expose()','(window.__verificationGame=this,this.expose())')});
  });
  const started=Date.now();await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:120000});
  progress=setInterval(()=>console.log(JSON.stringify({phase:'pages-startup',seconds:Math.round((Date.now()-started)/1000),assetRequests})),20000);
  await page.waitForFunction(()=>window.__verificationGame?.startupReady,null,{timeout:600000});
  startupComplete=true;clearInterval(progress);report.startupMs=Date.now()-started;
  report.assetRequestsAtStartup=assetRequests;report.uniqueAssetRequests=assetURLs.size;
  await page.evaluate(()=>{const g=window.__verificationGame;g.loop.stop();g.review=true;});
  report.graphics=await page.evaluate(()=>{
    const gl=window.__verificationGame.rendering.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return{renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),dpr:devicePixelRatio,samples:gl.getParameter(gl.SAMPLES),version:gl.getParameter(gl.VERSION)};
  });
  for(const biome of ['verdant-airfield','azure-port','alpine-lake','sunstone-oasis']){
    const row=await page.evaluate(async id=>{
      const g=window.__verificationGame;g.visitBiome(id);g.syncPresentation(0,true);await g.world.whenReady();g.syncPresentation(0,true);g.rendering.render(true);
      const s=g.world.streamingStats;
      if(g.viewDistance!==6000||g.rendering.scene.fog!==null||s.pinnedChunks!==422||s.preparedResidentChunks!==422||!s.preparationComplete||!g.world.isViewReady)
        throw new Error('Pages must retain the entire fog-free prepared world');
      if(g.rendering.residentBindingPreparation?.stage!=='complete'||g.loop.targetFps!==30)throw new Error('Pages must retain prepared graphics and the 30 FPS cadence');
      return{biome:id,ready:g.world.isViewReady,viewDistance:g.viewDistance,cameraFar:g.rendering.camera.far,fog:false,
        pinnedChunks:s.pinnedChunks,preparedResidentChunks:s.preparedResidentChunks,preparationComplete:s.preparationComplete,
        targetFps:g.loop.targetFps,loads:s.loads,evictions:s.evictions,passes:structuredClone(g.rendering.passes),
        distanceDetail:{...g.rendering.distanceDetail.statistics},bindingPreparation:g.rendering.residentBindingPreparation};
    },biome);
    report.rows.push(row);if(biome==='azure-port'||biome==='alpine-lake')await page.screenshot({path:path.join(output,biome+'.png')});
    console.log(JSON.stringify({phase:'pages-biome',biome,ready:row.ready,pinnedChunks:row.pinnedChunks,beautyTriangles:row.passes.beauty.triangles}));
  }
  report.assetRequestsAfterStartup=assetRequests-report.assetRequestsAtStartup;
  if(report.assetRequestsAfterStartup||report.errors.length||report.networkFailures.length||report.invalidAssetRequests.length)
    throw new Error('Pages has failed asset requests, incorrect subdirectory URLs, or runtime errors');
  report.complete=true;console.log(JSON.stringify({phase:'pages-complete',startupMs:report.startupMs,assetRequests,biomes:report.rows.length}));
}catch(error){report.failure=String(error);throw error;}
finally{
  clearInterval(progress);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(browser)await browser.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
