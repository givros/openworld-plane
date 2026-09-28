import { readFileSync,writeFileSync,mkdirSync,existsSync,renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { register } from 'node:module';
import * as THREE from 'three';

// Run directly with Node; reuse the project's existing TypeScript loader.
register('./typescript-loader.mjs',import.meta.url);
const {reuseExactShadowVertices}=await import('../src/world/reuseExactVertices.ts');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourcePath=path.join(root,'public/environments/stream/manifest.json');
const outputDirectory=path.join(root,'public/environments/shadow-indices');
const reportDirectory=path.join(root,'artifacts/performance-20260926/vertex-reuse');
const minimumTriangles=1500;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceManifestBytes=readFileSync(sourcePath),sourceManifestSha256=digest(sourceManifestBytes);
const manifest=JSON.parse(sourceManifestBytes.toString('utf8'));
if(manifest.version!==1||manifest.complete!==true)throw new Error('The source stream manifest is incomplete or unsupported.');
mkdirSync(outputDirectory,{recursive:true});mkdirSync(reportDirectory,{recursive:true});
const types={Float32Array,Float64Array,Uint32Array,Int32Array,Uint16Array,Int16Array,Uint8Array,Int8Array,Uint8ClampedArray};
function publicFile(url){
  if(typeof url!=='string'||!url.startsWith('/environments/stream/'))throw new Error('Source URL is outside the original stream directory.');
  const resolved=path.resolve(root,'public',url.slice(1));
  const allowed=path.resolve(root,'public/environments/stream')+path.sep;
  if(!resolved.startsWith(allowed))throw new Error('Invalid source stream path.');
  return resolved;
}
function view(bytes,definition){
  const Type=types[definition.arrayType];
  if(!Type||!Number.isInteger(definition.byteOffset)||!Number.isInteger(definition.bytes)||definition.byteOffset<0||definition.bytes<0||
    definition.byteOffset+definition.bytes>bytes.byteLength||definition.bytes%Type.BYTES_PER_ELEMENT)throw new Error('Unsupported source attribute layout.');
  const offset=bytes.byteOffset+definition.byteOffset;
  if(offset%Type.BYTES_PER_ELEMENT)throw new Error('Misaligned source attribute.');
  return new Type(bytes.buffer,offset,definition.bytes/Type.BYTES_PER_ELEMENT);
}
function geometryFrom(bytes,definition){
  const p=definition.attributes.position;
  if(!p||!types[p.arrayType]||p.itemSize!==3||p.count*p.itemSize!==p.bytes/types[p.arrayType].BYTES_PER_ELEMENT)throw new Error('Invalid position layout.');
  const geometry=new THREE.BufferGeometry(),position=new THREE.BufferAttribute(view(bytes,p),p.itemSize,p.normalized);
  position.gpuType=p.gpuType;geometry.setAttribute('position',position);
  geometry.setIndex(new THREE.BufferAttribute(view(bytes,definition.index),1));
  if(geometry.index.count!==definition.index.count||geometry.index.count!==definition.triangles*3)throw new Error('Source triangle/index count mismatch.');
  for(const group of definition.groups)geometry.addGroup(group.start,group.count,group.materialIndex);
  geometry.setDrawRange(definition.drawRange.start,definition.drawRange.count??Infinity);
  return geometry;
}
function verifyEveryTrianglePosition(source,optimized){
  if(source.getAttribute('position')!==optimized.getAttribute('position'))throw new Error('Shadow position buffer was copied.');
  if(source.index.count!==optimized.index.count||JSON.stringify(source.groups)!==JSON.stringify(optimized.groups)||
    source.drawRange.start!==optimized.drawRange.start||source.drawRange.count!==optimized.drawRange.count)throw new Error('Shadow draw contract changed.');
  const attribute=source.getAttribute('position'),array=attribute.array;
  const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength),stride=attribute.itemSize*array.BYTES_PER_ELEMENT;
  const sourceSeen=new Uint8Array(attribute.count),optimizedSeen=new Uint8Array(attribute.count);
  let sourceReferencedVertices=0,optimizedReferencedVertices=0;
  for(let slot=0;slot<source.index.count;slot++){
    const original=source.index.array[slot],target=optimized.index.array[slot];
    if(target>original||target>=attribute.count)throw new Error('Index does not reference a first original vertex slot.');
    if(!sourceSeen[original]){sourceSeen[original]=1;sourceReferencedVertices++;}
    if(!optimizedSeen[target]){optimizedSeen[target]=1;optimizedReferencedVertices++;}
    const from=original*stride,to=target*stride;
    for(let byte=0;byte<stride;byte++)if(bytes[from+byte]!==bytes[to+byte])throw new Error(`Shadow triangle position changed at slot ${slot}, byte ${byte}.`);
  }
  return {sourceReferencedVertices,optimizedReferencedVertices};
}
const candidates=manifest.geometries.filter(g=>g.triangles>=minimumTriangles);
const cache=new Map(),outputFiles=new Map(),geometries=[],skipped=[],timings=[];
const material=new THREE.MeshStandardMaterial();
let inputBytes=0,verifiedDrawSlots=0,verifiedPositionBytes=0;
const started=performance.now();
for(const definition of candidates){
  const p=definition.attributes.position,i=definition.index;
  // Same bytes alone are insufficient: layouts, groups and draw ranges are part
  // of the interpretation and therefore part of the source cache identity.
  const key=JSON.stringify([definition.sha256,definition.bytes,p,i,definition.groups,definition.drawRange]);
  let record=cache.get(key);
  if(record===undefined){
    const begin=performance.now(),binary=readFileSync(publicFile(definition.url));
    if(binary.byteLength!==definition.bytes||digest(binary)!==definition.sha256)throw new Error(`Source geometry ${definition.id} does not match its manifest.`);
    if(digest(binary.subarray(p.byteOffset,p.byteOffset+p.bytes))!==p.sha256||digest(binary.subarray(i.byteOffset,i.byteOffset+i.bytes))!==i.sha256)
      throw new Error(`Source geometry ${definition.id} position/index fingerprint mismatch.`);
    inputBytes+=binary.byteLength;
    const source=geometryFrom(binary,definition),mesh=new THREE.Mesh(source,material);
    const optimized=reuseExactShadowVertices(mesh),verified=verifyEveryTrianglePosition(source,optimized);
    verifiedDrawSlots+=source.index.count;verifiedPositionBytes+=source.index.count*p.itemSize*source.attributes.position.array.BYTES_PER_ELEMENT;
    if(digest(binary)!==definition.sha256)throw new Error(`Source geometry ${definition.id} was mutated in memory.`);
    if(optimized===source)record=null;
    else{
      const array=optimized.index.array,indexBytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength),sha256=digest(indexBytes);
      const filename=`${sha256}.bin`,outputPath=path.join(outputDirectory,filename);
      if(!outputFiles.has(sha256)){
        if(existsSync(outputPath)){
          const existing=readFileSync(outputPath);
          if(existing.byteLength!==indexBytes.byteLength||digest(existing)!==sha256)throw new Error('Existing acceleration index has invalid content.');
        }else writeFileSync(outputPath,indexBytes,{flag:'wx'});
        outputFiles.set(sha256,indexBytes.byteLength);
      }
      record={url:`/environments/shadow-indices/${filename}`,bytes:indexBytes.byteLength,arrayType:array.constructor.name,count:array.length,sha256,
        sourceVertexCount:p.count,uniquePositionCount:verified.optimizedReferencedVertices,...verified};
    }
    cache.set(key,record);timings.push({geometryId:definition.id,changed:record!==null,milliseconds:performance.now()-begin});
    if(cache.size%100===0)console.log(`Verified ${cache.size} unique source geometries; ${outputFiles.size} unique shadow index buffers.`);
  }
  if(record===null){skipped.push({geometryId:definition.id,reason:'No repeated referenced positions or unsupported static depth layout'});continue;}
  geometries.push({geometryId:definition.id,sourceSha256:definition.sha256,sourcePositionSha256:p.sha256,sourceIndexSha256:i.sha256,...record});
}
// Publish a complete pack only if the original source manifest stayed unchanged.
if(digest(readFileSync(sourcePath))!==sourceManifestSha256)throw new Error('Original stream manifest changed during the build.');
const output={version:1,complete:true,sourceManifestSha256,minimumTriangles,geometries};
const temporaryManifest=path.join(outputDirectory,'manifest.pending.json'),targetManifest=path.join(outputDirectory,'manifest.json');
writeFileSync(temporaryManifest,JSON.stringify(output));renameSync(temporaryManifest,targetManifest);
const report={date:new Date().toISOString(),sourceManifestSha256,minimumTriangles,sourceGeometries:manifest.geometries.length,
  candidateGeometryIds:candidates.length,uniqueSourceDefinitions:cache.size,optimizedGeometryIds:geometries.length,
  unchangedGeometryIds:skipped.length,uniqueIndexBuffers:outputFiles.size,uniqueIndexBytes:[...outputFiles.values()].reduce((a,b)=>a+b,0),
  uniqueSourceBytesRead:inputBytes,verifiedDrawSlots,verifiedPositionBytes,
  invariants:{allTrianglePositionBytesExact:true,triangleCountAndOrderUnchanged:true,firstOriginalVertexSlots:true,
    originalPositionBuffersShared:true,sourceStreamManifestUnchanged:true,sourceStreamFilesReadOnly:true},
  buildMilliseconds:performance.now()-started,skipped,timings};
writeFileSync(path.join(reportDirectory,'offline-pack-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,skipped:undefined,timings:undefined},null,2));
