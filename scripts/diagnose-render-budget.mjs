import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const out='artifacts/four-horizons/target-30fps';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--enable-unsafe-webgpu','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/src/game/Game.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('this.expose();','window.__auditGame=this;this.expose();')});});
 await page.goto('http://127.0.0.1:5173/?review=1');
 await page.waitForFunction(()=>window.__auditGame?.world?.diagnostics.ready,null,{timeout:300000});
 const report=await page.evaluate(async()=>{
  const game=window.__auditGame;game.loop.stop();
  const geometry=new Map(),materials=new Map();let placements=0,triangles=0,attributeBytes=0;
  game.world.root.traverse(object=>{if(!object.isMesh)return;const g=object.geometry,n=object.isInstancedMesh?object.count:1,t=(g.index?.count??g.attributes.position.count)/3;placements+=n;triangles+=t*n;
   if(!geometry.has(g)){const bytes=Object.values(g.attributes).reduce((sum,a)=>sum+a.array.byteLength,0)+(g.index?.array.byteLength??0);attributeBytes+=bytes;geometry.set(g,{name:object.name,triangles:t,vertices:g.attributes.position.count,bytes,placements:0,weightedTriangles:0,attributes:Object.keys(g.attributes)});}
   const row=geometry.get(g);row.placements+=n;row.weightedTriangles+=t*n;
   for(const material of Array.isArray(object.material)?object.material:[object.material]){let m=materials.get(material);if(!m){m={name:material.name,type:material.type,triangles:0,normalMap:!!material.normalMap,map:!!material.map,side:material.side,alphaTest:material.alphaTest,transparent:material.transparent,roughness:material.roughness,metalness:material.metalness,opacity:material.opacity};materials.set(material,m);}m.triangles+=t*n;}
  });
  const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});let webgpu=null;
  if(adapter){const limits={};for(const name of ['maxStorageBufferBindingSize','maxBufferSize','maxStorageBuffersPerShaderStage','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupStorageSize'])limits[name]=adapter.limits[name];webgpu={info:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description},features:[...adapter.features],limits};}
  return {webgpu,placements,weightedTriangles:triangles,uniqueGeometries:geometry.size,uniqueTriangles:[...geometry.values()].reduce((s,g)=>s+g.triangles,0),attributeBytes,geometry:[...geometry.values()].sort((a,b)=>b.weightedTriangles-a.weightedTriangles),materials:[...materials.values()].sort((a,b)=>b.triangles-a.triangles)};
 });
 await writeFile(`${out}/render-budget.json`,JSON.stringify({timestamp:new Date().toISOString(),...report,errors},null,2));
 console.log(JSON.stringify({...report,geometry:report.geometry.slice(0,20),materials:report.materials.slice(0,15),errors},null,2));
}finally{await browser.close();}
