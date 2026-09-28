import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const out='artifacts/four-horizons/comparisons/csm-audit';
await mkdir(out,{recursive:true});
const root=join(process.env.LOCALAPPDATA,'ms-playwright');
const version=readdirSync(root).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))[0];
const browser=await chromium.launch({headless:true,executablePath:join(root,version,'chrome-win64/chrome.exe'),
  args:['--enable-webgl','--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1400,height:800},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try{
  await page.route('**/__csm-audit__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"></body></html>'}));
  await page.goto('http://127.0.0.1:5173/__csm-audit__');
  const report=await page.evaluate(async()=>{
    const source=await (await fetch('/src/systems/Atmosphere.ts')).text();
    const threeURL=source.match(/from\s+["']([^"']*\/three(?:\.js)?[^"']*)["']/)?.[1];
    if(!threeURL)throw new Error('Cannot resolve Atmosphere Three module identity');
    const THREE=await import(threeURL),{Atmosphere}=await import('/src/systems/Atmosphere.ts');
    const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    renderer.setSize(1400,800);renderer.setPixelRatio(1);
    renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
    document.body.append(renderer.domElement);
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1400/800,.15,16000);
    scene.fog=new THREE.Fog('#c4d9df',1500,5400);
    const casters=[],receivers=[],depths=[60,250,900,3300],columns=[-.50,-.17,.17,.50];
    for(let i=0;i<4;i++){
      const d=depths[i],x=columns[i]*d,y=-.22*d;
      const receiver=new THREE.Mesh(new THREE.BoxGeometry(d*.25,d*.035,d*.32),new THREE.MeshStandardMaterial({color:'#d5c8a8',roughness:.85}));
      receiver.position.set(x,y-d*.0175,-d);receiver.receiveShadow=true;scene.add(receiver);receivers.push(receiver);
      const caster=new THREE.Mesh(new THREE.BoxGeometry(d*.055,d*.105,d*.055),new THREE.MeshStandardMaterial({color:'#59824f',roughness:.85}));
      caster.position.set(x-d*.022,y+d*.0525,-d);caster.castShadow=true;caster.receiveShadow=true;scene.add(caster);casters.push(caster);
    }
    const offscreenCaster=new THREE.Mesh(new THREE.BoxGeometry(3,3,3),new THREE.MeshStandardMaterial({color:'#847e59'}));
    offscreenCaster.position.set(columns[0]*depths[0]+3,-.22*depths[0],-depths[0]-3)
      .addScaledVector(new THREE.Vector3(.48,-.58,.65).normalize(),-200);
    offscreenCaster.castShadow=true;scene.add(offscreenCaster);casters.push(offscreenCaster);
    const atmosphere=new Atmosphere(scene,renderer,camera);
    atmosphere.update(0,new THREE.Vector3(),0);
    // Fog is disabled only in this isolated fixture to measure shadow contrast.
    scene.fog=null;
    const target=new THREE.WebGLRenderTarget(1400,800);
    const read=()=>{const data=new Uint8Array(1400*800*4);renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,1400,800,data);renderer.setRenderTarget(null);return data;};
    atmosphere.casterVolumes.forEach(volume=>volume.enabled=false);
    const lit=read();
    atmosphere.casterVolumes.forEach(volume=>volume.enabled=true);
    const filtered=read();let filterChangedPixels=0,filterMaxDelta=0;
    for(let p=0;p<lit.length;p+=4){const delta=Math.abs(lit[p]-filtered[p])+Math.abs(lit[p+1]-filtered[p+1])+Math.abs(lit[p+2]-filtered[p+2]);if(delta)filterChangedPixels++;filterMaxDelta=Math.max(filterMaxDelta,delta);}
    const viewFrustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    const offscreenCasterRetained=!viewFrustum.intersectsObject(offscreenCaster)&&atmosphere.casterVolumes[0].intersectsObject(offscreenCaster);
    renderer.render(scene,camera);
    const shadowMaps=atmosphere.sunlight.lights.map((light,index)=>({index,
      size:[light.shadow.map.width,light.shadow.map.height],
      metersPerTexel:(light.shadow.camera.right-light.shadow.camera.left)/light.shadow.mapSize.x,
      depthBiasMeters:Math.abs(light.shadow.bias)*(light.shadow.camera.far-light.shadow.camera.near)}));
    for(const caster of casters)caster.castShadow=false;
    const unshadowed=read();
    const regions=[];
    for(let i=0;i<4;i++){
      let changed=0,maxDelta=0,sum=0;
      const center=new THREE.Vector3(columns[i],-.22,-1).project(camera);
      const centerX=(center.x*.5+.5)*1400;
      // Non-overlapping screen columns contain receivers at four cascade depths.
      const x0=Math.max(0,Math.floor(centerX-95)),x1=Math.min(1400,Math.ceil(centerX+95));
      for(let y=0;y<800;y++)for(let x=x0;x<x1;x++){
        const p=(y*1400+x)*4;
        const delta=Math.abs(unshadowed[p]-lit[p])+Math.abs(unshadowed[p+1]-lit[p+1])+Math.abs(unshadowed[p+2]-lit[p+2]);
        if(delta>12)changed++;
        maxDelta=Math.max(maxDelta,delta);sum+=delta;
      }
      regions.push({cascade:i,receiverDepth:depths[i],shadowChangedPixels:changed,maxRGBDelta:maxDelta,totalRGBDelta:sum});
    }
    for(const caster of casters)caster.castShadow=true;
    renderer.info.autoReset=false;renderer.info.reset();renderer.render(scene,camera);
    const fullPass={...renderer.info.render};
    renderer.info.autoReset=true;renderer.render(scene,camera);
    const beautyOnly={...renderer.info.render};
    const materialUniforms=[...atmosphere.sunlight.shaders.entries()].filter(([,shader])=>shader).map(([material,shader])=>({name:material.name,type:material.type,cascades:shader.uniforms.CSM_cascades.value.map(v=>v.toArray()),shadowFar:shader.uniforms.shadowFar.value}));
    window.__csmAudit={renderer,scene,camera,atmosphere,casters,receivers,target};
    return{fixture:'Four visible receiver platforms at CSM depths60/250/900/3300; original full geometry; no fog for contrast measurement',shadowMaps,regions,materialUniforms,
      fullPass,beautyOnly,casterVolume:{filterChangedPixels,filterMaxDelta,offscreenCasterRetained},glError:renderer.getContext().getError(),
      renderer:renderer.getContext().getParameter(renderer.getContext().getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
  });
  await page.screenshot({path:join(out,'four-cascade-receivers.png')});
  report.errors=errors;
  await writeFile(join(out,'browser-audit.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(errors.length||report.glError||report.regions.some(region=>region.shadowChangedPixels<10)||report.casterVolume.filterChangedPixels||!report.casterVolume.offscreenCasterRetained)process.exitCode=1;
}finally{await browser.close();}
