import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { StreamResourceCache } from '../src/world/StreamResources.ts';
import { exactShadowGeometry } from '../src/world/ExactShadowGeometry.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('exact shadow indices follow geometry leases and stale source hashes use canonical shadows',async()=>{
 for(const stale of [false,true]){
  const f=fixture();f.geometry.attributes.position.sha256='position';f.geometry.index.sha256='index';
  const shadow={geometryId:0,sourceSha256:stale?'stale':'fixture',sourcePositionSha256:'position',sourceIndexSha256:'index',url:'/shadow.bin',bytes:6,arrayType:'Uint16Array',count:3};
  let shadowReads=0;
  const cache=new StreamResourceCache(f.manifest,{shadowIndices:[shadow],readBinary:async url=>{if(url==='/shadow.bin'){shadowReads++;return new Uint16Array([2,0,1]).buffer;}return f.binary;}});
  const geometry=await cache.acquireGeometry(0),mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());
  assert.equal(shadowReads,stale?0:1);assert.equal(cache.stats.shadowIndexBytes,stale?0:6);assert.equal(cache.stats.geometryBytes,stale?52:58);
  const depth=exactShadowGeometry(mesh);assert.equal(!!depth,!stale);if(depth)assert.equal(depth.attributes.position,geometry.attributes.position);
  cache.releaseGeometry(0);assert.equal(cache.stats.geometryBytes,0);assert.equal(exactShadowGeometry(mesh),undefined);cache.dispose();
 }
});

test('retiring a source during shadow-index loading aborts its lease and cannot expose partial geometry',async()=>{
 const f=fixture(),pending=deferred();f.geometry.attributes.position.sha256='position';f.geometry.index.sha256='index';let shadowSignal;
 const cache=new StreamResourceCache(f.manifest,{shadowIndices:[{geometryId:0,sourceSha256:'fixture',sourcePositionSha256:'position',sourceIndexSha256:'index',url:'/shadow.bin',bytes:6,arrayType:'Uint16Array',count:3}],
  readBinary:async(url,signal)=>{if(url==='/shadow.bin'){shadowSignal=signal;return pending.promise;}return f.binary;}});
 const loading=cache.acquireGeometry(0);await tick();cache.releaseGeometry(0);assert.equal(shadowSignal.aborted,true);
 pending.resolve(new Uint16Array([2,0,1]).buffer);await assert.rejects(loading,{name:'AbortError'});assert.equal(cache.stats.geometryBytes,0);cache.dispose();
});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function fixture(){
 const binary=new ArrayBuffer(52);
 new Float32Array(binary,0,9).set([0,-0,0,1,0,0,0,1,0]);
 new Uint8Array(binary,36,9).set([255,0,0,0,128,0,0,0,64]);
 new Uint16Array(binary,46,3).set([2,0,1]);
 const geometry={id:0,name:'Exact triangle',url:'/geometry.bin',bytes:52,sha256:'fixture',
  attributes:{position:{byteOffset:0,bytes:36,count:3,itemSize:3,arrayType:'Float32Array',normalized:false,gpuType:THREE.FloatType},
   color:{byteOffset:36,bytes:9,count:3,itemSize:3,arrayType:'Uint8Array',normalized:true,gpuType:THREE.FloatType}},
  index:{byteOffset:46,bytes:6,count:3,arrayType:'Uint16Array'},bounds:[0,0,0,1,1,0],boundingSphere:{center:[.5,.5,0],radius:Math.SQRT1_2},
  groups:[{start:0,count:3,materialIndex:0}],drawRange:{start:0,count:3},triangles:1};
 const texture={id:0,name:'Original normal',image:'shared-image',offset:[.2,.3],repeat:[3,4],center:[.5,.5],rotation:.25,
  matrix:[1,2,3,4,5,6,7,8,9],matrixAutoUpdate:false,wrapS:THREE.RepeatWrapping,wrapT:THREE.MirroredRepeatWrapping,
  minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,anisotropy:8,channel:1,
  colorSpace:THREE.NoColorSpace,flipY:false,generateMipmaps:true,premultiplyAlpha:false,unpackAlignment:1};
 const material={id:0,type:'MeshStandardMaterial',name:'Preserved surface',color:[.15,.25,.35],emissive:[.01,.02,.03],
  normalMap:{texture:0},roughnessMap:{texture:0},normalScale:[.5,-.5],roughness:.73,metalness:.12,
  side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-3,userData:{source:'fixture'}};
 const manifest={geometries:[geometry],textures:[texture,{...texture,id:1,repeat:[8,8]}],images:[{id:'shared-image',url:'/original.png',bytes:8,width:2,height:2}],
  materials:[material,{...material,id:1,normalMap:{texture:1},roughnessMap:null}]};
 return{manifest,binary,geometry,texture,material};
}

test('geometry leases share exact byte views, original indices and precomputed bounds without scanning',async()=>{
 const f=fixture();let reads=0;
 const cache=new StreamResourceCache(f.manifest,{readBinary:async()=>{reads++;return f.binary;}});
 const a=cache.acquireGeometry(0),b=cache.acquireGeometry(0);
 assert.equal(a,b);assert.equal(cache.stats.pendingGeometries,1);
 const geometry=await a;assert.equal(await b,geometry);assert.equal(reads,1);
 assert.equal(geometry.attributes.position.array.buffer,f.binary);assert.equal(geometry.attributes.color.array.buffer,f.binary);
 assert.equal(Object.is(geometry.attributes.position.array[1],-0),true);
 assert.deepEqual([...geometry.index.array],[2,0,1]);assert.equal(geometry.attributes.color.normalized,true);
 assert.deepEqual(geometry.boundingBox.min.toArray(),[0,0,0]);assert.deepEqual(geometry.boundingSphere.center.toArray(),[.5,.5,0]);
 assert.equal(geometry.boundingSphere.radius,Math.SQRT1_2);assert.deepEqual(geometry.groups,f.geometry.groups);assert.deepEqual(geometry.drawRange,f.geometry.drawRange);
 let disposed=0;geometry.addEventListener('dispose',()=>disposed++);
 cache.releaseGeometry(0);assert.equal(disposed,0);assert.equal(cache.stats.geometryBytes,52);
 cache.releaseGeometry(0);assert.equal(disposed,1);assert.equal(cache.stats.geometryBytes,0);
 const again=await cache.acquireGeometry(0);assert.notEqual(again,geometry);assert.equal(reads,2);
 cache.dispose();assert.equal(cache.stats.geometries,0);await assert.rejects(cache.acquireGeometry(0),/disposed/);
});

test('different canonical geometry IDs share only identical bytes, layouts, groups and draw ranges',async()=>{
 const f=fixture();let reads=0;
 f.manifest.geometries.push({...structuredClone(f.geometry),id:1,name:'Another semantic batch',url:'/duplicate.bin'});
 f.manifest.geometries.push({...structuredClone(f.geometry),id:2,groups:[]});
 f.manifest.geometries.push({...structuredClone(f.geometry),id:3,attributes:{...structuredClone(f.geometry.attributes),color:{...f.geometry.attributes.color,normalized:false}}});
 const cache=new StreamResourceCache(f.manifest,{readBinary:async()=>{reads++;return f.binary.slice(0);}});
 const [a,b,c,d]=await Promise.all([0,1,2,3].map(id=>cache.acquireGeometry(id)));
 assert.equal(a,b);assert.notEqual(a,c);assert.notEqual(a,d);assert.equal(reads,3);
 assert.deepEqual(a.userData.streamGeometryIds,[0,1]);assert.equal(cache.stats.geometries,3);assert.equal(cache.stats.geometryBytes,156);
 let disposed=0;a.addEventListener('dispose',()=>disposed++);
 cache.releaseGeometry(0);assert.equal(disposed,0);cache.releaseGeometry(1);assert.equal(disposed,1);
 cache.releaseGeometry(2);cache.releaseGeometry(3);assert.equal(cache.stats.geometryBytes,0);cache.dispose();
});

test('materials retain linear values and exact texture flags while shared images close only after their last sampler variant',async()=>{
 const f=fixture();let loads=0,closed=0;
 const image={width:2,height:2,close(){closed++;}};
 const cache=new StreamResourceCache(f.manifest,{readBinary:async()=>{throw new Error('Unexpected read');},loadImage:async()=>{loads++;return image;}});
 const [a,a2,b]=await Promise.all([cache.acquireMaterial(0),cache.acquireMaterial(0),cache.acquireMaterial(1)]);
 assert.equal(a,a2);assert.equal(loads,1);assert.equal(a.normalMap,a.roughnessMap);
 assert.notEqual(a.normalMap,b.normalMap);assert.equal(a.normalMap.image,b.normalMap.image);
 assert.deepEqual(a.color.toArray(),f.material.color);assert.deepEqual(a.normalScale.toArray(),[.5,-.5]);
 assert.equal(a.polygonOffset,true);assert.equal(a.polygonOffsetFactor,-2);assert.equal(a.polygonOffsetUnits,-3);
 assert.equal(a.userData.streamMaterialId,0);assert.equal(a.userData.source,'fixture');
 assert.deepEqual(a.normalMap.matrix.elements,f.texture.matrix);assert.deepEqual(a.normalMap.repeat.toArray(),[3,4]);
 assert.equal(a.normalMap.flipY,false);assert.equal(a.normalMap.matrixAutoUpdate,false);assert.equal(a.normalMap.channel,1);
 assert.equal(a.normalMap.wrapT,THREE.MirroredRepeatWrapping);assert.equal(a.normalMap.anisotropy,8);
 assert.deepEqual(cache.stats,{geometries:0,materials:2,textures:2,images:1,geometryBytes:0,pendingGeometries:0,shadowIndexBytes:0});
 let materialDisposals=0,textureDisposals=0;a.addEventListener('dispose',()=>materialDisposals++);a.normalMap.addEventListener('dispose',()=>textureDisposals++);
 cache.releaseMaterial(0);assert.equal(materialDisposals,0);
 cache.releaseMaterial(0);assert.equal(materialDisposals,1);assert.equal(textureDisposals,1);assert.equal(closed,0);
 cache.releaseMaterial(1);assert.equal(closed,1);assert.equal(cache.stats.images,0);cache.dispose();assert.equal(closed,1);
});

test('pending last-release aborts, and stale completion cannot replace a newer generation',async()=>{
 const f=fixture(),requests=[];
 const cache=new StreamResourceCache(f.manifest,{readBinary:(_url,signal)=>{const request=deferred();requests.push({...request,signal});return request.promise;}});
 const old=cache.acquireGeometry(0);const oldResult=old.catch(error=>error);await tick();
 cache.releaseGeometry(0);assert.equal(requests[0].signal.aborted,true);
 const fresh=cache.acquireGeometry(0);await tick();requests[1].resolve(f.binary.slice(0));
 const current=await fresh;requests[0].resolve(f.binary);assert.equal((await oldResult).name,'AbortError');
 assert.equal(cache.stats.geometries,1);assert.notEqual(current.attributes.position.array.buffer,f.binary);
 const retained=cache.acquireGeometry(0);assert.equal(await retained,current);
 cache.releaseGeometry(0);cache.releaseGeometry(0);assert.equal(cache.stats.geometries,0);cache.dispose();
});

test('failed material loading immediately releases pending dependencies and rejects late images without reattachment',async()=>{
 const f=fixture(),imageRequest=deferred();let closed=0,imageSignal,loads=0;
 f.manifest.materials[0].roughnessMap={texture:99};
 const cache=new StreamResourceCache(f.manifest,{readBinary:async()=>f.binary,loadImage:(_definition,signal)=>{imageSignal=signal;return ++loads===1?imageRequest.promise:Promise.resolve({width:2,height:2,close(){closed++;}});}});
 const pending=cache.acquireMaterial(0);await assert.rejects(pending,/Unknown stream resource: 99/);
 assert.equal(imageSignal.aborted,true);assert.equal(cache.stats.images,0);assert.equal(cache.stats.textures,0);
 imageRequest.resolve({width:2,height:2,close(){closed++;}});await tick();
 assert.equal(closed,1);assert.equal(cache.stats.materials,0);
 cache.releaseMaterial(0);
 f.manifest.materials[0].roughnessMap={texture:0};
 // Definitions remain the authoritative objects; retry only after failed owners released.
 const retry=await cache.acquireMaterial(0);assert.equal(retry.userData.streamMaterialId,0);
 cache.releaseMaterial(0);cache.dispose();assert.equal(closed,2);
});

test('default image decoding uses original bytes without alpha premultiplication or color conversion',async()=>{
 const f=fixture(),original=globalThis.createImageBitmap,decoded=[];let closes=0;
 globalThis.createImageBitmap=async(blob,options)=>{decoded.push({bytes:new Uint8Array(await blob.arrayBuffer()),options,type:blob.type});return{width:2,height:2,close(){closes++;}};};
 const cache=new StreamResourceCache(f.manifest,{readBinary:async url=>{assert.equal(url,'/original.png');return Uint8Array.from([0,1,2,3,4,5,6,7]).buffer;}});
 try{
  await cache.acquireMaterial(0);assert.equal(decoded.length,1);
  assert.deepEqual([...decoded[0].bytes],[0,1,2,3,4,5,6,7]);assert.equal(decoded[0].type,'image/png');
  assert.deepEqual(decoded[0].options,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
  cache.releaseMaterial(0);assert.equal(closes,1);
 }finally{cache.dispose();if(original===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=original;}
});

test('disposal closes late decoded images and never resolves a disposed material',async()=>{
 const f=fixture(),request=deferred();let closed=0,signal;
 const cache=new StreamResourceCache(f.manifest,{readBinary:async()=>f.binary,loadImage:(_definition,abort)=>{signal=abort;return request.promise;}});
 const material=cache.acquireMaterial(0),result=material.catch(error=>error);await tick();
 cache.dispose();assert.equal(signal.aborted,true);
 request.resolve({width:2,height:2,close(){closed++;}});
 assert.equal((await result).name,'AbortError');assert.equal(closed,1);
 assert.deepEqual(cache.stats,{geometries:0,materials:0,textures:0,images:0,geometryBytes:0,pendingGeometries:0,shadowIndexBytes:0});
 cache.releaseMaterial(0);cache.dispose();assert.equal(closed,1);
});

test('all real packed materials and texture variants load with exact scalar/vector properties and shared original image identity',async()=>{
 const manifest=JSON.parse(await readFile('public/environments/stream/manifest.json','utf8'));
 const loadedImages=new Map(),closed=new Map();
 const cache=new StreamResourceCache(manifest,{readBinary:async()=>{throw new Error('No geometry/image bytes needed by this material fixture');},
  loadImage:async definition=>{const image={width:definition.width,height:definition.height,close(){closed.set(definition.id,(closed.get(definition.id)??0)+1);}};loadedImages.set(definition.id,image);return image;}});
 const materials=await Promise.all(manifest.materials.map(description=>cache.acquireMaterial(description.id)));
 for(let i=0;i<materials.length;i++){
  const material=materials[i],definition=manifest.materials[i];assert.equal(material.userData.streamMaterialId,definition.id);
  for(const key of ['color','emissive','normalScale'])assert.deepEqual(material[key].toArray(),definition[key]);
  for(const key of ['roughness','metalness','side','polygonOffset','polygonOffsetFactor','polygonOffsetUnits','vertexColors','fog'])assert.equal(material[key],definition[key]);
  for(const [key,value]of Object.entries(definition))if(value&&typeof value==='object'&&'texture'in value){
   const textureDefinition=manifest.textures[value.texture],texture=material[key];
   assert.equal(texture.image,loadedImages.get(textureDefinition.image));
   assert.deepEqual(texture.matrix.elements,textureDefinition.matrix);assert.equal(texture.flipY,textureDefinition.flipY);
  }
 }
 assert.equal(cache.stats.materials,367);assert.equal(cache.stats.textures,28);assert.equal(cache.stats.images,7);
 for(const material of manifest.materials)cache.releaseMaterial(material.id);
 assert.equal(closed.size,7);assert.ok([...closed.values()].every(count=>count===1));cache.dispose();
});
