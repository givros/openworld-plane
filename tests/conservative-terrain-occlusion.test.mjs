import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { ConservativeTerrainOcclusion, findStreamTerrainOccluders } from '../src/experiments/ConservativeTerrainOcclusion.ts';

function fixture({positions=[-40,-40,-10,40,-40,-10,0,40,-10],width=32,height=32,indices=[0,1,2]}={}){
  const camera=new THREE.PerspectiveCamera(90,1,.1,1000);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);geometry.name='REG_TESTcontinuous-terrain';
  geometry.userData={streamGeometryIds:[123],sourceSha256:'fixture-source'};
  const material=new THREE.MeshStandardMaterial({side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometry,material);mesh.name=geometry.name;
  mesh.userData={streamBatchId:456,streamChunkId:'test/global'};mesh.updateMatrixWorld(true);
  const batch={id:456,name:mesh.name,geometryId:123,materialId:0,count:1,isInstancedMesh:false,layers:1,
    userData:{sourceObjects:[{semantic_id:'REG_TEST/continuous-terrain'}]}};
  const definition={id:123,name:geometry.name,sha256:'fixture-source',index:{count:indices.length},attributes:{position:{count:positions.length/3}}};
  const evidence={chunkId:'test/global',batch,geometry:definition},source={mesh,evidence};
  const occlusion=new ConservativeTerrainOcclusion({width,height});
  return {camera,geometry,material,mesh,evidence,source,occlusion,build(revision=1){return occlusion.build(camera,[source],revision);},
    test(boxes,revision=1){return [...occlusion.testBoxes(boxes,camera,revision)];}};
}
const box=(x,y,z,r=.1)=>new THREE.Box3(new THREE.Vector3(x-r,y-r,z-r),new THREE.Vector3(x+r,y+r,z+r));

test('a complete original opaque triangle hides only sufficiently separated bounds',()=>{
  const f=fixture();const stats=f.build();
  assert.equal(stats.sources,1);assert.equal(stats.triangles,1);assert.ok(stats.coveredCells>0);
  assert.deepEqual(f.test([box(0,0,-20),box(0,0,-5),box(0,0,-10.1),box(0,0,-10)]),[1,0,0,0]);
  assert.equal(f.occlusion.statistics.occludedBounds,1);
});

test('coverage uses the entire cell and leaves triangle edges and seams visible',()=>{
  const f=fixture({positions:[-10,-10,-10,10,-10,-10,-10,10,-10,10,-10,-10,10,10,-10,-10,10,-10],indices:[0,1,2,3,4,5]});
  f.build();
  assert.deepEqual(f.test([box(-8,-8,-20),box(8,8,-20),box(0,0,-20)]),[1,1,0]);
  assert.ok(f.occlusion.statistics.coverageFraction<1);
});

test('partially covered projected bounds, viewport edges and empty cells stay visible',()=>{
  const f=fixture({positions:[-5,-5,-10,5,-5,-10,0,5,-10]});f.build();
  assert.deepEqual(f.test([box(0,-1,-20),box(0,9,-20,2),box(19,0,-20,2),box(15,0,-20)]),[1,0,0,0]);
});

test('depth is the farthest original vertex, never interpolated optimistic coverage',()=>{
  const f=fixture({positions:[-40,-40,-10,40,-40,-10,0,80,-20]});f.build();
  assert.deepEqual(f.test([box(0,0,-15),box(0,0,-25)]),[0,1]);
});

test('near/far-plane triangles and near-plane-crossing bounds are conservative',()=>{
  for(const positions of [[-40,-40,-10,40,-40,-10,0,0,-.01],[-40,-40,-10,40,-40,-10,0,4000,-1100]]){
    const f=fixture({positions});const stats=f.build();assert.equal(stats.coveredCells,0);assert.deepEqual(f.test([box(0,0,-20)]),[0]);
  }
  const f=fixture();f.build();
  assert.deepEqual(f.test([box(0,0,0,1),box(0,0,-1000,10),new THREE.Box3()]),[0,0,0]);
});

test('camera movement, projection changes and revision changes invalidate coverage',()=>{
  const f=fixture();f.build();assert.deepEqual(f.test([box(0,0,-20)]),[1]);
  assert.deepEqual(f.test([box(0,0,-20)],2),[0]);
  f.camera.position.x=1;f.camera.updateMatrixWorld(true);assert.deepEqual(f.test([box(0,0,-20)]),[0]);
  f.build();f.camera.fov=80;f.camera.updateProjectionMatrix();assert.deepEqual(f.test([box(0,0,-20)]),[0]);
});

test('source position/index versions, world transforms and reparenting invalidate coverage',()=>{
  const changes=[
    f=>{f.geometry.attributes.position.needsUpdate=true;},
    f=>{f.geometry.index.needsUpdate=true;},
    f=>{f.mesh.position.x=2;f.mesh.updateMatrixWorld(true);},
    f=>{new THREE.Group().add(f.mesh);},
    f=>{f.geometry.setIndex([0,2,1]);},
    f=>{f.mesh.visible=false;},
    f=>{f.material.opacity=.5;},
    f=>{f.material.polygonOffset=true;},
  ];
  for(const change of changes){const f=fixture();f.build();change(f);assert.deepEqual(f.test([box(0,0,-20)]),[0]);}
});

test('transparent, displaced, clipped, alpha-tested and single-sided terrain is not an occluder',()=>{
  const changes=[
    f=>{f.material.transparent=true;},f=>{f.material.alphaTest=.5;},f=>{f.material.alphaHash=true;},
    f=>{f.material.alphaToCoverage=true;},f=>{f.material.side=THREE.FrontSide;},
    f=>{f.material.displacementMap=new THREE.Texture();},f=>{f.material.alphaMap=new THREE.Texture();},
    f=>{f.material.depthWrite=false;},f=>{f.material.depthTest=false;},
    f=>{f.material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(1,0,0),0)];},
    f=>{f.material.onBeforeCompile=()=>{};},f=>{f.mesh.onBeforeRender=()=>{};},
  ];
  for(const change of changes){const f=fixture();change(f);assert.equal(f.build().sources,0);assert.deepEqual(f.test([box(0,0,-20)]),[0]);}
});

test('only explicitly audited nondeforming material hooks can be admitted',()=>{
  const f=fixture();f.material.onBeforeCompile=()=>{};
  const occlusion=new ConservativeTerrainOcclusion({isMaterialCompatible:material=>material===f.material});
  assert.equal(occlusion.build(f.camera,[f.source],1).sources,1);
  const oldHook=f.material.onBeforeCompile;f.material.onBeforeCompile=()=>{};
  assert.notEqual(oldHook,f.material.onBeforeCompile);
  assert.deepEqual([...occlusion.testBoxes([box(0,0,-20)],f.camera,1)],[0]);
});

test('identity singleton wrappers are supported; arbitrary instance transforms are not',()=>{
  const f=fixture(),mesh=new THREE.InstancedMesh(f.geometry,f.material,1);mesh.name=f.mesh.name;mesh.userData=f.mesh.userData;mesh.updateMatrixWorld(true);
  const source={mesh,evidence:f.evidence};
  assert.equal(f.occlusion.build(f.camera,[source],1).sources,1);
  mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(1,0,0));
  assert.deepEqual([...f.occlusion.testBoxes([box(0,0,-20)],f.camera,1)],[0]);
});

test('geometry provenance must match the rendered stream source',()=>{
  const f=fixture();f.geometry.userData.sourceSha256='other';assert.equal(f.build().sources,0);
  f.geometry.userData.sourceSha256='fixture-source';f.geometry.userData.streamGeometryIds=[999];assert.equal(f.build().sources,0);
});

test('actual manifest selects precisely the four authored terrain geometries',()=>{
  const manifest=JSON.parse(fs.readFileSync('public/environments/stream/manifest.json','utf8'));
  const evidence=manifest.chunks.filter(chunk=>chunk.global).flatMap(chunk=>findStreamTerrainOccluders(manifest,
    JSON.parse(fs.readFileSync(`public${chunk.url}`,'utf8'))));
  assert.deepEqual(evidence.map(item=>item.geometry.id),[0,839,1826,2529]);
  assert.ok(evidence.every(item=>item.geometry.triangles===51200));
  const forged=structuredClone(evidence[0].batch);forged.userData.sourceObjects[0].semantic_id='tree/foliage';
  assert.equal(findStreamTerrainOccluders(manifest,{global:true,id:'test',batches:[forged]}).length,0);
});

test('resolution is configurable without relaxing conservative coverage',()=>{
  for(const width of [16,64,128]){const f=fixture({width,height:width});f.build();assert.deepEqual(f.test([box(0,0,-20),box(0,0,-5)]),[1,0]);}
  assert.throws(()=>new ConservativeTerrainOcclusion({width:0}));
  assert.throws(()=>new ConservativeTerrainOcclusion({depthMargin:-1}));
});
