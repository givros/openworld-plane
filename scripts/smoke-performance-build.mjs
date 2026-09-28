import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const origin=process.env.GAME_URL??'http://127.0.0.1:4173';
const output=process.env.PROFILE_ROOT??'artifacts/performance-20260926';
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist']});
const preload=process.env.RAM_PRELOAD==='1';
const optimized=process.env.OPTIMIZED_WORLD==='1',distance=Number(process.env.VIEW_DISTANCE??300);
const report={origin,preload,errors:[],networkFailures:[],rows:[],complete:false};
try{
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  let assetRequests=0;
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/environments/'))assetRequests++;});
  page.on('pageerror',e=>report.errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
  page.on('response',r=>{if(r.status()>=400)report.networkFailures.push({url:r.url(),status:r.status()});});
  await page.goto(`${origin}/?review=1&view=${distance}${preload?'&preload=1':''}${optimized?'&fragmentShadows=1&cacheShadows=1&pruneTraversal=1&immutableWorld=1&clearView=1':''}`,{timeout:120000});
  await page.waitForFunction(()=>!!window.__AIRPLANE_EXPERIENCE__,null,{timeout:300000});
  const startupRequests=assetRequests;
  await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.setReviewMode(true));
  for(const biome of ['verdant-airfield','azure-port','alpine-lake','sunstone-oasis','verdant-airfield']){
    await page.evaluate(b=>window.__AIRPLANE_EXPERIENCE__.reviewBiome(b,80),biome);
    await page.waitForFunction(()=>{
      const s=window.__AIRPLANE_EXPERIENCE__.getStreamingStats();return s.ready&&s.streaming.loadingChunks===0;
    },null,{timeout:180000});
    const start=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.getStreamingStats().renderedFrames);
    await page.waitForFunction(s=>window.__AIRPLANE_EXPERIENCE__.getStreamingStats().renderedFrames>s+3,start,{timeout:60000});
    const row=await page.evaluate(()=>{const a=window.__AIRPLANE_EXPERIENCE__;return {streaming:a.getStreamingStats(),passes:a.diagnostics.renderer.passes,shadowCache:a.diagnostics.renderer.shadowCache,fog:a.diagnostics.fog};});
    if(row.streaming.viewDistance!==distance||row.passes.beauty.triangles<=0)throw Error('Requested visibility or world draw failed');
    if(preload&&(!row.streaming.streaming.preload?.complete||!row.streaming.streaming.preload?.enabled))throw Error('The full-map preload failed');
    if(row.fog?.enabled!==false)throw Error('Landscape fog must remain disabled');
    if(optimized&&![2,3].every(index=>row.shadowCache?.cascades[index]?.cached))throw Error('The optimized clear-world mode failed');
    report.rows.push({biome,...row});
    console.log(JSON.stringify({biome,distance:row.streaming.viewDistance,ready:row.streaming.ready,triangles:row.passes.total.triangles}));
  }
  await page.screenshot({path:`${output}/production-smoke.png`});
  report.assetRequestsAfterStartup=assetRequests-startupRequests;
  if(preload&&report.assetRequestsAfterStartup!==0)throw Error('A map asset was fetched after full preload');
  await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.dispose());
  if(report.errors.length||report.networkFailures.length)throw Error('Production smoke captured errors');
  report.complete=true;
}catch(error){report.failure=String(error);throw error;}finally{
  await writeFile(`${output}/production-smoke.json`,JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
