import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const out=path.resolve('artifacts/four-horizons/comparisons/terrain-banding');
await mkdir(out,{recursive:true});
const pilot=JSON.parse(await readFile('artifacts/four-horizons/viewer/landscape-pilot/meadow-pilot-runtime.json','utf8'));
const selected=process.env.VIEWS?.split(',');
const views=pilot.frames.filter(frame=>!selected||selected.includes(frame.name));
const modes=(process.env.MODES??'baseline,no-shadows,strong-bias,dithering').split(',');
const tag=process.env.AUDIT_TAG??'diagnosis';
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try{
 if(process.env.LEGACY_PCF==='1')await page.route('**/src/systems/Atmosphere.ts*',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace('installReceiverPlaneShadows();','')});
 });
 await page.route('**/src/game/Game.ts*',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace('this.expose();','window.__auditGame = this; this.expose();')});
 });
 await page.goto('http://127.0.0.1:5173/?review=1',{timeout:120000});
 await page.waitForFunction(()=>window.__auditGame?.world?.diagnostics.ready,null,{timeout:240000});
 const backend=await page.evaluate(()=>{
  const game=window.__auditGame;game.loop.stop();
  const gl=game.rendering.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
 });
 if(!/NVIDIA.*RTX 3080/i.test(backend))throw new Error(`Unexpected renderer ${backend}`);
 await page.evaluate(()=>{
  window.__AIRPLANE_EXPERIENCE__.reviewBiome('verdant-airfield',100);
  const game=window.__auditGame;
  window.__auditOriginalShadow=game.atmosphere.sunlight.lights.map(light=>({bias:light.shadow.bias,normalBias:light.shadow.normalBias,intensity:light.shadow.intensity}));
  window.__auditMaterials=new Set();
  game.rendering.scene.traverse(object=>{if(object.isMesh)for(const material of Array.isArray(object.material)?object.material:[object.material])window.__auditMaterials.add(material);});
  window.__auditTextures=new Map();window.__auditNormalScales=new Map();
  for(const material of window.__auditMaterials){
   if(material.normalScale)window.__auditNormalScales.set(material,material.normalScale.clone());
   for(const value of Object.values(material))if(value?.isTexture)window.__auditTextures.set(value,value.anisotropy);
  }
 });
 const frames=[];
 for(const view of views){
  await page.evaluate(view=>window.__AIRPLANE_EXPERIENCE__.reviewCamera(view.camera,view.target,view.fov),view);
  for(const mode of modes){
   const result=await page.evaluate(mode=>{
    const game=window.__auditGame,renderer=game.rendering.renderer;
    game.atmosphere.sunlight.lights.forEach((light,index)=>{
     Object.assign(light.shadow,window.__auditOriginalShadow[index]);
     if(mode==='no-shadows')light.shadow.intensity=0;
     if(mode==='strong-bias'){light.shadow.bias*=16;light.shadow.normalBias*=4;}
    });
    for(const material of window.__auditMaterials){
     const dithering=mode==='dithering';
     if(material.dithering!==dithering){material.dithering=dithering;material.needsUpdate=true;}
     if(material.normalScale)material.normalScale.copy(window.__auditNormalScales.get(material)).multiplyScalar(mode==='no-normal-map'?0:1);
    }
    for(const [texture,anisotropy] of window.__auditTextures){
     const next=mode==='anisotropy'?renderer.capabilities.getMaxAnisotropy():anisotropy;
     if(texture.anisotropy!==next){texture.anisotropy=next;texture.needsUpdate=true;}
    }
    game.rendering.render();
    const canvas=renderer.domElement;
    return {dataUrl:canvas.toDataURL('image/png'),passes:JSON.parse(JSON.stringify(game.rendering.passes)),
     glError:renderer.getContext().getError(),sourceTriangles:game.world.diagnostics.sourceTriangles};
   },mode);
   const file=`${tag}-${view.name}-${mode}.png`;
   await writeFile(path.join(out,file),Buffer.from(result.dataUrl.split(',')[1],'base64'));
   delete result.dataUrl;frames.push({view:view.name,mode,file,camera:view.camera,target:view.target,fov:view.fov,...result});
   console.log('BANDING_VIEW',view.name,mode);
  }
 }
 const report={timestamp:new Date().toISOString(),backend,receiverPlaneCorrection:process.env.LEGACY_PCF!=='1',scope:'Frozen actual-game visual A/B; no performance benchmark. Full source geometry and native-resolution rendering retained.',frames,errors};
 await writeFile(path.join(out,`${tag}.json`),JSON.stringify(report,null,2));
 console.log(JSON.stringify({backend,errors,frames:frames.map(({file,passes,...row})=>row)},null,2));
 if(errors.length||frames.some(frame=>frame.glError))process.exitCode=1;
}finally{await browser.close();}
