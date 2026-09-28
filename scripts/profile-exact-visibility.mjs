import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const output=process.env.VISIBILITY_OUTPUT??'artifacts/four-horizons/target-30fps/visibility-probe';await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const biome=manifest.biomes.find(item=>item.id===(process.env.PROBE_BIOME??'verdant-airfield'));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??chromium.executablePath(),args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--enable-unsafe-webgpu','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto('http://127.0.0.1:5173/visibility-probe.html');await page.waitForFunction(()=>window.probeModuleReady);
 const baseURL=process.env.VISIBILITY_DATA??'/acceleration/visibility-prototype';
 const setup=await page.evaluate(async({baseURL,samples,stackDepth,kernelVariant})=>{window.probe=await window.ExactVisibilityProbe.create(baseURL,{samples,stackDepth,kernelVariant});return{adapter:probe.adapterInfo,bytes:probe.bytes,manifest:probe.manifest,width:probe.width,height:probe.height,samples:probe.samples,stackDepth,kernelVariant};},{baseURL,samples:Number(process.env.PROBE_SAMPLES??1),stackDepth:Number(process.env.PROBE_STACK_DEPTH??64),kernelVariant:process.env.PROBE_KERNEL??'scalar'});
 console.log('INITIALIZED',JSON.stringify({adapter:setup.adapter,bytes:setup.bytes,samples:setup.samples}));
 await page.evaluate(view=>probe.setCamera(view.camera,view.target,48),biome.review);
 const timings=[];for(let frame=0;frame<8;frame++){const result=await page.evaluate(()=>probe.render());if(frame>=3)timings.push(result);console.log('FRAME',frame,JSON.stringify(result));}
 const inspection=await page.evaluate(()=>probe.inspect());await writeFile(`${output}/visibility.png`,Buffer.from(inspection.png.split(',')[1],'base64'));delete inspection.png;
 const report={timestamp:new Date().toISOString(),scope:'Isolated full-triangle primary-visibility feasibility. Excludes final material shading, shadow visibility, dynamic aircraft and UI; not game FPS.',biome:biome.id,setup,timings,inspection,errors};await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({inspection:{...inspection,validationHits:undefined},errors}));
 await page.evaluate(()=>probe.dispose());if(errors.length||inspection.stackOverflow||timings.some(row=>row.errors.length))process.exitCode=1;
}finally{await browser.close();}
