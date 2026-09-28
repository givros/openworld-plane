// CPU-only read-only scene fixture: full GLB buffers, actual transfer/CSM code.
// No renderer, browser, GPU, source mutation or production optimization enabled.
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FourBiomeWorld} from '../src/world/FourBiomeWorld.ts';
import {Atmosphere} from '../src/systems/Atmosphere.ts';
import {freezeStaticLocalMatrices} from '../src/world/freezeStaticLocalMatrices.ts';

const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const terrain=JSON.parse(await readFile('public/environments/terrain.json','utf8'));
const world=new FourBiomeWorld(manifest,terrain),loader=new GLTFLoader();
loader.register(()=>({name:'NodeGeometryTextureFixture',loadTexture:async()=>new THREE.Texture()}));
const start=performance.now();
for(const biome of manifest.biomes){
 const bytes=await readFile(`public${biome.url}`),gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 world.attachScene(biome.id,gltf.scene);console.log('LOADED',biome.id,Math.round(performance.now()-start));
}
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,1440/900,.15,16000);
scene.fog=new THREE.Fog('#ffffff',1500,5400);scene.add(world.root);
const atmosphere=new Atmosphere(scene,{shadowMap:{autoUpdate:true}},camera);
scene.updateMatrixWorld(true);
const matrix=new THREE.Matrix4(),combined=new THREE.Matrix4(),sphere=new THREE.Sphere();
const meshes=[];let weightedTriangles=0;
world.root.traverse(object=>{
 if(!object.isMesh)return;
 const triangles=(object.geometry.index?.count??object.geometry.attributes.position.count)/3;
 const count=object.isInstancedMesh?object.count:1,instanceSpheres=object.isInstancedMesh?new Float64Array(count*4):null;
 if(instanceSpheres){
  for(let i=0;i<count;i++){
   object.getMatrixAt(i,matrix);combined.multiplyMatrices(object.matrixWorld,matrix);
   sphere.copy(object.geometry.boundingSphere).applyMatrix4(combined);
   instanceSpheres.set([...sphere.center.toArray(),sphere.radius],i*4);
  }
 }
 meshes.push({mesh:object,triangles,count,instanceSpheres});weightedTriangles+=triangles*count;
});
const report={timestamp:new Date().toISOString(),scope:'Offline exact geometry and current CSM/caster-volume acceptance; bounds rejection only, not occlusion or a GPU performance forecast.',
 instanceSphereBasis:'Conservative source geometry spheres captured after GLTF transfer, before the first receiver-bounds refresh; imported accessor-based spheres can be looser than recomputed vertex spheres. Rejection percentages are conservative opportunities, not claimed maximal rejection.',
 fixture:'Full GLTF geometry with dummy textures; current FourBiomeWorld and Atmosphere; aircraft/clouds excluded from counted world work. Aircraft has no shadow-receiving parts, so it does not change receiver bounds.',
 loadMs:performance.now()-start,world:world.diagnostics,rows:[],cpu:[],conditions:'Concurrent master CPU processing may affect timings; use operation counts and matched within-process tests, not an isolated production benchmark.'};
delete report.world.resourceIdentities;
if(weightedTriangles!==report.world.sourceTriangles)throw new Error('World triangle count mismatch');
const proxy={geometry:{boundingSphere:sphere},matrixWorld:new THREE.Matrix4()};
function passStatistics(name,frustum){
 const row={pass:name,batchDraws:0,batchTriangles:0,instanceFilteredDraws:0,instanceFilteredTriangles:0,batchInstances:0,retainedInstances:0};
 const started=performance.now();
 for(const {mesh,triangles,count,instanceSpheres} of meshes){
  if(!mesh.visible||!mesh.layers.test(camera.layers)||(name!=='beauty'&&!mesh.castShadow)||!frustum.intersectsObject(mesh))continue;
  row.batchDraws++;row.batchTriangles+=triangles*count;row.batchInstances+=count;
  if(!instanceSpheres){row.instanceFilteredDraws++;row.instanceFilteredTriangles+=triangles;row.retainedInstances++;continue;}
  let retained=0;
  for(let i=0;i<count;i++){
   const j=i*4;sphere.center.fromArray(instanceSpheres,j);sphere.radius=instanceSpheres[j+3];
   if(frustum.intersectsObject(proxy))retained++;
  }
  if(retained){row.instanceFilteredDraws++;row.instanceFilteredTriangles+=triangles*retained;row.retainedInstances+=retained;}
 }
 row.rejectedTriangles=row.batchTriangles-row.instanceFilteredTriangles;
 row.rejectedTrianglePercent=row.batchTriangles?100*row.rejectedTriangles/row.batchTriangles:0;
 row.cpuCountingMs=performance.now()-started;return row;
}
function timeOperation(name,fn,repeats=20){
 for(let i=0;i<3;i++)fn();const times=[];
 for(let i=0;i<repeats;i++){const now=performance.now();fn();times.push(performance.now()-now);}
 times.sort((a,b)=>a-b);return {name,repeats,medianMs:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)]};
}
for(const biome of manifest.biomes){
 const view=world.getReviewView(biome.id,120);camera.position.fromArray(view.camera);camera.lookAt(new THREE.Vector3().fromArray(view.target));camera.updateProjectionMatrix();
 const location=world.findBiome(biome.id),position=new THREE.Vector3(location.x,world.sampleGroundHeight(location.x,location.z)+120,location.z);
 atmosphere.update(0,position,120);scene.updateMatrixWorld();
 const projection=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
 const frustum=new THREE.Frustum().setFromProjectionMatrix(projection);
 const passes=[passStatistics('beauty',frustum)];
 atmosphere.sunlight.lights.forEach((light,index)=>{light.shadow.updateMatrices(light);passes.push(passStatistics(`cascade-${index+1}`,light.shadow.getFrustum()));});
 const shadows=passes.slice(1).reduce((sum,p)=>({batchTriangles:sum.batchTriangles+p.batchTriangles,instanceFilteredTriangles:sum.instanceFilteredTriangles+p.instanceFilteredTriangles}),{batchTriangles:0,instanceFilteredTriangles:0});
 shadows.rejectedTrianglePercent=shadows.batchTriangles?100*(shadows.batchTriangles-shadows.instanceFilteredTriangles)/shadows.batchTriangles:0;
 const row={biome:biome.id,camera:view.camera,target:view.target,passes,shadows};report.rows.push(row);console.log('CULLING',JSON.stringify(row));
 report.cpu.push({biome:biome.id,operations:[
  timeOperation('scene.updateMatrixWorld',()=>scene.updateMatrixWorld()),
  timeOperation('receiverBounds.update',()=>atmosphere.receiverBounds.update(scene)),
  timeOperation('Atmosphere.prepareRender',()=>atmosphere.prepareRender()),
 ]});
}
const restoreLocals=freezeStaticLocalMatrices(world.root);
report.localFreezeDiagnostic={
 timing:timeOperation('scene.updateMatrixWorld with static locals only',()=>scene.updateMatrixWorld(),40),
 worldMatrixAutoUpdatePreserved:true,rootPlacementMutable:true,
 invariant:'Only authored descendant local transforms are static; Three world-matrix propagation and newly added dynamic children remain unchanged.'
};
restoreLocals();
// Quantify redundant world-matrix multiplications without changing production.
let multiplies=0;const multiply=THREE.Matrix4.prototype.multiplyMatrices;
THREE.Matrix4.prototype.multiplyMatrices=function(...args){multiplies++;return multiply.apply(this,args);};
scene.updateMatrixWorld();const standardMultiplications=multiplies;
THREE.Matrix4.prototype.multiplyMatrices=multiply;
const saved=[];world.root.traverse(object=>{saved.push([object,object.matrixAutoUpdate,object.matrixWorldAutoUpdate]);object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false;});
multiplies=0;THREE.Matrix4.prototype.multiplyMatrices=function(...args){multiplies++;return multiply.apply(this,args);};scene.updateMatrixWorld();
THREE.Matrix4.prototype.multiplyMatrices=multiply;
report.staticFreezeDiagnostic={standardMultiplications,frozenWorldMultiplications:multiplies,timing:timeOperation('scene.updateMatrixWorld with explicitly frozen world fixture',()=>scene.updateMatrixWorld()),invariant:'A production implementation must preserve or invalidate all moved ancestors and child matrices; this fixture is static only.'};
for(const [object,auto,worldAuto] of saved){object.matrixAutoUpdate=auto;object.matrixWorldAutoUpdate=worldAuto;}
await writeFile('artifacts/four-horizons/loading-profile/instance-culling-audit.json',JSON.stringify(report,null,2));
console.log('CPU',JSON.stringify(report.cpu));console.log('LOCAL_MATRIX',JSON.stringify(report.localFreezeDiagnostic));console.log('MATRIX',JSON.stringify(report.staticFreezeDiagnostic));
atmosphere.dispose();world.dispose();console.log('COMPLETE');
