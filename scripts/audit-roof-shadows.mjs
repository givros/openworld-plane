import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const out=path.resolve('artifacts/four-horizons/comparisons/roof-shadows');
await mkdir(out,{recursive:true});
const biome=process.env.BIOME??'azure-port';
const selected=(process.env.VIEWS??'aerial,village').split(',');
const biomes=(process.env.BIOMES??biome).split(',');
const views=[];
for(const id of biomes){
 const cameras=JSON.parse(await readFile(`artifacts/four-horizons/${id}/inspection_cameras.json`,'utf8'));
 views.push(...cameras.filter(c=>selected.includes(c.id)).map(c=>({...c,biome:id,name:c.id})));
 if(process.env.AIRCRAFT==='1')views.push({biome:id,name:'aircraft-close',fov:48,aircraft:true});
}
const modes=(process.env.MODES??'baseline,no-shadows,no-normal-bias').split(',');
const tag=process.env.AUDIT_TAG??'diagnosis';
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try{
 if(process.env.STANDARD_DEPTH==='1')await page.route('**/src/core/Renderer.ts*',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace('logarithmicDepthBuffer: true','logarithmicDepthBuffer: false')});
 });
 if(process.env.LOG_DEPTH==='1')await page.route('**/src/core/Renderer.ts*',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace('stencil: false','stencil: false, logarithmicDepthBuffer: true')});
 });
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
 await page.evaluate(biome=>{
  window.__AIRPLANE_EXPERIENCE__.reviewBiome(biome,100);
  const game=window.__auditGame;
  window.__auditOriginalShadow=game.atmosphere.sunlight.lights.map(light=>({bias:light.shadow.bias,normalBias:light.shadow.normalBias,intensity:light.shadow.intensity}));
  window.__auditMaterials=new Set();
  game.rendering.scene.traverse(object=>{if(object.isMesh)for(const material of Array.isArray(object.material)?object.material:[object.material])window.__auditMaterials.add(material);});
  window.__auditTextures=new Map();window.__auditNormalScales=new Map();
  for(const material of window.__auditMaterials){
   if(material.normalScale)window.__auditNormalScales.set(material,material.normalScale.clone());
   for(const value of Object.values(material))if(value?.isTexture)window.__auditTextures.set(value,value.anisotropy);
  }
 },biome);
 const frames=[];
 for(const view of views){
  await page.evaluate(id=>window.__AIRPLANE_EXPERIENCE__.reviewBiome(id,100),view.biome);
  if(view.aircraft){
   const pose=await page.evaluate(()=>{
    const game=window.__auditGame,p=game.manual.state.position;
    game.vfx.update(.6,game.manual.state,game.aircraft.root);
    return {camera:[p.x+10,p.y+4,p.z-12],target:[p.x,p.y+1,p.z]};
   });Object.assign(view,pose);
  }
  await page.evaluate(view=>window.__AIRPLANE_EXPERIENCE__.reviewCamera(view.camera,view.target,view.fov),view);
  if(process.env.STATIC_WORLD_COMPARISON==='1')await page.evaluate(()=>{const g=window.__auditGame;g.aircraft.root.visible=false;g.vfx.root.visible=false;g.atmosphere.clouds.visible=false;});
  for(const mode of modes){
   const result=await page.evaluate(mode=>{
    const game=window.__auditGame,renderer=game.rendering.renderer;
    game.rendering.camera.near=mode==='depth-precision'?5:.15;game.rendering.camera.updateProjectionMatrix();game.atmosphere.prepareRender();
    game.atmosphere.sunlight.lights.forEach((light,index)=>{
     Object.assign(light.shadow,window.__auditOriginalShadow[index]);
     if(mode==='no-shadows')light.shadow.intensity=0;
     if(mode==='no-normal-bias')light.shadow.normalBias=0;
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
     depth:{logarithmic:renderer.capabilities.logarithmicDepthBuffer,reversed:renderer.capabilities.reversedDepthBuffer,clipControl:renderer.extensions.has('EXT_clip_control'),bits:renderer.getContext().getParameter(renderer.getContext().DEPTH_BITS),near:game.rendering.camera.near,far:game.rendering.camera.far},
     renderBatches:game.world.diagnostics.renderBatches,sourceMeshPrimitives:game.world.diagnostics.sourceObjects,
     glError:renderer.getContext().getError(),sourceTriangles:game.world.diagnostics.sourceTriangles};
   },mode);
   const file=`${tag}-${view.biome}-${view.name}-${mode}.png`;
   await writeFile(path.join(out,file),Buffer.from(result.dataUrl.split(',')[1],'base64'));
   delete result.dataUrl;frames.push({biome:view.biome,view:view.name,mode,file,camera:view.camera,target:view.target,fov:view.fov,...result});
   console.log('BANDING_VIEW',view.name,mode);
  }
 }
 const report={biome,staticWorldComparison:process.env.STATIC_WORLD_COMPARISON==='1',dynamicExclusions:process.env.STATIC_WORLD_COMPARISON==='1'?['aircraft','flight particles and trails','drifting clouds']:[],standardDepthDiagnostic:process.env.STANDARD_DEPTH==='1',timestamp:new Date().toISOString(),backend,receiverPlaneCorrection:process.env.LEGACY_PCF!=='1',scope:'Frozen actual-game visual A/B; no performance benchmark. Full source geometry and native-resolution rendering retained.',frames,errors};
 await writeFile(path.join(out,`${tag}.json`),JSON.stringify(report,null,2));
 console.log(JSON.stringify({backend,errors,frames:frames.map(({file,passes,...row})=>row)},null,2));
 if(errors.length||frames.some(frame=>frame.glError))process.exitCode=1;
}finally{await browser.close();}
