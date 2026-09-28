import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FourBiomeWorld } from '../src/world/FourBiomeWorld.ts';

const manifest=JSON.parse(await readFile(new URL('../public/environments/world-manifest.json',import.meta.url),'utf8'));
const terrain=JSON.parse(await readFile(new URL('../public/environments/terrain.json',import.meta.url),'utf8'));
const biomeIds=['verdant-airfield','azure-port','alpine-lake','sunstone-oasis'];
const makeWorld=()=>new FourBiomeWorld(manifest,terrain);

test('the rebuilt world contains exactly four reachable authored regions',()=>{
  const world=makeWorld();
  try{
    assert.deepEqual(world.biomeDefinitions.map(b=>b.id),biomeIds);
    assert.equal(world.getBiomeAt(0,0).id,'verdant-airfield');
    for(const biome of manifest.biomes){
      assert.equal(world.getBiomeAt(biome.center.x,biome.center.z).id,biome.id);
      const location=world.findBiome(biome.id);
      assert.equal(world.getBiomeAt(location.x,location.z).id,biome.id);
      assert.ok(biome.landmark.length>5);
      for(const vector of Object.values(biome.review))assert.ok(vector.every(Number.isFinite));
    }
    assert.throws(()=>world.findBiome('sunlit-meadow'),/Unknown biome/);
  }finally{world.dispose();}
});

test('the rebuilt airfield preserves exact runway contact and its clear cinematic ground corridor',()=>{
  const world=makeWorld();
  try{
    for(const x of [-12,-1.76,0,1.76,12])for(let z=-180;z<=180;z+=3.5)
      assert.equal(world.sampleGroundHeight(x,z),0);
    for(const [x,z] of [[20,-112],[-390,-390],[390,390],[240,185],[-55,-270]])
      assert.ok(Math.abs(world.sampleGroundHeight(x,z)+.245)<1e-6,`${x},${z}`);
    assert.equal(world.sampleGroundHeight(3000,0),manifest.waterLevel);
  }finally{world.dispose();}
});

test('terrain sampling uses exported Float32 vertices and the authored triangle diagonal',()=>{
  const world=makeWorld(),{minX,minZ,cellSize,columns,rows,heights}=terrain;
  try{
    for(let iz=0;iz<rows-1;iz+=17)for(let ix=0;ix<columns-1;ix+=19){
      for(const [tx,tz] of [[.2,.3],[.8,.7]]){
        const x=minX+(ix+tx)*cellSize,z=minZ+(iz+tz)*cellSize;
        if(Math.abs(x)<=12&&Math.abs(z)<=180)continue;
        const i=iz*columns+ix,a=Math.fround(heights[i]),d=Math.fround(heights[i+1]),b=Math.fround(heights[i+columns]),c=Math.fround(heights[i+columns+1]);
        const expected=tx+tz<=1?a+(d-a)*tx+(b-a)*tz:c+(b-c)*(1-tx)+(d-c)*(1-tz);
        assert.ok(Math.abs(world.sampleGroundHeight(x,z)-expected)<1e-6);
      }
    }
    for(let position=-799;position<2400;position+=13.7){
      assert.ok(Math.abs(world.sampleGroundHeight(800-1e-5,position)-world.sampleGroundHeight(800+1e-5,position))<.001);
      assert.ok(Math.abs(world.sampleGroundHeight(position,800-1e-5)-world.sampleGroundHeight(position,800+1e-5))<.001);
    }
  }finally{world.dispose();}
});

test('singleton batches preserve transformed positions, split normals, color, UVs and source identity',()=>{
  const world=makeWorld(),scene=new THREE.Group(),material=new THREE.MeshStandardMaterial({vertexColors:true});
  const expectations=[];
  try{
    for(let i=0;i<2;i++){
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,2+i,0,0,0,3+i,0],3));
      geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1],3));
      geometry.setAttribute('color',new THREE.Float32BufferAttribute([.2,.3,.4,.5,.6,.7,.8,.9,1],3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1],2));
      geometry.setAttribute('uv1',new THREE.Float32BufferAttribute([.1,.1,.9,.1,.1,.9],2));
      geometry.setIndex([0,1,2]);
      const mesh=new THREE.Mesh(geometry,material);mesh.name=`Fixture-${i}`;
      mesh.position.set(1060+i*20,5,1060);mesh.rotation.set(.2,.7+i*.3,.1);mesh.scale.set(2,.7,1.4);mesh.updateMatrixWorld(true);
      mesh.userData={material_role:'fixture-stone',stableId:`REG_TEST_${i}`};
      const normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      const positions=[],normals=[];
      for(let vertex=0;vertex<3;vertex++){
        positions.push(...new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,vertex).applyMatrix4(mesh.matrixWorld).toArray().map(Math.fround));
        normals.push(...new THREE.Vector3(0,0,1).applyMatrix3(normalMatrix).normalize().toArray().map(Math.fround));
      }
      expectations.push({positions,normals,color:Array.from(geometry.attributes.color.array),uv:Array.from(geometry.attributes.uv.array),uv1:Array.from(geometry.attributes.uv1.array)});
      scene.add(mesh);
    }
    world.attachScene('verdant-airfield',scene);
    const meshes=world.root.children[0].children;
    assert.equal(meshes.length,1);const merged=meshes[0];assert.equal(merged.userData.mergedStaticComponents,true);
    const attributes=merged.geometry.attributes;
    assert.deepEqual(Array.from(attributes.position.array),expectations.flatMap(entry=>entry.positions));
    assert.deepEqual(Array.from(attributes.normal.array),expectations.flatMap(entry=>entry.normals));
    for(const name of ['color','uv','uv1'])assert.deepEqual(Array.from(attributes[name].array),expectations.flatMap(entry=>entry[name]));
    assert.deepEqual(Array.from(merged.geometry.index.array),[0,1,2,3,4,5]);
    assert.deepEqual(merged.userData.sourceObjects.map(source=>source.stableId),['REG_TEST_0','REG_TEST_1']);
    assert.deepEqual(merged.userData.sourceObjects.map(source=>source.triangleOffset),[0,1]);
    assert.ok(merged.userData.sourceObjects.every(source=>source.material_role==='fixture-stone'&&source.sourceMatrix.length===16));
    assert.equal(world.diagnostics.sourceTriangles,2);assert.equal(world.diagnostics.renderedTriangles,2);
    assert.equal(world.diagnostics.geometries,1,'Only the transferred merged geometry should remain owned.');
    assert.equal(world.diagnostics.releasedSourceGeometries,2,'Replaced source buffers should be released.');
  }finally{world.dispose();}
});

test('coinstanced source components keep their matrices, geometry ranges and provenance after transfer',()=>{
  const world=makeWorld(),scene=new THREE.Group(),material=new THREE.MeshStandardMaterial();
  const geometries=[new THREE.BoxGeometry(2,3,4),new THREE.BoxGeometry(1,2,1)];
  geometries[1].translate(5,0,0);
  try{
    for(let part=0;part<2;part++)for(let instance=0;instance<2;instance++){
      const mesh=new THREE.Mesh(geometries[part],material);mesh.name=`part-${part}/instance-${instance}`;
      mesh.position.set(1060+instance*15,7,1060);mesh.rotation.set(.2,.7,.1);mesh.scale.set(2,.7,1.4);
      mesh.userData={stableId:`REG_PART_${part}_${instance}`,material_role:'crafted-stone',nested:{part,instance}};
      scene.add(mesh);
    }
    const expected=scene.children.map(mesh=>{mesh.updateMatrixWorld(true);return{name:mesh.name,matrix:mesh.matrixWorld.clone(),metadata:{...mesh.userData}};});
    // BoxGeometry's default material groups are irrelevant when one material
    // covers the whole box. Use explicit ungrouped source primitives like GLTF.
    geometries.forEach(geometry=>geometry.clearGroups());
    world.attachScene('verdant-airfield',scene);
    const [merged]=world.root.children[0].children;
    assert.equal(world.root.children[0].children.length,1);assert.ok(merged.isInstancedMesh);assert.equal(merged.count,2);
    assert.equal(merged.userData.coinstancedStaticComponents,true);
    assert.equal(merged.userData.sourceGeometryRanges.length,2);assert.equal(merged.userData.sourceObjects.length,4);
    for(let part=0;part<2;part++){
      const range=merged.userData.sourceGeometryRanges[part];
      assert.equal(range.sourceObjectOffset,part*2);assert.equal(range.sourceObjectCount,2);
      assert.equal(range.vertexOffset,part*24);assert.equal(range.vertexCount,24);
      assert.equal(range.indexOffset,part*36);assert.equal(range.indexCount,36);
      assert.equal(range.triangleOffset,part*12);assert.equal(range.triangleCount,12);
      for(let instance=0;instance<2;instance++){
        const source=merged.userData.sourceObjects[range.sourceObjectOffset+instance],original=expected[part*2+instance];
        assert.deepEqual(source,{name:original.name,...original.metadata,instanceIndex:instance});
        const matrix=new THREE.Matrix4();merged.getMatrixAt(instance,matrix);
        assert.deepEqual(matrix.elements,original.matrix.elements.map(Math.fround));
        for(let vertex=0;vertex<24;vertex++){
          const sourcePosition=new THREE.Vector3().fromBufferAttribute(geometries[part].attributes.position,vertex);
          const targetPosition=new THREE.Vector3().fromBufferAttribute(merged.geometry.attributes.position,range.vertexOffset+vertex);
          assert.deepEqual(targetPosition.toArray(),sourcePosition.toArray());
        }
      }
    }
    assert.equal(world.diagnostics.sourceObjects,4);assert.equal(world.diagnostics.sourceTriangles,48);
    assert.equal(world.diagnostics.renderedTriangles,48);assert.equal(world.diagnostics.geometries,1);
    assert.equal(world.diagnostics.releasedSourceGeometries,2);
  }finally{world.dispose();}
});

test('full-detail GLBs preserve their source triangles, ground contact, and resources across biome visits',async()=>{
  const world=makeWorld(),loader=new GLTFLoader();
  const loadingStarted=performance.now();
  // This Node test checks geometry and ownership. Pixel decoding and material
  // appearance are verified by the real browser with the exported images.
  loader.register(()=>({name:'NodeGeometryTextureFixture',loadTexture:async()=>new THREE.Texture()}));
  const ray=new THREE.Raycaster(),origin=new THREE.Vector3(),down=new THREE.Vector3(0,-1,0);
  try{
    for(const biome of manifest.biomes){
      const bytes=await readFile(new URL(`../public${biome.url}`,import.meta.url));
      const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
      assert.equal(gltf.animations.length,0,'The authored environments are static.');
      world.attachScene(biome.id,gltf.scene);
    }
    const initial=world.diagnostics;
    if(process.env.WORLD_TRANSFER_REPORT){
      const {resourceIdentities,...summary}=initial;
      await writeFile(process.env.WORLD_TRANSFER_REPORT,JSON.stringify({...summary,fixtureLoadMs:performance.now()-loadingStarted},null,2));
    }
    assert.equal(initial.loadedBiomes,4);assert.equal(initial.ready,true);
    assert.equal(initial.trianglePreservation,true);
    assert.ok(initial.sourceTriangles>0);assert.equal(initial.sourceTriangles,initial.renderedTriangles);
    assert.ok(initial.renderBatches<initial.sourceObjects,'Repeated components should share static batches.');
    let representedSources=0;
    world.root.traverse(object=>{if(object.isMesh)representedSources+=object.userData.sourceObjects.length;});
    assert.equal(representedSources,initial.sourceObjects,'Every original primitive keeps its own provenance record.');
    for(const biome of manifest.biomes){
      const transfer=initial.biomeTransfers.find(entry=>entry.id===biome.id);
      assert.ok(transfer.sourceObjects>0);assert.ok(transfer.sourceTriangles>0);
      assert.equal(transfer.sourceTriangles,transfer.renderedTriangles);
      if(biome.source.triangles>0)assert.equal(transfer.sourceTriangles,biome.source.triangles,biome.id);
    }
    const groundMeshes=[];
    world.root.traverse(object=>{
      if(object.isMesh&&object.geometry.attributes.position.count>=25000){
        object.geometry.computeBoundingBox();const size=object.geometry.boundingBox.getSize(new THREE.Vector3());
        if(size.x>1500&&size.z>1500)groundMeshes.push(object);
      }
    });
    assert.equal(groundMeshes.length,4,'Every region exports its own full terrain mesh.');
    world.root.updateMatrixWorld(true);
    for(const biome of manifest.biomes)for(let i=0;i<16;i++){
      const x=biome.bounds.minX+35+(i*137.31)%1520,z=biome.bounds.minZ+27+(i*273.77)%1520;
      if(Math.abs(x)<=12&&Math.abs(z)<=180)continue;
      origin.set(x,3000,z);ray.set(origin,down);
      const hit=ray.intersectObjects(groundMeshes,false)[0];assert.ok(hit,`${biome.id} terrain at ${x},${z}`);
      assert.ok(Math.abs(hit.point.y-world.sampleGroundHeight(x,z))<.0001,`${biome.id}: rendered ground differs from flight contact.`);
    }
    for(let i=0;i<100;i++){
      const location=world.findBiome(biomeIds[i%4]);world.update(location.x,location.z);
    }
    assert.deepEqual(world.diagnostics.resourceIdentities,initial.resourceIdentities);
    assert.equal(world.diagnostics.renderedTriangles,initial.renderedTriangles);
    const resources=new Set(),counts=new Map();
    world.root.traverse(object=>{if(object.isMesh){resources.add(object.geometry);for(const material of Array.isArray(object.material)?object.material:[object.material])resources.add(material);}});
    for(const resource of resources){counts.set(resource,0);resource.addEventListener('dispose',()=>counts.set(resource,counts.get(resource)+1));}
    world.dispose();world.dispose();
    assert.equal(world.root.children.length,0);assert.equal(world.diagnostics.disposed,true);
    for(const count of counts.values())assert.equal(count,1);
  }finally{world.dispose();}
});
