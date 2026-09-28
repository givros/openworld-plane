import * as THREE from 'three';

/** Load full precision companion data; source PNG bytes and sampler settings are retained. */
export async function loadTriangleRasterDataset(baseURL, {maximumTextureSize=16384,onProgress=()=>{}}={}) {
 const json=async name=>{const r=await fetch(`${baseURL}/${name}`);if(!r.ok)throw new Error(`Missing ${name}`);return r.json();};
 const binary=async name=>{onProgress(name);const r=await fetch(`${baseURL}/${name}`);if(!r.ok)throw new Error(`Missing ${name}`);return r.arrayBuffer();};
 const manifest=await json('attribute-manifest.json'),batches=await json(manifest.sourceBatches);
 const arrays=new Map();
 for(const name of ['positions.bin','triangles.bin',...Object.keys(manifest.attributeFiles),manifest.nativeTransformFactors.instanceMatrices.file])arrays.set(name,await binary(name));
 if(manifest.nativeTransformFactors.instanceColorBytes)arrays.set('attribute-instance-colors.bin',await binary('attribute-instance-colors.bin'));
 const positions=new Float32Array(arrays.get('positions.bin')),triangles=new Uint32Array(arrays.get('triangles.bin'));
 const geometries=manifest.geometries.map(g=>{
  const result={vertexOffset:g.vertexOffset,vertexCount:g.vertices,triangleOffset:g.triangleOffset,triangleCount:g.triangles};
  for(const [name,a] of Object.entries(g.attributes)){
   const Type={Float32Array,Uint8Array,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array}[a.arrayType];
   if(!Type)throw new Error(`Unsupported unchanged attribute ${a.arrayType}`);
   result[name]={array:new Type(arrays.get(a.file),a.byteOffset,a.bytes/Type.BYTES_PER_ELEMENT),itemSize:a.itemSize,normalized:a.normalized};
  }
  return result;
 });
 const instances=new Array(manifest.placements),nativeBatches=[],batchKeys=new Map(),sourceBatchIds=new Uint32Array(manifest.placements);
 for(const batch of batches){
  const key=JSON.stringify([batch.isInstancedMesh,batch.modelMatrix]);let batchId=batchKeys.get(key);
  if(batchId===undefined){batchId=nativeBatches.length;batchKeys.set(key,batchId);nativeBatches.push({matrixWorld:new THREE.Matrix4().fromArray(batch.modelMatrix),instanced:batch.isInstancedMesh});}
  for(let slot=0;slot<batch.count;slot++){
   const instanceId=batch.sourceStart+slot;
   instances[instanceId]={geometry:batch.geometryId,batch:batchId,material:batch.materialId,matrix:new Float32Array(arrays.get(batch.instanceMatrix.file),batch.instanceMatrix.byteOffset+slot*64,16)};
   if(batch.instanceColor)instances[instanceId].color=new Float32Array(arrays.get(batch.instanceColor.file),batch.instanceColor.byteOffset+slot*12,3);
   sourceBatchIds[instanceId]=batch.id;
  }
 }
 const imageTextures=new Map(),loader=new THREE.TextureLoader();
 for(const image of manifest.images){onProgress(image.file);imageTextures.set(image.id,await loader.loadAsync(`${baseURL}/${image.file}`));}
 const textures=manifest.textures.map(description=>{
  const t=imageTextures.get(description.image).clone();
  for(const [key,value] of Object.entries(description)){
   if(['id','name','image','source','matrix'].includes(key))continue;
   if(['offset','repeat','center'].includes(key))t[key].fromArray(value);else if(key in t)t[key]=value;
  }
  t.name=description.name;t.matrix.fromArray(description.matrix);t.needsUpdate=true;return t;
 });
 const materials=manifest.materials.map(description=>{
  const m=new THREE.MeshStandardMaterial();
  for(const [key,value] of Object.entries(description)){
   if(key==='id'||key==='type'||key.startsWith('is')||!(key in m))continue;
   if(value&&typeof value==='object'&&'texture' in value){m[key]=textures[value.texture];continue;}
   if(m[key]?.isColor||m[key]?.isVector2||m[key]?.isVector3){m[key].fromArray(value);continue;}
   m[key]=value&&typeof value==='object'?structuredClone(value):value;
  }
  return m;
 });
 return {manifest,batches,sourceBatchIds,materials,textures,
  input:{positions,triangles,geometries,batches:nativeBatches,instances,maxTextureSize:maximumTextureSize},
  disposeMaterials(){for(const m of materials)m.dispose();for(const t of textures)t.dispose();for(const t of imageTextures.values())t.dispose();}};
}
