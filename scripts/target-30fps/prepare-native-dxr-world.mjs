// CPU-only lossless metadata adapter for the native DXR benchmark.
import fs from 'node:fs';
import crypto from 'node:crypto';
const source='public/acceleration/visibility-world';
const output='artifacts/four-horizons/target-30fps/native-dxr-world';
fs.mkdirSync(output,{recursive:true});
const manifestBytes=fs.readFileSync(`${source}/manifest.json`);
const manifest=JSON.parse(manifestBytes);
const reference=JSON.parse(fs.readFileSync('artifacts/four-horizons/target-30fps/visibility-world-scalar/report.json','utf8'));
const geometry=Buffer.alloc(16+manifest.geometries.length*24);
geometry.writeUInt32LE(manifest.geometries.length,0);geometry.writeUInt32LE(manifest.placements,4);
geometry.writeUInt32LE(manifest.uniqueVertices,8);geometry.writeUInt32LE(manifest.uniqueTriangles,12);
const rootToGeometry=new Map();
manifest.geometries.forEach((g,i)=>{
  if(g.id!==i)throw new Error('Geometry identity mismatch');
  for(const [j,value] of [g.id,g.vertexOffset,g.vertices,g.triangleOffset,g.triangles,g.blasRoot].entries())geometry.writeUInt32LE(value,16+i*24+j*4);
  rootToGeometry.set(g.blasRoot,i);
});
fs.writeFileSync(`${output}/geometry.bin`,geometry);
const instances=fs.readFileSync(`${source}/instances.bin`);
const instanceGeometry=Buffer.alloc(manifest.placements*4);
for(let i=0;i<manifest.placements;i++){
  const g=rootToGeometry.get(instances.readUInt32LE(i*64+48));
  if(g===undefined||instances.readUInt32LE(i*64+56)!==i)throw new Error(`Invalid instance ${i}`);
  instanceGeometry.writeUInt32LE(g,i*4);
}
fs.writeFileSync(`${output}/instance-geometry.bin`,instanceGeometry);
const camera=reference.inspection.cameraParams,params=Buffer.alloc(96);
for(const [i,values]of [camera.origin,camera.base,camera.dx,camera.dy].entries())values.forEach((v,c)=>params.writeFloatLE(v,i*16+c*4));
params.writeUInt32LE(reference.setup.width,64);params.writeUInt32LE(reference.setup.height,68);params.writeUInt32LE(4,76);
params.writeFloatLE(camera.near,80);params.writeFloatLE(camera.far,84);
fs.writeFileSync(`${output}/camera.bin`,params);
fs.writeFileSync(`${output}/input-evidence.json`,JSON.stringify({createdAt:new Date().toISOString(),sourceManifestSha256:crypto.createHash('sha256').update(manifestBytes).digest('hex'),inputEvidence:manifest.inputEvidence,geometries:manifest.uniqueGeometries,placements:manifest.placements,uniqueTriangles:manifest.uniqueTriangles,weightedTriangles:manifest.weightedTriangles,sourceByteSizes:manifest.buffers,camera,width:reference.setup.width,height:reference.setup.height,samples:4,indexRebase:'Native upload subtracts only each geometry vertexOffset from original u32 indices; source vertex floats unchanged.',hitAbi:'32 bytes: instance u32, globalTriangle u32, distance f32, u f32, v f32, steps u32, spare u32x2'},null,2));
console.log(JSON.stringify({output,geometries:manifest.uniqueGeometries,placements:manifest.placements,triangles:manifest.uniqueTriangles,samples:4}));
