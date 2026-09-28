import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const output=new URL('../artifacts/biomes/',import.meta.url);
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??chromium.executablePath()});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const started=performance.now();
await page.goto(process.env.GAME_URL??'http://127.0.0.1:5173/?review=1',{timeout:120000});
await page.waitForFunction(()=>!!window.__AIRPLANE_EXPERIENCE__?.reviewBiome,null,{timeout:120000});
const startupMs=performance.now()-started;
const manifest=JSON.parse(await fs.readFile(new URL('../public/environments/world-manifest.json',import.meta.url),'utf8'));
const biomeIds=manifest.biomes.map(biome=>biome.id);
const results=[];
for(const id of biomeIds){
  for(const altitude of [80,240]){
    let diagnostics;
    for(let attempt=0;attempt<4;attempt++){
      await page.waitForFunction(()=>!!window.__AIRPLANE_EXPERIENCE__?.reviewBiome);
      await page.evaluate(({id,altitude})=>window.__AIRPLANE_EXPERIENCE__.reviewBiome(id,altitude),{id,altitude});
      const before=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.diagnostics.frame);
      await page.waitForFunction(frame=>window.__AIRPLANE_EXPERIENCE__.diagnostics.frame>=frame+3,before,{timeout:60000});
      await page.screenshot({path:new URL(`${id}-${altitude}.png`,output).pathname.replace(/^\/(\w:)/,'$1')});
      diagnostics=await page.evaluate(()=>window.__AIRPLANE_EXPERIENCE__.diagnostics);
      if(diagnostics.mode==='manual'&&diagnostics.state.altitude===altitude)break;
    }
    if(diagnostics.mode!=='manual'||diagnostics.state.altitude!==altitude)throw new Error(`Review reset while capturing ${id}`);
    if(!diagnostics.world.trianglePreservation||diagnostics.world.loadedBiomes!==4)throw new Error(`Incomplete source transfer in ${id}`);
    results.push({id,altitude,diagnostics});console.log(id,altitude);
  }
}
const backend=await page.evaluate(()=>{
  const gl=document.querySelector('canvas').getContext('webgl2');
  const extension=gl?.getExtension('WEBGL_debug_renderer_info');
  return{type:'WebGL2',renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):'unavailable',vendor:extension?gl.getParameter(extension.UNMASKED_VENDOR_WEBGL):'unavailable',nativeDpr:window.devicePixelRatio};
});
await fs.writeFile(new URL('review-results.json',output),JSON.stringify({errors,startupMs,browser:browser.version(),viewport:{width:1440,height:900},backend,quality:{geometryCompression:false,lod:false,nativeDetail:true},results},null,2));
console.log('Errors:',JSON.stringify(errors));await browser.close();
