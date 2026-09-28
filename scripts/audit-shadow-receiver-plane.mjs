import { chromium } from '@playwright/test';
import { writeFile,mkdir } from 'node:fs/promises';

const output='artifacts/four-horizons/comparisons/terrain-banding';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try{
 await page.route('**/__shadow-plane-audit__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:0"></body>'}));
 await page.goto('http://127.0.0.1:5173/__shadow-plane-audit__');
 const report=await page.evaluate(async()=>{
  const source=await(await fetch('/src/systems/Atmosphere.ts')).text();
  const threeURL=source.match(/from\s+["']([^"']*\/three(?:\.js)?[^"']*)["']/)?.[1];
  const THREE=await import(threeURL),{Atmosphere}=await import('/src/systems/Atmosphere.ts');
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setSize(1280,800);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  document.body.append(renderer.domElement);
  const scene=new THREE.Scene();scene.fog=new THREE.Fog('#c4d9df',1500,5400);
  const camera=new THREE.PerspectiveCamera(38.73952406980271,1.6,.15,16000);
  camera.position.set(850,580,-930);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const material=new THREE.MeshStandardMaterial({color:'#bbc78f',roughness:1,side:THREE.DoubleSide});
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(4000,4000,40,40),material);
  plane.rotation.x=-Math.PI/2;plane.castShadow=true;plane.receiveShadow=true;scene.add(plane);
  const boxes=[];
  for(const [x,z,size] of [[-120,0,20],[50,0,10],[150,200,30]]){
   const box=new THREE.Mesh(new THREE.BoxGeometry(size,size,size),material);
   box.position.set(x,size/2,z);box.castShadow=true;box.receiveShadow=true;box.visible=false;scene.add(box);boxes.push(box);
  }
  const atmosphere=new Atmosphere(scene,renderer,camera);
  const corrected=THREE.ShaderChunk.lights_fragment_begin;
  // The exact old CSM calls remain available for an isolated same-context A/B.
  const legacy=corrected.replace(/CROPPER_DIRECTIONAL_SHADOW\( directionalShadowMap\[ i \], ([^\n]*?), vDirectionalShadowCoord\[ i \], cropperShadowVisibility\[ i \] \)/g,
   'getShadow( directionalShadowMap[ i ], $1, vDirectionalShadowCoord[ i ] )');
  let variant='corrected';material.customProgramCacheKey=()=>variant;
  atmosphere.update(0,new THREE.Vector3(),0);scene.fog=null;
  const target=new THREE.WebGLRenderTarget(1280,800);
  const read=(mode,withCasters)=>{
   variant=mode;THREE.ShaderChunk.lights_fragment_begin=mode==='legacy'?legacy:corrected;material.needsUpdate=true;
   boxes.forEach(box=>box.visible=withCasters);
   atmosphere.sunlight.lights.forEach(light=>light.shadow.intensity=mode==='unshadowed'?0:1);
   scene.fog=new THREE.Fog('#c4d9df',1500,5400);atmosphere.update(0,new THREE.Vector3(),0);scene.fog=null;
   renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.render(scene,camera);
   const pixels=new Uint8Array(1280*800*4);renderer.readRenderTargetPixels(target,0,0,1280,800,pixels);renderer.setRenderTarget(null);
   return pixels;
  };
  const difference=(a,b)=>{
   let changedPixels=0,totalRGBDelta=0,maxRGBDelta=0,significantPixels=0;
   for(let p=0;p<a.length;p+=4){const delta=Math.abs(a[p]-b[p])+Math.abs(a[p+1]-b[p+1])+Math.abs(a[p+2]-b[p+2]);
    if(delta)changedPixels++;if(delta>6)significantPixels++;totalRGBDelta+=delta;maxRGBDelta=Math.max(maxRGBDelta,delta);}
   return{changedPixels,significantPixels,totalRGBDelta,maxRGBDelta};
  };
  const rows=[],images=[];
  const image=(name,pixels)=>{const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=800;const context=canvas.getContext('2d'),data=context.createImageData(1280,800);for(let y=0;y<800;y++)data.data.set(pixels.subarray(y*1280*4,(y+1)*1280*4),(799-y)*1280*4);context.putImageData(data,0,0);images.push({name,data:canvas.toDataURL('image/png')});};
  for(const [name,position,targetPosition] of [['wide',[850,580,-930],[0,0,0]],['grazing',[100,12,-300],[0,0,0]],['reverse',[-850,260,730],[0,0,0]]]){
   camera.position.fromArray(position);camera.lookAt(...targetPosition);camera.updateMatrixWorld();
   const unshadowed=read('unshadowed',false),before=read('legacy',false),after=read('corrected',false);
   image(`${name}-unshadowed`,unshadowed);image(`${name}-before`,before);image(`${name}-after`,after);
   const withCasters=read('corrected',true),castersUnshadowed=read('unshadowed',true);
   rows.push({name,legacyAcne:difference(before,unshadowed),correctedAcne:difference(after,unshadowed),preservedCasterShadows:difference(withCasters,castersUnshadowed)});
  }
  read('corrected',true);renderer.render(scene,camera);
  const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  return{timestamp:new Date().toISOString(),scope:'Self-casting four-kilometer horizontal surface and three full-geometry contact casters, three view directions; fixed native 1280x800 and four 4096 PCF cascades.',backend:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),rows,images,glError:gl.getError()};
 });
 for(const item of report.images)await writeFile(`${output}/fixture-${item.name}.png`,Buffer.from(item.data.split(',')[1],'base64'));delete report.images;
 report.errors=errors;report.checks={legacyArtifactReproduced:report.rows.every(row=>row.legacyAcne.significantPixels>1000),
  acneRemoved:report.rows.every(row=>row.correctedAcne.significantPixels===0),castersStillShadow:report.rows.every(row=>row.preservedCasterShadows.significantPixels>100),
  noErrors:errors.length===0&&report.glError===0};
 await writeFile(`${output}/receiver-plane-fixture.json`,JSON.stringify(report,null,2));
 await page.screenshot({path:`${output}/receiver-plane-fixture.png`});
 console.log(JSON.stringify(report,null,2));
 if(Object.values(report.checks).some(value=>!value))process.exitCode=1;
}finally{await browser.close();}





