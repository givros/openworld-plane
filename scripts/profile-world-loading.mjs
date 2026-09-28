import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FourBiomeWorld } from '../src/world/FourBiomeWorld.ts';

// CPU-only fixture identical to world.test.mjs. Runtime and exported assets
// remain untouched; timings below include only the named synchronous calls.
const manifest=JSON.parse(await readFile(new URL('../public/environments/world-manifest.json',import.meta.url),'utf8'));
const terrain=JSON.parse(await readFile(new URL('../public/environments/terrain.json',import.meta.url),'utf8'));
const out=new URL('../artifacts/four-horizons/loading-profile/',import.meta.url);
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)??'cpu-loading';
if(!/^[a-z0-9-]+$/.test(label))throw new Error('The profile label must contain only lower-case letters, digits or hyphens.');
await mkdir(out,{recursive:true});
const report={fixture:'NodeGeometryTextureFixture',timestamp:new Date().toISOString(),node:process.version,biomes:[]};
const world=new FourBiomeWorld(manifest,terrain),loader=new GLTFLoader();
loader.register(()=>({name:'NodeGeometryTextureFixture',loadTexture:async()=>new THREE.Texture()}));
const started=performance.now();
for(const biome of manifest.biomes){
  console.log(`START ${biome.id}`);
  const entry={id:biome.id};
  let t=performance.now();
  const bytes=await readFile(new URL(`../public${biome.url}`,import.meta.url));
  entry.readMs=performance.now()-t;entry.bytes=bytes.byteLength;
  t=performance.now();const data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  entry.bufferCopyMs=performance.now()-t;
  t=performance.now();const gltf=await loader.parseAsync(data,'');entry.parseMs=performance.now()-t;
  const scene=gltf.scene;
  entry.rootChildren=scene.children.length;
  entry.nodes=gltf.parser.json.nodes.length;
  entry.meshDefinitions=gltf.parser.json.meshes.length;
  entry.primitiveDefinitions=gltf.parser.json.meshes.reduce((n,m)=>n+m.primitives.length,0);
  const uniqueMaterials=new Set();let meshCount=0;
  scene.traverse(object=>{if(object.isMesh){meshCount++;for(const material of Array.isArray(object.material)?object.material:[object.material])uniqueMaterials.add(material);}});
  entry.meshObjects=meshCount;entry.uniqueMaterials=uniqueMaterials.size;
  entry.attachPhases={};
  // Do not wrap remove/dispatchEvent: those observable overrides deliberately
  // select the compatibility path in detachImportedScene.
  for(const method of ['updateMatrixWorld','traverse','traverseVisible']){
    const original=scene[method];
    scene[method]=function(...args){
      const before=performance.now();
      try{return original.apply(this,args);}finally{
        const metric=entry.attachPhases[method]??={calls:0,ms:0};metric.calls++;metric.ms+=performance.now()-before;
      }
    };
  }
  t=performance.now();world.attachScene(biome.id,scene);entry.attachMs=performance.now()-t;
  entry.transfer=world.diagnostics.biomeTransfers.find(item=>item.id===biome.id);
  entry.memory=process.memoryUsage();
  report.biomes.push(entry);
  await writeFile(new URL(`${label}.json`,out),JSON.stringify(report,null,2));
  console.log(JSON.stringify(entry));
}
report.totalLoadMs=performance.now()-started;
report.diagnostics=world.diagnostics;
const beforeDispose=performance.now();world.dispose();report.disposeMs=performance.now()-beforeDispose;
await writeFile(new URL(`${label}.json`,out),JSON.stringify(report,null,2));
console.log(`COMPLETE ${report.totalLoadMs.toFixed(1)}ms`);
