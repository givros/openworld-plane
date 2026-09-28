import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const output='artifacts/four-horizons/comparisons/roof-shadows';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist']});
const errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/__depth-audit__',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
 await page.goto('http://127.0.0.1:5173/__depth-audit__');
 const report=await page.evaluate(async()=>{
  const source=await(await fetch('/src/systems/Atmosphere.ts')).text();
  const url=source.match(/from\s+["']([^"']*\/three(?:\.js)?[^"']*)["']/)[1];
  const T=await import(url),{FlightVfx}=await import('/src/systems/FlightVfx.ts');
  const results=[];
  const delta=(a,b)=>{let changed=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>6)changed++;return changed;};
  for(const logarithmicDepthBuffer of [false,true]){
   const renderer=new T.WebGLRenderer({antialias:true,logarithmicDepthBuffer,powerPreference:'high-performance'});renderer.setSize(512,320);
   const scene=new T.Scene(),camera=new T.PerspectiveCamera(42,1.6,.15,16000);
   const target=new T.WebGLRenderTarget(512,320);
   const read=()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);const p=new Uint8Array(512*320*4);renderer.readRenderTargetPixels(target,0,0,512,320,p);return p;};
   const roof=new T.Mesh(new T.PlaneGeometry(180,120),new T.MeshBasicMaterial({color:'#d98146',side:T.DoubleSide}));
   const deck=new T.Mesh(roof.geometry,new T.MeshBasicMaterial({color:'#1e1a17',side:T.DoubleSide}));scene.add(roof,deck);
   const depths=[];
   for(const distance of [50,500,1500,5000]){
    roof.position.set(0,0,-distance);roof.rotation.set(.42,.18,0);roof.scale.setScalar(distance/500);
    deck.position.copy(roof.position).add(new T.Vector3(0,0,-.0015).applyEuler(roof.rotation));deck.rotation.copy(roof.rotation);deck.scale.copy(roof.scale);
    deck.visible=false;const expected=read();deck.visible=true;const actual=read();depths.push({distance,incorrectPixels:delta(actual,expected)});
   }
   roof.removeFromParent();deck.removeFromParent();
   const wall=new T.Mesh(new T.PlaneGeometry(10,10),new T.MeshBasicMaterial({color:'#ffffff'}));wall.position.z=-8;scene.add(wall);
   const vfx=new FlightVfx(()=>0);scene.add(vfx.root);vfx.shadow.visible=false;
   const empty=read();vfx.smoke.emit(0,0,-10,0,0,0,1,1);read();vfx.smoke.reset();vfx.smoke.emit(0,0,-6,0,0,0,1,1);read();
   // Explicitly update GPU attributes just as the normal frame update does.
   vfx.smoke.update(0);const visibleFront=read();
   vfx.smoke.reset();vfx.smoke.emit(0,0,-10,0,0,0,1,1);vfx.smoke.update(0);const hiddenBehind=read();
   const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
   results.push({logarithmicDepthBuffer,depths,particleBehindPixels:delta(hiddenBehind,empty),particleFrontPixels:delta(visibleFront,empty),backend:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),clipControl:!!gl.getExtension('EXT_clip_control'),glError:gl.getError()});
   vfx.dispose();target.dispose();renderer.dispose();
  }
  return {results};
 });
 report.limitations='At 5000 meters, 1.5mm-separated synthetic planes still exceed 24-bit logarithmic precision. This stress case is reported, not hidden or claimed solved. One near silhouette pixel can expose the physically offset rear plane.';
 report.errors=errors;report.scope='Isolated millimeter-separated surfaces across the unchanged .15–16000 meter camera range, plus the actual smoke/dust shader occluded by a wall.';
 const [before,after]=report.results;
 report.checks={legacyReproduced:before.depths.some(r=>r.incorrectPixels>100),separatedSurfacesAtReviewedBuildingDistances:after.depths.filter(r=>r.distance>=500&&r.distance<=1500).every(r=>r.incorrectPixels===0),particlesOccluded:after.particleBehindPixels===0,particlesVisible:after.particleFrontPixels>100,noErrors:errors.length===0&&report.results.every(r=>r.glError===0)};
 await writeFile(`${output}/depth-precision-fixture.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 if(Object.values(report.checks).some(v=>!v))process.exitCode=1;
}finally{await browser.close();}
