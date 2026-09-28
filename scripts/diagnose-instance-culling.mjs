import {chromium} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const out='artifacts/four-horizons/comparisons/instance-culling-diagnostic';await mkdir(out,{recursive:true});
const cameras=JSON.parse(await readFile('artifacts/four-horizons/alpine-lake/inspection_cameras.json','utf8'));
const camera=cameras.find(camera=>camera.id==='human-network');
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1}),errors=[],navigation=[];
 page.on('pageerror',e=>errors.push({type:'pageerror',message:e.message}));page.on('console',m=>{if(m.type()==='error')errors.push({type:'console',message:m.text()});});page.on('requestfailed',r=>errors.push({type:'requestfailed',url:r.url(),failure:r.failure(),timestamp:new Date().toISOString()}));page.on('framenavigated',f=>{if(f===page.mainFrame())navigation.push({url:f.url(),timestamp:new Date().toISOString()});});
 await page.route('**/src/game/Game.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('this.expose();','window.__auditGame=this;this.expose();')});});
 await page.goto('http://127.0.0.1:5173/?review=1');await page.waitForFunction(()=>window.__auditGame?.rendering?.instanceCulling?.culler.enabled,null,{timeout:300000});
 const setup=await page.evaluate(camera=>{const game=window.__auditGame;game.loop.stop();window.__AIRPLANE_EXPERIENCE__.reviewBiome('alpine-lake',120);window.__AIRPLANE_EXPERIENCE__.reviewCamera(camera.camera,camera.target,camera.fov);window.__instanceDiagnosticPixels=[];const gl=game.rendering.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),camera,world:game.world.diagnostics};},camera);
 if(!/NVIDIA.*RTX 3080/i.test(setup.renderer))throw new Error('Hardware changed');
 const modes=[{name:'canonical',beauty:false,shadow:false},{name:'beauty-only',beauty:true,shadow:false},{name:'shadow-only',beauty:false,shadow:true},{name:'candidate',beauty:true,shadow:true}];
 const sequence=[...modes,...modes,...[2,16].flatMap(padding=>[{name:`canonical-padding-${padding}`,beauty:false,shadow:false,padding},{name:`shadow-padding-${padding}`,beauty:false,shadow:true,padding}])];
 const frames=[];
 for(const [index,mode]of sequence.entries()){
  const result=await page.evaluate(mode=>{
   const game=window.__auditGame,renderer=game.rendering.renderer,culler=game.rendering.instanceCulling.culler,gl=renderer.getContext();
   culler.disable();game.atmosphere.casterVolumes.forEach(volume=>volume.enabled=true);game.atmosphere.prepareRender();
   for(const volume of game.atmosphere.casterVolumes)for(const plane of volume.planes)plane.constant+=mode.padding??0;
   game.rendering.prepareWorldCulling();if(mode.beauty)culler.enable();
   const originalShadowRender=renderer.shadowMap.render;
   renderer.shadowMap.render=function(...args){
    if(mode.shadow)culler.enable();else culler.disable();
    try{return originalShadowRender.apply(this,args);}
    finally{if(mode.beauty)culler.enable();else culler.disable();}
   };
   try{renderer.info.reset();renderer.render(game.rendering.scene,game.rendering.camera);}
   finally{renderer.shadowMap.render=originalShadowRender;}
   const pixels=new Uint8Array(1440*900*4);gl.readPixels(0,0,1440,900,gl.RGBA,gl.UNSIGNED_BYTE,pixels);window.__instanceDiagnosticPixels.push(pixels);
   return{png:renderer.domElement.toDataURL('image/png'),glError:gl.getError(),passes:{shadow:{...game.rendering.passes.shadow},total:{...renderer.info.render}}};
  },mode);
  const file=`${index}-${mode.name}.png`;await writeFile(`${out}/${file}`,Buffer.from(result.png.split(',')[1],'base64'));delete result.png;frames.push({index,...mode,file,...result});console.log('FRAME',index,mode.name);
 }
 const comparisons=await page.evaluate(()=>[[0,1],[0,2],[0,3],[4,5],[4,6],[4,7],[0,4],[1,5],[2,6],[3,7],[8,9],[10,11],[0,8],[0,10]].map(([a,b])=>{
  const first=window.__instanceDiagnosticPixels[a],second=window.__instanceDiagnosticPixels[b];let changedPixels=0,maxChannelDelta=0,totalRGBDelta=0;const differences=[];
  for(let p=0;p<first.length;p+=4){const delta=[0,1,2].map(c=>Math.abs(first[p+c]-second[p+c]));if(delta.some(Boolean)){changedPixels++;maxChannelDelta=Math.max(maxChannelDelta,...delta);totalRGBDelta+=delta.reduce((s,n)=>s+n,0);if(differences.length<128)differences.push({x:p/4%1440,y:899-Math.floor(p/4/1440),firstRGB:Array.from(first.slice(p,p+3)),secondRGB:Array.from(second.slice(p,p+3))});}}
  return{a,b,changedPixels,maxChannelDelta,totalRGBDelta,differences};
 }));
 await writeFile(`${out}/comparison.json`,JSON.stringify({timestamp:new Date().toISOString(),scope:'Untimed fixed-state alpine diagnostic. Every direct draw prepares camera-dependent shadow/culling volumes. Shadow-only/beauty-only modes use canonical and proxy passes separately; extra-volume expansions are paired with matching canonical controls.',setup,frames,comparisons,errors,navigation,performanceClaim:false},null,2));
 console.log(JSON.stringify({comparisons,errors,navigation},null,2));if(errors.length||frames.some(f=>f.glError))process.exitCode=1;
}finally{await browser.close();}
