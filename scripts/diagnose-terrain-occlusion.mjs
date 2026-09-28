// CPU-only private experiment. Reads exact rendered terrain buffers, never renders.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { ConservativeTerrainOcclusion, findStreamTerrainOccluders } from '../src/experiments/ConservativeTerrainOcclusion.ts';
import { FourBiomeWorld } from '../src/world/FourBiomeWorld.ts';
import { PilotCamera } from '../src/systems/PilotCamera.ts';
import { landscapeVisibility } from '../src/systems/LandscapeVisibility.ts';

const output=path.resolve(process.env.TERRAIN_OCCLUSION_OUTPUT??'artifacts/full-world-20260928/terrain-occlusion.json');
const biomeIds=(process.env.BIOMES??'azure-port,alpine-lake').split(',');
const distance=6000,aspect=1440/900;
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const publicPath=url=>path.join('public',url.replace(/^\//,''));
const manifest=readJSON('public/environments/stream/manifest.json');
const chunks=manifest.chunks.map(definition=>readJSON(publicPath(definition.url)));
const batches=chunks.flatMap(chunk=>chunk.batches);
const evidence=chunks.flatMap(chunk=>findStreamTerrainOccluders(manifest,chunk));
const materialDefinitions=new Map(manifest.materials.map(material=>[material.id,material]));
const arrays={Float32Array,Uint8Array,Uint16Array,Uint32Array};
const terrainSources=evidence.map(item=>{
  const definition=item.geometry,bytes=fs.readFileSync(publicPath(definition.url));
  if(createHash('sha256').update(bytes).digest('hex')!==definition.sha256)throw Error(`Terrain source hash mismatch: ${definition.id}`);
  // Copy into an aligned ArrayBuffer without changing any attribute/index byte.
  const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const position=definition.attributes.position,index=definition.index;
  const geometry=new THREE.BufferGeometry();geometry.name=definition.name;
  geometry.setAttribute('position',new THREE.BufferAttribute(new arrays[position.arrayType](buffer,position.byteOffset,position.count*position.itemSize),position.itemSize,position.normalized));
  geometry.setIndex(new THREE.BufferAttribute(new arrays[index.arrayType](buffer,index.byteOffset,index.count),1));
  for(const group of definition.groups)geometry.addGroup(group.start,group.count,group.materialIndex);
  geometry.setDrawRange(definition.drawRange.start,definition.drawRange.count??Infinity);
  geometry.userData={streamGeometryIds:[definition.id],sourceSha256:definition.sha256};
  const materialDefinition=materialDefinitions.get(item.batch.materialId),material=new THREE.MeshStandardMaterial();
  for(const key of ['side','opacity','transparent','alphaTest','alphaHash','alphaToCoverage','depthWrite','depthTest','depthFunc',
    'polygonOffset','stencilWrite','visible','colorWrite','wireframe','blending'])if(key in materialDefinition)material[key]=materialDefinition[key];
  // Reject any unsupported occlusion-affecting asset feature instead of silently
  // omitting it when reconstructing this CPU-only material eligibility record.
  for(const key of ['map','alphaMap','displacementMap'])if(materialDefinition[key])throw Error(`Terrain ${definition.id} has unsupported ${key}`);
  if(materialDefinition.clippingPlanes?.length)throw Error('Terrain clipping requires a dedicated proof');
  const mesh=new THREE.Mesh(geometry,material);mesh.name=item.batch.name;
  mesh.matrix.fromArray(item.batch.modelMatrix);mesh.matrixAutoUpdate=false;mesh.updateMatrixWorld(true);
  mesh.userData={streamBatchId:item.batch.id,streamChunkId:item.chunkId};
  return {mesh,evidence:item};
});

// This height field is used ONLY to reproduce Game.visitBiome's aircraft/camera
// position. Occlusion coverage comes exclusively from the four buffers above.
const world=new FourBiomeWorld(readJSON('public/environments/world-manifest.json'),readJSON('public/environments/terrain.json'));
const report={complete:false,timestamp:new Date().toISOString(),scope:'CPU conservative original-terrain occlusion feasibility; no browser or GPU measurement, no production integration',
  candidateScope:'Whole stream-batch world AABBs after frustum rejection; weighted triangles are an upper bound before existing per-instance selection, not submitted frame triangles.',
  cameraScope:'Same Game.visitBiome + setFlightState(pitch .025) setup and PilotCamera.update(0) as benchmark-full-world.mjs; 6000m selected range, 1440x900 aspect.',
  coveragePolicy:'Every cell is wholly covered by one original opaque triangle, with expanded edges and farthest-vertex depth. Seams remain uncovered; uncertain bounds stay visible.',
  terrainSources:evidence.map(item=>({geometryId:item.geometry.id,sha256:item.geometry.sha256,triangles:item.geometry.triangles,chunk:item.chunkId})),
  totalStreamBatches:batches.length,rows:[]};

for(const biomeId of biomeIds){
  const location=world.findBiome(biomeId),ground=world.sampleGroundHeight(location.x,location.z);
  const altitude=Math.max(80,location.biome.review.aircraft[1]-ground);
  const state={position:new THREE.Vector3(location.x,ground+altitude,location.z),speed:45,grounded:false,pitch:.025,
    yaw:Math.atan2(location.biome.review.target[0]-location.x,location.biome.review.target[2]-location.z)};
  const camera=new THREE.PerspectiveCamera(42,aspect,.15,16000);new PilotCamera(camera).update(0,state);
  const cameraAltitude=Math.max(0,camera.position.y-world.sampleGroundHeight(camera.position.x,camera.position.z));
  camera.far=landscapeVisibility(distance,cameraAltitude).cameraFar;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const candidates=batches.map(batch=>({batch,box:new THREE.Box3(new THREE.Vector3(...batch.bounds.slice(0,3)),new THREE.Vector3(...batch.bounds.slice(3)))}))
    .filter(({batch,box})=>(batch.layers&camera.layers.mask)!==0&&frustum.intersectsBox(box));
  const bounds=candidates.map(item=>item.box),candidateTriangles=candidates.reduce((sum,item)=>sum+item.batch.triangles,0);
  for(const [width,height] of [[160,90],[320,180]]){
    const occlusion=new ConservativeTerrainOcclusion({width,height}),result=new Uint8Array(bounds.length),timings=[];
    for(let sample=0;sample<6;sample++){
      const started=performance.now();occlusion.build(camera,terrainSources,1);const built=performance.now();
      occlusion.testBoxes(bounds,camera,1,result);const queried=performance.now();
      if(sample>0)timings.push({buildMs:built-started,queryMs:queried-built,totalMs:queried-started});
    }
    const rejected=candidates.filter((_,index)=>result[index]===1),rejectedTriangles=rejected.reduce((sum,item)=>sum+item.batch.triangles,0);
    const median=key=>timings.map(item=>item[key]).sort((a,b)=>a-b)[Math.floor(timings.length/2)];
    const row={biomeId,resolution:[width,height],camera:{matrixWorld:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray(),
      position:camera.position.toArray(),fov:camera.fov,near:camera.near,far:camera.far},candidateBatches:candidates.length,candidateWeightedTriangles:candidateTriangles,
      occludedBatches:rejected.length,occludedWeightedTriangles:rejectedTriangles,rejectedWeightedTriangleFraction:rejectedTriangles/candidateTriangles,
      statistics:{...occlusion.statistics},median:{buildMs:median('buildMs'),queryMs:median('queryMs'),totalMs:median('totalMs')},timings,
      topRejected:rejected.sort((a,b)=>b.batch.triangles-a.batch.triangles).slice(0,12).map(({batch})=>({id:batch.id,name:batch.name,triangles:batch.triangles}))};
    report.rows.push(row);console.log(JSON.stringify({biomeId,resolution:row.resolution,candidates:candidates.length,rejected:rejected.length,
      rejectedWeightedTriangleFraction:row.rejectedWeightedTriangleFraction,coverageFraction:row.statistics.coverageFraction,median:row.median}));
  }
}
report.complete=true;fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(`Saved ${output}`);
