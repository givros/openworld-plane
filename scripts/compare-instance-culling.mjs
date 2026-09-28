import {chromium} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalWorldInputs} from './environments/runtime-validation-inputs.mjs';
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const inputEvidence=await finalWorldInputs(manifest);
const out=`artifacts/four-horizons/comparisons/${process.env.CULLING_TAG??'instance-culling-quality'}`;
await mkdir(out,{recursive:true});
const views=[];
for(const biome of manifest.biomes){
 views.push({biome:biome.id,id:'manifest-review',altitude:120});
 const cameras=JSON.parse(await readFile(`artifacts/four-horizons/${biome.id}/inspection_cameras.json`,'utf8'));
 const camera=cameras.find(camera=>camera.id==='human-network');
 if(!camera)throw new Error(`${biome.id} lacks human-network inspection camera`);
 views.push({biome:biome.id,...camera});
}
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1}),errors=[],navigationEvents=[];
 page.on('pageerror',error=>errors.push({type:'pageerror',message:error.message}));page.on('console',message=>{if(message.type()==='error')errors.push({type:'console',message:message.text()});});page.on('requestfailed',request=>errors.push({type:'requestfailed',url:request.url(),failure:request.failure(),timestamp:new Date().toISOString()}));page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigationEvents.push({url:frame.url(),timestamp:new Date().toISOString()});});
 await page.route('**/src/game/Game.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('this.expose();','window.__auditGame=this;this.expose();')});});
 await page.goto('http://127.0.0.1:5173/?review=1');
 await page.waitForFunction(()=>window.__auditGame?.world?.diagnostics.ready&&window.__auditGame?.rendering?.instanceCulling,null,{timeout:300000});
 const setup=await page.evaluate(async()=>{
  const game=window.__auditGame;game.loop.stop();
  game.rendering.instanceCulling.automaticSelection=false;
  game.rendering.prepareWorldCulling();
  const renderer=game.rendering.renderer,gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  window.__cullingQualityCanonicalSources=[...game.rendering.instanceCulling.culler.canonicalSources];
  window.__cullingQualityInventory=async()=>{
   let triangles=0,meshBatches=0,instances=0;
   game.world.root.traverse(object=>{if(object.isMesh){const count=object.isInstancedMesh?object.count:1;triangles+=(object.geometry.index?.count??object.geometry.getAttribute('position').count)/3*count;meshBatches++;instances+=count;}});
   const sources=window.__cullingQualityCanonicalSources;
   const byteLength=sources.reduce((sum,item)=>sum+item.source.instanceMatrix.array.byteLength,0),bytes=new Uint8Array(byteLength);let offset=0;
   for(const item of sources){const array=item.source.instanceMatrix.array;bytes.set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength),offset);offset+=array.byteLength;}
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
   return{triangles,meshBatches,instances,candidateBatches:sources.length,candidateMatrixBytes:byteLength,candidateMatricesSha256:digest,sourceCounts:sources.map(item=>item.source.count)};
  };
  const inventory=await window.__cullingQualityInventory();
  return{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),world:game.world.diagnostics,inventory,depthMode:renderer.capabilities.logarithmicDepthBuffer?'logarithmic':'other',cameraNear:game.rendering.camera.near,cameraFar:game.rendering.camera.far,viewport:[gl.drawingBufferWidth,gl.drawingBufferHeight],dpr:renderer.getPixelRatio()};
 });
 if(!/NVIDIA.*RTX 3080/i.test(setup.renderer))throw new Error(`Unexpected renderer: ${setup.renderer}`);
 if(setup.inventory.triangles!==3932442987||setup.world.sourceObjects!==971058)throw new Error('Complete canonical source inventory differs from baseline.');
 const results=[];
 for(const view of views){
  const state=await page.evaluate(view=>{
   const game=window.__auditGame;
   window.__AIRPLANE_EXPERIENCE__.reviewBiome(view.biome,120);
   if(view.camera)window.__AIRPLANE_EXPERIENCE__.reviewCamera(view.camera,view.target,view.fov);
   game.atmosphere.casterVolumes.forEach(volume=>volume.enabled=true);
   game.atmosphere.prepareRender();window.__cullingQualityPixels=[];
   return{camera:{position:game.rendering.camera.position.toArray(),quaternion:game.rendering.camera.quaternion.toArray(),fov:game.rendering.camera.fov},cloudMatrices:Array.from(game.atmosphere.clouds.instanceMatrix.array),aircraftMatrix:game.aircraft.root.matrixWorld.toArray()};
  },view);
  const frames=[];
  for(const [index,mode]of ['canonical','automatic','candidate','canonical','automatic','candidate'].entries()){
   const result=await page.evaluate(mode=>{
    const game=window.__auditGame,renderer=game.rendering.renderer,culler=game.rendering.instanceCulling.culler,gl=renderer.getContext();
    game.rendering.instanceCulling.automaticSelection=mode==='automatic';
    if(mode==='canonical')culler.disable();else if(mode==='candidate')culler.enable();
    game.rendering.prepareWorldCulling();
    if(mode!=='automatic'&&culler.enabled!==(mode==='candidate'))throw new Error('Culler state changed unexpectedly during preparation.');
    if(mode==='canonical'&&!culler.canonicalSources.every(item=>item.source.layers.mask===item.originalLayerMask))throw new Error('Canonical source layers were not restored.');
    renderer.info.reset();renderer.render(game.rendering.scene,game.rendering.camera);
    const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    window.__cullingQualityPixels.push(pixels);
    const total={...renderer.info.render},shadow={...game.rendering.passes.shadow};
    return{png:renderer.domElement.toDataURL('image/png'),glError:gl.getError(),enabled:culler.enabled,selection:game.rendering.instanceCulling.diagnostics,passes:{shadow,total,beauty:{calls:total.calls-shadow.calls,triangles:total.triangles-shadow.triangles}},source:game.world.diagnostics};
   },mode);
   const file=`${view.biome}-${view.id}-${index}-${mode}.png`,bytes=Buffer.from(result.png.split(',')[1],'base64');
   await writeFile(`${out}/${file}`,bytes);delete result.png;frames.push({index,mode,file,sha256:createHash('sha256').update(bytes).digest('hex'),...result});
  }
  const comparisons=await page.evaluate(()=>[[0,1],[0,2],[3,4],[3,5],[0,3],[1,4],[2,5]].map(([a,b])=>{
   const first=window.__cullingQualityPixels[a],second=window.__cullingQualityPixels[b];let changedPixels=0,maxChannelDelta=0,totalRGBDelta=0,minLuminance=765,maxLuminance=0;const differences=[];
   for(let p=0;p<first.length;p+=4){const luminance=first[p]+first[p+1]+first[p+2];minLuminance=Math.min(minLuminance,luminance);maxLuminance=Math.max(maxLuminance,luminance);const delta=[0,1,2].map(channel=>Math.abs(first[p+channel]-second[p+channel]));if(delta.some(Boolean)){changedPixels++;totalRGBDelta+=delta.reduce((sum,value)=>sum+value,0);maxChannelDelta=Math.max(maxChannelDelta,...delta);if(differences.length<128)differences.push({x:p/4%1440,y:899-Math.floor(p/4/1440),firstRGB:Array.from(first.slice(p,p+3)),secondRGB:Array.from(second.slice(p,p+3))});}}
   return{a,b,changedPixels,maxChannelDelta,totalRGBDelta,nonemptyBaseline:maxLuminance-minLuminance>3,differences};
  }));
  results.push({biome:view.biome,view:view.id,state,frames,comparisons});console.log('VIEW',view.biome,view.id,JSON.stringify(comparisons.map(({differences,...row})=>row)));
 }
 const lifecycle=await page.evaluate(async()=>{
  const game=window.__auditGame,culler=game.rendering.instanceCulling.culler;game.rendering.instanceCulling.automaticSelection=false;culler.disable();
  const layersRestored=culler.canonicalSources.every(item=>item.source.layers.mask===item.originalLayerMask);
  const inventory=await window.__cullingQualityInventory();game.rendering.prepareWorldCulling();culler.enable();
  const reenabled=culler.enabled,memoryBeforeDispose={...game.rendering.renderer.info.memory};
  game.rendering.disposeWorldCulling();let proxyObjectsAfterDispose=0;
  game.rendering.scene.traverse(object=>{if(object.userData.passInstanceProxy)proxyObjectsAfterDispose++;});
  const inventoryAfterDispose=await window.__cullingQualityInventory();
  return{layersRestored,reenabled,inventory,dispose:{adapterRemoved:game.rendering.instanceCulling===null,proxyObjectsAfterDispose,sourceLayersRestored:window.__cullingQualityCanonicalSources.every(item=>item.source.layers.mask===item.originalLayerMask),inventoryAfterDispose,memoryBeforeDispose,memoryAfterDispose:{...game.rendering.renderer.info.memory}}};
 });
 const canonicalPreserved=JSON.stringify(setup.inventory)===JSON.stringify(lifecycle.inventory);
 const strictBitwiseEqual=results.every(view=>view.comparisons.every(row=>row.changedPixels===0&&row.nonemptyBaseline));
 const report={timestamp:new Date().toISOString(),scope:'Untimed quality comparison: same loaded scene and frozen presentation at eight poses; automatic and forced culling paths versus identical conservative-shadow canonical reference, each repeated. Separate from the prior unfiltered-shadow one-pixel exception.',inputEvidence,setup,results,lifecycle,canonicalPreserved,strictBitwiseEqual,errors,navigationEvents,performanceClaim:false};
 await writeFile(`${out}/comparison.json`,JSON.stringify(report,null,2));
 console.log(JSON.stringify({views:results.length,strictBitwiseEqual,canonicalPreserved,layersRestored:lifecycle.layersRestored,errors}));
 if(!strictBitwiseEqual||!canonicalPreserved||!lifecycle.layersRestored||!lifecycle.dispose.adapterRemoved||lifecycle.dispose.proxyObjectsAfterDispose||!lifecycle.dispose.sourceLayersRestored||JSON.stringify(setup.inventory)!==JSON.stringify(lifecycle.dispose.inventoryAfterDispose)||errors.length||results.some(view=>view.frames.some(frame=>frame.glError)))process.exitCode=1;
}finally{await browser.close();}
