import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PassInstanceCuller} from '../src/world/PassInstanceCuller.ts';

function box(min=-100,max=100){return new THREE.Frustum(
  new THREE.Plane(new THREE.Vector3(1,0,0),-min),new THREE.Plane(new THREE.Vector3(-1,0,0),max),
  new THREE.Plane(new THREE.Vector3(0,1,0),100),new THREE.Plane(new THREE.Vector3(0,-1,0),100),
  new THREE.Plane(new THREE.Vector3(0,0,1),100),new THREE.Plane(new THREE.Vector3(0,0,-1),100));}
function fixture(){
  const scene=new THREE.Scene(),parent=new THREE.Group(),geometry=new THREE.BoxGeometry(2,2,2),shadowGeometry=geometry.clone(),material=new THREE.MeshStandardMaterial();
  const source=new THREE.InstancedMesh(geometry,material,4);source.castShadow=true;source.position.x=10;source.layers.mask=129;
  [-30,0,30,60].forEach((x,i)=>{source.setMatrixAt(i,new THREE.Matrix4().makeTranslation(x,0,0));source.setColorAt(i,new THREE.Color().setRGB(i/4,.3,.8));});
  source.instanceMatrix.needsUpdate=true;source.instanceColor.needsUpdate=true;
  parent.add(source);scene.add(parent);scene.updateMatrixWorld(true);
  const culler=new PassInstanceCuller([source],4);scene.add(culler.beautyGroup,...culler.shadowGroups);
  const passes=Array.from({length:4},()=>({light:new THREE.DirectionalLight(),frustum:box(0,50)}));
  culler.shadowGeometryForSource=()=>shadowGeometry;culler.deferredShadowPasses=new Set([2,3]);
  const prepare=()=>{scene.updateMatrixWorld(true);culler.prepare(box(0,20),passes);culler.enable();};
  const ids=proxy=>Array.from({length:proxy.count},(_,i)=>culler.resolveProxyInstance(proxy,i).instanceId);
  return {scene,parent,geometry,shadowGeometry,material,source,culler,prepare,ids,
    close:()=>{culler.dispose();source.dispose();geometry.dispose();shadowGeometry.dispose();material.dispose();}};
}

test('resident preparation includes all exact buffers without altering live selections or sources',()=>{
  const f=fixture();
  try{
    assert.throws(()=>[...f.culler.preparationMeshes()],/Prepare the culler/);
    f.prepare();
    const full=[f.culler.beautyGroup,...f.culler.shadowGroups].map(group=>group.children[0]);
    const capture=proxy=>({count:proxy.count,visible:proxy.visible,layers:proxy.layers.mask,ids:f.ids(proxy),
      matrices:proxy.instanceMatrix.array.slice(),version:proxy.instanceMatrix.version,matrixWorld:proxy.matrixWorld.toArray(),parent:proxy.parent});
    const before=full.map(capture),sourceMatrices=f.source.instanceMatrix.array.slice(),sourceLayers=f.source.layers.mask;
    const meshes=[...f.culler.preparationMeshes()],regions=meshes.filter(mesh=>mesh.userData.shadowRegionProxy);
    assert.equal(meshes.length,7);assert.equal(regions.length,2);
    assert.deepEqual(full.map(capture),before);
    assert.equal(meshes[0].geometry,f.geometry);
    for(const mesh of meshes.slice(1))assert.equal(mesh.geometry,f.shadowGeometry);
    for(const region of regions){
      const group=f.culler.shadowGroups[region.userData.passIndex-1];
      assert.equal(region.parent,group,'Future region is attached while still hidden');
      assert.equal(group.children[group.children.indexOf(full[region.userData.passIndex])+1],region);
      assert.equal(region.visible,false);assert.equal(region.count,0);
      assert.equal(region.instanceMatrix.count,f.source.instanceMatrix.count);
      assert.notEqual(region.instanceColor,f.source.instanceColor);
      assert.deepEqual(region.instanceColor.array,f.source.instanceColor.array);
    }
    assert.deepEqual([...f.culler.preparationMeshes()],meshes,'Repeated preparation reuses all buffer owners');
    assert.equal(f.source.geometry,f.geometry);assert.equal(f.source.layers.mask,sourceLayers);assert.equal(f.source.count,4);
    assert.deepEqual(f.source.instanceMatrix.array,sourceMatrices);
    const region=regions.find(mesh=>mesh.userData.passIndex===3),instanceBuffer=region.instanceMatrix,colorBuffer=region.instanceColor;
    f.culler.withShadowRegion(2,box(35,45),()=>{
      assert.equal(region.visible,true);assert.deepEqual(f.ids(region),[2]);
      assert.equal(region.instanceMatrix,instanceBuffer);assert.equal(region.instanceColor,colorBuffer);
      assert.equal(region.geometry,f.shadowGeometry);
    });
    assert.equal(region.visible,false);
    assert.deepEqual(full.map(capture),before,'First real strip leaves ordinary draw selections unchanged');
  }finally{f.close();}
});

test('future cache passes prepare hidden buffers even when no current cascade is cacheable',()=>{
  const f=fixture();
  try{
    f.culler.deferredShadowPasses.clear();f.prepare();
    const groups=[f.culler.beautyGroup,...f.culler.shadowGroups],children=groups.map(group=>group.children);
    const full=groups.map(group=>group.children[0]),before=full.map(mesh=>({visible:mesh.visible,count:mesh.count,ids:f.ids(mesh)}));
    const statistics=structuredClone(f.culler.statistics),added=[];
    for(const group of f.culler.shadowGroups)group.addEventListener('childadded',event=>{
      assert.equal(event.child.parent,group);added.push(event.child);
    });
    assert.throws(()=>[...f.culler.preparationMeshes(new Set([4]))],/Invalid prepared shadow region pass/);
    const meshes=[...f.culler.preparationMeshes(new Set([2,3]))],regions=meshes.filter(mesh=>mesh.userData.shadowRegionProxy);
    assert.equal(meshes.length,7);assert.equal(regions.length,2);assert.deepEqual(added,regions);
    assert.deepEqual(full.map(mesh=>({visible:mesh.visible,count:mesh.count,ids:f.ids(mesh)})),before);
    assert.deepEqual(f.culler.statistics,statistics);assert.equal(f.culler.deferredShadowPasses.size,0);
    groups.forEach((group,index)=>assert.equal(group.children,children[index]));
    for(const region of regions){assert.equal(region.visible,false);assert.equal(region.count,0);}
    assert.deepEqual([...f.culler.preparationMeshes(new Set([2,3]))],meshes);
    assert.deepEqual(added,regions,'Repeated preparation emits no reparent/add events');
    f.culler.deferredShadowPasses.add(2);f.prepare();
    const region=regions[0],buffer=region.instanceMatrix;
    f.culler.withShadowRegion(2,box(35,45),()=>{
      assert.equal(region.instanceMatrix,buffer);assert.equal(region.visible,true);assert.deepEqual(f.ids(region),[2]);
    });
  }finally{f.close();}
});

test('bulk region preparation preserves sibling arrays and existing helpers without repeated sibling searches',()=>{
  const scene=new THREE.Scene(),world=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
  scene.add(world);
  const sources=Array.from({length:1000},(_,index)=>{
    const source=new THREE.InstancedMesh(geometry,material,1);source.castShadow=true;
    source.setMatrixAt(0,new THREE.Matrix4().makeTranslation(index*.1,0,0));world.add(source);return source;
  });
  const culler=new PassInstanceCuller(sources,1),light=new THREE.DirectionalLight(),passes=[{light,frustum:box()}];
  scene.add(culler.beautyGroup,...culler.shadowGroups);culler.deferredShadowPasses.add(0);
  const prepare=()=>{scene.updateMatrixWorld(true);culler.prepare(box(),passes);culler.enable();};
  try{
    prepare();const group=culler.shadowGroups[0],children=group.children,full=children.slice();
    const markers=[new THREE.Object3D(),new THREE.Object3D()];group.add(...markers);
    culler.withShadowRegion(0,box(-1,.05),()=>{});
    const existing=children.filter(mesh=>mesh.userData.shadowRegionProxy),existingAdded=[];
    assert.ok(existing.length>0&&existing.length<sources.length);
    for(const mesh of existing)mesh.addEventListener('added',()=>existingAdded.push(mesh));
    const addEvents=[];group.addEventListener('childadded',event=>{assert.equal(event.child.parent,group);addEvents.push(event.child);});
    const forbid=()=>{throw new Error('Preparation used a repeated sibling-array search or splice');};
    Object.defineProperty(children,'indexOf',{configurable:true,value:forbid});
    Object.defineProperty(children,'splice',{configurable:true,value:forbid});
    let meshes;
    try{meshes=[...culler.preparationMeshes()];}finally{delete children.indexOf;delete children.splice;}
    assert.equal(group.children,children);assert.equal(existingAdded.length,0);
    const regions=meshes.filter(mesh=>mesh.userData.shadowRegionProxy),bySource=new Map(regions.map(mesh=>[mesh.userData.canonicalSourceId,mesh]));
    assert.equal(regions.length,sources.length);assert.equal(addEvents.length,sources.length-existing.length);
    const expected=[];for(const proxy of full)expected.push(proxy,bySource.get(proxy.userData.canonicalSourceId));expected.push(...markers);
    assert.deepEqual(children,expected);
    for(const region of regions){assert.equal(region.parent,group);assert.equal(region.visible,false);}
    Object.defineProperty(children,'indexOf',{configurable:true,value:forbid});
    Object.defineProperty(children,'splice',{configurable:true,value:forbid});
    try{
      culler.withShadowRegion(0,box(98,101),()=>{
        assert.ok(regions.some(region=>region.visible));
      });
    }finally{delete children.indexOf;delete children.splice;}
    assert.equal(group.children,children);
    world.renderOrder=17;prepare();
    culler.withShadowRegion(0,box(98,101),()=>{
      for(const region of regions.filter(mesh=>mesh.visible)){
        const parent=region.parent,index=parent.children.indexOf(region);
        assert.equal(parent.renderOrder,17);assert.equal(parent.children[index-1].userData.canonicalSourceId,region.userData.canonicalSourceId);
      }
    });
    assert.equal(group.children,children,'Later live reparenting preserves the old array identity');
  }finally{culler.dispose();for(const source of sources)source.dispose();geometry.dispose();material.dispose();}
});

test('hidden-source prewarm owners are released even when their regions never drew',()=>{
  const f=fixture();let geometryDisposals=0,regionDisposals=0;
  try{
    f.parent.visible=false;f.prepare();
    f.geometry.addEventListener('dispose',()=>geometryDisposals++);f.shadowGeometry.addEventListener('dispose',()=>geometryDisposals++);
    const meshes=[...f.culler.preparationMeshes()],regions=meshes.filter(mesh=>mesh.userData.shadowRegionProxy);
    for(const mesh of meshes){assert.equal(mesh.visible,false);assert.equal(mesh.count,0);}
    for(const region of regions)region.addEventListener('dispose',()=>regionDisposals++);
    f.culler.removeSources([f.source]);
    assert.equal(regionDisposals,2);assert.equal(geometryDisposals,0);
    assert.deepEqual([...f.culler.preparationMeshes()],[]);
    for(const region of regions)assert.equal(f.culler.resolveProxyInstance(region,0),undefined);
  }finally{f.close();}
});
