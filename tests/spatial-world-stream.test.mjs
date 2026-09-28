import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpatialWorldStream, StreamFetchQueue, shadowFootprintDistance } from '../src/world/SpatialWorldStream.ts';
import { getStaticStreamSourceLease } from '../src/world/ImmutableStreamSources.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function idle(stream){for(let n=0;n<1000;n++){if(stream.stats.loadingChunks===0)return;await tick();}throw new Error('Fixture loading did not settle.');}
function fixture(){
  const bytes=new ArrayBuffer(48);new Float32Array(bytes,0,9).set([0,0,0,1,0,0,0,1,0]);new Uint32Array(bytes,36,3).set([2,0,1]);
  const geometry={id:0,name:'Original triangle',url:'/geometry.bin',bytes:48,sha256:'fixture',attributes:{position:{byteOffset:0,bytes:36,count:3,itemSize:3,arrayType:'Float32Array',normalized:false,gpuType:THREE.FloatType}},index:{byteOffset:36,bytes:12,count:3,arrayType:'Uint32Array'},bounds:[0,0,0,1,1,0],boundingSphere:{center:[.5,.5,0],radius:Math.SQRT1_2},groups:[],drawRange:{start:0,count:null},triangles:1};
  const material={id:0,type:'MeshStandardMaterial',name:'Original material',color:[.2,.3,.4],normalScale:[.5,-.5],side:THREE.DoubleSide};
  const data=new Map(),chunks=[0,350,2400].map((x,id)=>{
    const bounds=[x,0,0,x+1,1,0],name=`cell-${id}`,matrix=new THREE.Matrix4().makeTranslation(x,0,0);
    const batch={id,name:`source-${id}`,geometryId:0,materialId:0,count:1,isInstancedMesh:true,modelMatrix:new THREE.Matrix4().toArray(),renderOrder:0,layers:1,castShadow:true,receiveShadow:true,matrixOffset:0,bounds,localBounds:bounds,boundingSphere:{center:[x+.5,.5,0],radius:Math.SQRT1_2},userData:{biomeId:'fixture',sourceObjects:[{name:`original-${id}`,stableId:`REG_${id}`,instanceIndex:0}]},sourceObjects:1,triangles:1};
    data.set(`/${name}.json`,{version:1,id:name,biomeId:'fixture',global:false,bounds,matrices:{url:`/${name}.bin`,bytes:64,sha256:'matrix'},batches:[batch]});
    data.set(`/${name}.bin`,new Float32Array(matrix.toArray()).buffer);
    return{id:name,biomeId:'fixture',global:false,bounds,url:`/${name}.json`,metadataBytes:10,matrixBytes:64,batches:1,sourceObjects:1,triangles:1,placements:1,geometryIds:[0],materialIds:[0]};
  });
  const manifest={version:1,complete:true,cellSize:160,geometries:[geometry],materials:[material],textures:[],images:[],chunks,sourceObjects:3,triangles:3,placements:3};
  return{manifest,data,bytes};
}
const view=x=>({position:{x,y:0,z:0},altitude:0,baseDistance:100,viewDistance:100});

test('stream-owned sources receive static leases before registration and revoke before removal',async()=>{
  const f=fixture(),root=new THREE.Group(),registered=[];let removals=0;
  const stream=new SpatialWorldStream(f.manifest,root,{
    readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),
    onChange:({added,removed})=>{
      for(const source of added){assert.equal(getStaticStreamSourceLease(source)?.anchor,source.parent);registered.push(source);}
      for(const source of removed){assert.equal(getStaticStreamSourceLease(source),undefined);removals++;}
    },
  });
  try{
    stream.update(view(0));await stream.whenReady();await idle(stream);assert.ok(registered.length);
    stream.dispose();assert.equal(removals,registered.length);
    assert.ok(registered.every(source=>getStaticStreamSourceLease(source)===undefined));
  }finally{stream.dispose();}
});

function boxFrustum(minX,maxX){
  return new THREE.Frustum(new THREE.Plane(new THREE.Vector3(1,0,0),-minX),new THREE.Plane(new THREE.Vector3(-1,0,0),maxX),
    new THREE.Plane(new THREE.Vector3(0,1,0),10),new THREE.Plane(new THREE.Vector3(0,-1,0),30),
    new THREE.Plane(new THREE.Vector3(0,0,1),30),new THREE.Plane(new THREE.Vector3(0,0,-1),30));
}
function readinessFixture(behind=[-70,0,0,-69,1,1]){
  const f=fixture();f.manifest.chunks=f.manifest.chunks.slice(0,2);
  const bounds=[[60,0,0,61,1,1],behind];
  for(let id=0;id<2;id++){
    const definition=f.manifest.chunks[id],data=f.data.get(definition.url),batch=data.batches[0],b=bounds[id];
    definition.bounds=b;data.bounds=b;batch.bounds=b;batch.localBounds=b;
    batch.boundingSphere={center:[(b[0]+b[3])/2,(b[1]+b[4])/2,(b[2]+b[5])/2],radius:Math.hypot(b[3]-b[0],b[4]-b[1],b[5]-b[2])/2};
    f.data.set(data.matrices.url,new Float32Array(new THREE.Matrix4().makeTranslation(b[0],b[1],b[2]).toArray()).buffer);
  }
  return f;
}
function delayedReadinessStream(f){
  const root=new THREE.Group();let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const stream=new SpatialWorldStream(f.manifest,root,{readJSON:async url=>{if(url==='/cell-1.json')await pending;return f.data.get(url);},
    readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:()=>{}});
  return{stream,root,release};
}

test('an irrelevant behind-camera cell keeps preloading without blocking rendering; turning waits for it',async()=>{
  const f=readinessFixture(),{stream,root,release}=delayedReadinessStream(f);
  try{
    stream.update({...view(0),frustum:boxFrustum(10,120)});assert.equal(stream.stats.preparationBudgetMs,12);await stream.whenReady();
    assert.equal(stream.isViewReady,true);assert.equal(stream.stats.requiredChunks,1);assert.equal(stream.stats.visiblePending,0);
    assert.equal(stream.stats.preparationBudgetMs,3,'normal preparation resumes immediately when rendering can resume');
    assert.equal(stream.stats.activePending,1);assert.equal(stream.stats.preloadChunks,2);assert.equal(stream.stats.loadingChunks,1);
    assert.equal(root.children.length,1,'no partial cell is exposed');
    stream.update({...view(0),frustum:boxFrustum(-120,-10)});assert.equal(stream.isViewReady,false);
    assert.equal(stream.stats.preparationBudgetMs,12);
    assert.equal(stream.stats.visiblePending,1);const waiting=stream.whenReady();let resolved=false;void waiting.then(()=>{resolved=true;});
    await tick();assert.equal(resolved,false);release();await waiting;await idle(stream);
    assert.equal(stream.isViewReady,true);assert.equal(stream.stats.residentChunks,2);assert.equal(root.children.length,2);
    assert.equal(stream.stats.preparationBudgetMs,3);
  }finally{release();stream.dispose();}
});

test('an offscreen caster whose swept shadow reaches the view still blocks readiness',async()=>{
  const f=readinessFixture([-80,100,-110,-79,120,-109]),{stream,root,release}=delayedReadinessStream(f);
  try{
    stream.update({...view(0),frustum:boxFrustum(10,120)});const waiting=stream.whenReady();let resolved=false;void waiting.then(()=>{resolved=true;});
    await tick();await tick();assert.equal(stream.stats.requiredChunks,2);assert.equal(stream.isViewReady,false);assert.equal(resolved,false);
    assert.equal(root.children.length,1);release();await waiting;await idle(stream);assert.equal(stream.isViewReady,true);
  }finally{release();stream.dispose();}
});

test('global chunks and views without a frustum retain the full active readiness barrier',async()=>{
  for(const global of [false,true]){
    const f=readinessFixture();f.manifest.chunks[1].global=global;
    const {stream,release}=delayedReadinessStream(f);
    try{
      stream.update({...view(0),...(global?{frustum:boxFrustum(10,120)}:{})});const waiting=stream.whenReady();
      await tick();await tick();assert.equal(stream.stats.requiredChunks,2);assert.equal(stream.isViewReady,false);
      release();await waiting;await idle(stream);assert.equal(stream.isViewReady,true);
    }finally{release();stream.dispose();}
  }
});

test('irrelevant background failures do not reject readiness but do reject a turn toward the failed cell',async()=>{
  const f=readinessFixture(),stream=new SpatialWorldStream(f.manifest,new THREE.Group(),{
    readJSON:async url=>{if(url==='/cell-1.json')throw new Error('fixture background failure');return f.data.get(url);},
    readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:()=>{},
  });
  try{
    stream.update({...view(0),frustum:boxFrustum(10,120)});await stream.whenReady();await idle(stream);
    assert.equal(stream.isViewReady,true);assert.equal(stream.stats.errors.length,1);await stream.whenReady();
    stream.update({...view(0),frustum:boxFrustum(-120,-10)});assert.equal(stream.isViewReady,false);
    await assert.rejects(stream.whenReady(),/fixture background failure/);
  }finally{stream.dispose();}
});

function manyBatchesFixture(count=24){
  const f=fixture(),definition=f.manifest.chunks[0],data=f.data.get(definition.url);
  f.manifest.chunks=[definition];
  definition.batches=count;definition.sourceObjects=count;definition.triangles=count;definition.placements=count;
  data.batches=Array.from({length:count},(_,id)=>({...structuredClone(data.batches[0]),id,name:`batch-${id}`}));
  f.manifest.sourceObjects=count;f.manifest.triangles=count;f.manifest.placements=count;
  return f;
}

test('simultaneously ready chunks rotate registration slices instead of monopolizing preparation',async()=>{
  const f=fixture(),root=new THREE.Group(),order=[];f.manifest.chunks=f.manifest.chunks.slice(0,2);
  for(const definition of f.manifest.chunks){
    const data=f.data.get(definition.url);
    definition.batches=24;definition.sourceObjects=24;definition.triangles=24;definition.placements=24;
    data.batches=Array.from({length:24},(_,id)=>({...structuredClone(data.batches[0]),id,name:`${definition.id}-${id}`}));
  }
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:10000,concurrentChunks:2,readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:event=>{
    if(event.added.length){assert.equal(event.added.length,8);order.push(event.added[0].userData.streamChunkId);}
  }});
  try{
    stream.update({...view(0),viewDistance:400});await stream.whenReady();await idle(stream);
    assert.equal(order.length,6);assert.equal(new Set(order.slice(0,2)).size,2,'both ready chunks progress before the first completes');
    assert.deepEqual(order,['cell-0','cell-1','cell-0','cell-1','cell-0','cell-1']);
    assert.equal(stream.stats.preparationBudgetMs,10000,'explicit preparation budgets remain authoritative');
  }finally{stream.dispose();}
});

test('queued loads prioritize globals, camera-required cells, other active cells, then prefetch',async()=>{
  const f=readinessFixture(),first=f.manifest.chunks[0],second=f.manifest.chunks[1],order=[];
  const makeExtra=(id,x,global)=>{
    const definition={...structuredClone(first),id,url:`/${id}.json`,bounds:[x,0,0,x+1,1,1],global};
    const data={...structuredClone(f.data.get(first.url)),id};f.data.set(definition.url,data);return definition;
  };
  // A nearer behind-camera active cell would otherwise beat the required one.
  second.bounds=[-50,0,0,-49,1,1];
  f.manifest.chunks=[second,makeExtra('prefetch',200,false),first,makeExtra('global',1000,true)];
  const stream=new SpatialWorldStream(f.manifest,new THREE.Group(),{concurrentChunks:1,readJSON:async url=>{order.push(url);return f.data.get(url);},readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:()=>{}});
  try{
    stream.update({...view(0),frustum:boxFrustum(10,120)});await stream.whenReady();await idle(stream);
    assert.deepEqual(order,['/global.json','/cell-0.json','/cell-1.json','/prefetch.json']);
  }finally{stream.dispose();}
});

test('proxy registration yields in hidden slices and reveals a complete cell atomically',async()=>{
  const f=manyBatchesFixture(),root=new THREE.Group(),registered=[],events=[];let yields=0;
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:0,readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:event=>{
    events.push(event);
    if(event.added.length){
      assert.ok(event.added.length<=8);assert.equal(stream.isViewReady,false);
      for(const mesh of event.added){assert.equal(mesh.parent.visible,false);registered.push(mesh.userData.streamBatchId);}
      if(registered.length>8)assert.ok(yields>0,'the main thread gets a turn between registration slices');
      setTimeout(()=>yields++,0);
    }
    if(event.visibilityChanged){assert.equal(registered.length,24);assert.equal(root.children[0].visible,true);assert.equal(stream.isViewReady,true);}
  }});
  try{
    stream.update(view(0));await stream.whenReady();await idle(stream);
    assert.deepEqual(registered,Array.from({length:24},(_,id)=>id));
    assert.equal(events.filter(event=>event.materials.length).length,1);
    assert.equal(events.filter(event=>event.visibilityChanged).length,1);
    assert.equal(stream.stats.residentBatches,24);assert.equal(stream.stats.registrationSlices,3);
  }finally{stream.dispose();}
});

test('cancellation between registration slices unregisters partial proxies before releasing resources',async()=>{
  const f=manyBatchesFixture(),root=new THREE.Group(),added=[],removed=[];let geometryDisposed=false;
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:0,readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:event=>{
    for(const mesh of event.added){added.push(mesh);mesh.geometry.addEventListener('dispose',()=>{geometryDisposed=true;});}
    if(event.added.length)setTimeout(()=>stream.dispose(),0);
    for(const mesh of event.removed){assert.equal(geometryDisposed,false);removed.push(mesh);}
    assert.notEqual(event.visibilityChanged,true,'an incomplete cell never becomes visible');
  }});
  stream.update(view(0));await assert.rejects(stream.whenReady(),{name:'AbortError'});await idle(stream);
  assert.equal(added.length,8);assert.deepEqual(removed,added);assert.equal(root.children.length,0);
  assert.equal(stream.stats.geometryBytes,0);assert.equal(stream.stats.residentBatches,0);assert.equal(geometryDisposed,true);
});

test('owner registration failure removes every attempted partial source and rejects readiness',async()=>{
  const f=manyBatchesFixture(),root=new THREE.Group(),added=[],removed=[];
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:0,readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:event=>{
    added.push(...event.added);removed.push(...event.removed);
    if(event.added.length&&added.length===16)throw new Error('fixture proxy failure');
  }});
  try{
    stream.update(view(0));await assert.rejects(stream.whenReady(),/fixture proxy failure/);await idle(stream);
    assert.equal(added.length,16);assert.deepEqual(removed,added);assert.equal(root.children.length,0);
    assert.equal(stream.stats.geometryBytes,0);assert.equal(stream.stats.residentBatches,0);
  }finally{stream.dispose();}
});

test('chunk preparation sees all registered sources hidden and blocks readiness until completion',async()=>{
  const f=manyBatchesFixture(),root=new THREE.Group(),registered=new Set();let release,entered,preparedGroup,visibleEvents=0;
  const preparation=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:10000,
    readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),
    onChange:event=>{for(const mesh of event.added)registered.add(mesh);if(event.visibilityChanged)visibleEvents++;},
    prepareChunk:async(group,signal)=>{
      assert.equal(group.parent,root);assert.equal(group.visible,false);assert.equal(group.children.length,24);
      assert.equal(registered.size,24);for(const mesh of group.children)assert.ok(registered.has(mesh));
      assert.equal(signal.aborted,false);preparedGroup=group;entered();await preparation;
    },
  });
  try{
    stream.update(view(0));const ready=stream.whenReady();let resolved=false;void ready.then(()=>{resolved=true;});
    await started;await tick();assert.equal(resolved,false);assert.equal(stream.isViewReady,false);
    assert.equal(stream.stats.residentChunks,0);assert.equal(preparedGroup.visible,false);assert.equal(visibleEvents,0);
    release();await ready;await idle(stream);
    assert.equal(preparedGroup.visible,true);assert.equal(stream.isViewReady,true);assert.equal(visibleEvents,1);
    assert.equal(stream.stats.residentBatches,24);assert.equal(stream.stats.residentTriangles,24);
  }finally{release();stream.dispose();}
});

test('disposing or evicting during chunk preparation aborts its signal and never exposes a late completion',async()=>{
  for(const action of ['dispose','evict']){
    const f=manyBatchesFixture(),root=new THREE.Group(),added=[],removed=[];let release,entered,preparationSignal,geometryDisposed=false,visibleEvents=0;
    const preparation=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:10000,
      readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),
      onChange:event=>{
        for(const mesh of event.added){added.push(mesh);mesh.geometry.addEventListener('dispose',()=>{geometryDisposed=true;});}
        for(const mesh of event.removed){assert.equal(geometryDisposed,false,'proxy removal precedes resource disposal');removed.push(mesh);}
        if(event.visibilityChanged)visibleEvents++;
      },
      prepareChunk:async(group,signal)=>{assert.equal(group.visible,false);preparationSignal=signal;entered();await preparation;},
    });
    try{
      stream.update(view(0));const ready=stream.whenReady();void ready.catch(()=>{});await started;
      if(action==='dispose')stream.dispose();else stream.update(view(2400));
      assert.equal(preparationSignal.aborted,true);assert.equal(root.children.length,0);assert.equal(added.length,24);
      assert.deepEqual(removed,added);assert.equal(geometryDisposed,true);assert.equal(stream.stats.geometryBytes,0);
      release();await idle(stream);assert.equal(visibleEvents,0);assert.equal(stream.stats.residentChunks,0);assert.equal(root.children.length,0);
      stream.dispose();await assert.rejects(ready,{name:'AbortError'});
    }finally{release();stream.dispose();}
  }
});

test('chunk preparation failure unregisters complete proxies and rejects required readiness',async()=>{
  const f=manyBatchesFixture(),root=new THREE.Group(),added=[],removed=[];let prepared=false,visibleEvents=0;
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:10000,
    readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),
    onChange:event=>{added.push(...event.added);removed.push(...event.removed);if(event.visibilityChanged)visibleEvents++;},
    prepareChunk:async group=>{assert.equal(group.visible,false);assert.equal(added.length,24);prepared=true;throw new Error('fixture preparation failed');},
  });
  try{
    stream.update(view(0));await assert.rejects(stream.whenReady(),/fixture preparation failed/);await idle(stream);
    assert.equal(prepared,true);assert.deepEqual(removed,added);assert.equal(visibleEvents,0);assert.equal(root.children.length,0);
    assert.equal(stream.stats.geometryBytes,0);assert.equal(stream.stats.residentChunks,0);assert.equal(stream.isViewReady,false);
    assert.match(stream.stats.errors[0].message,/fixture preparation failed/);
  }finally{stream.dispose();}
});

test('streaming registers hidden complete cells, retains preload casters and actually disposes/reloads distant resources',async()=>{
  const f=fixture(),root=new THREE.Group(),events=[],geometries=new Set(),disposed=[];
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:0,readJSON:async url=>structuredClone(f.data.get(url)),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:event=>{
    for(const mesh of event.added){assert.equal(mesh.parent.visible,false);assert.equal(mesh.parent.parent,root);assert.deepEqual([...mesh.geometry.index.array],[2,0,1]);if(!geometries.has(mesh.geometry)){geometries.add(mesh.geometry);mesh.geometry.addEventListener('dispose',()=>disposed.push(mesh.geometry.uuid));}}
    for(const mesh of event.removed)assert.equal(disposed.includes(mesh.geometry.uuid),false,'proxy removal precedes geometry release');events.push(event);
  }});
  try{
    stream.update(view(0));assert.equal(stream.isViewReady,false);const waiting=stream.whenReady();assert.equal(stream.whenReady(),waiting);await waiting;await idle(stream);
    assert.equal(stream.isViewReady,true);assert.equal(stream.stats.residentChunks,2);assert.equal(stream.stats.geometries,1);
    assert.equal(root.children.find(group=>group.userData.streamChunkId==='cell-1').visible,true,'preloaded offscreen casters stay available to shadows');
    const firstIdentity=root.children[0].children[0].geometry.uuid;
    stream.update(view(2400));assert.equal(stream.isViewReady,false);await stream.whenReady();await idle(stream);
    assert.equal(stream.stats.residentChunks,1);assert.equal(stream.stats.evictions,2);assert.equal(stream.stats.geometryBytes,48);assert.equal(disposed.filter(id=>id===firstIdentity).length,1);
    const mesh=root.children[0].children[0];assert.equal(mesh.userData.streamBatchId,2);assert.equal(mesh.instanceMatrix.array[12],2400);assert.equal(mesh.userData.sourceObjects[0].stableId,'REG_2');
    assert.notEqual(mesh.geometry.uuid,firstIdentity);stream.dispose();assert.equal(root.children.length,0);assert.equal(stream.stats.geometryBytes,0);assert.equal(stream.stats.materials,0);
    assert.ok(events.some(event=>event.removed.length));
  }finally{stream.dispose();}
});

test('a missing visible resource rejects readiness and releases every attempted lease',async()=>{
  const f=fixture(),root=new THREE.Group();
  const stream=new SpatialWorldStream(f.manifest,root,{readJSON:async url=>f.data.get(url),readBinary:async url=>{if(url==='/geometry.bin')throw new Error('fixture corrupt source');return f.data.get(url);},onChange:()=>{}});
  try{stream.update(view(0));await assert.rejects(stream.whenReady(),/corrupt source/);await idle(stream);assert.equal(stream.isViewReady,false);assert.equal(stream.stats.geometryBytes,0);assert.equal(stream.stats.materials,0);assert.equal(root.children.length,0);}
  finally{stream.dispose();}
});

test('conservative sun footprint includes upstream geometry beyond beauty range without reducing geometry',()=>{
  const caster=[-200,100,-200,-190,120,-190];
  assert.equal(shadowFootprintDistance(caster,{x:-110,z:-80},-18),0);
  assert.ok(shadowFootprintDistance(caster,{x:-600,z:-600},-18)>400);
});

test('fetch queue bounds concurrency and cancels queued work without starting it',async()=>{
  const queue=new StreamFetchQueue(1),controller=new AbortController();let complete,secondStarted=false;
  const first=queue.run(()=>new Promise(resolve=>{complete=resolve;}));await tick();
  const second=queue.run(async()=>{secondStarted=true;},controller.signal);controller.abort();await assert.rejects(second,/cancelled/);assert.equal(secondStarted,false);
  complete(1);assert.equal(await first,1);assert.equal(await queue.run(async()=>2),2);
});

function fractionFixture(count=10){
  const f=fixture(),definition=f.manifest.chunks[0],prototype=f.data.get(definition.url);
  f.data=new Map();f.manifest.chunks=[];
  for(let index=0;index<count;index++){
    const x=index*1200,id=`cell-${index}`,bounds=[x,0,0,x+1,1,0];
    const chunk={...structuredClone(definition),id,url:`/${id}.json`,bounds,global:index===count-1};
    const data=structuredClone(prototype),batch=data.batches[0];
    Object.assign(data,{id,bounds,global:chunk.global});data.matrices.url=`/${id}.bin`;
    Object.assign(batch,{id:index,name:`source-${index}`,bounds,localBounds:bounds,boundingSphere:{center:[x+.5,.5,0],radius:Math.SQRT1_2}});
    f.manifest.chunks.push(chunk);f.data.set(chunk.url,data);
    f.data.set(data.matrices.url,new Float32Array(new THREE.Matrix4().makeTranslation(x,0,0).toArray()).buffer);
  }
  Object.assign(f.manifest,{sourceObjects:count,triangles:count,placements:count});
  return f;
}
function fractionStream(f,options={}){
  const root=new THREE.Group();
  const stream=new SpatialWorldStream(f.manifest,root,{commitBudgetMs:10000,
    readJSON:async url=>f.data.get(url),readBinary:async url=>(url==='/geometry.bin'?f.bytes:f.data.get(url)).slice(0),onChange:()=>{},...options});
  return{stream,root};
}

test('fraction preparation deterministically pins nearest cells and globals regardless of manifest order',async()=>{
  for(const reverse of [false,true]){
    const f=fractionFixture();
    // Equal-distance cells use stable IDs instead of manifest/arrival order.
    f.manifest.chunks[2].bounds=[...f.manifest.chunks[1].bounds];
    if(reverse)f.manifest.chunks.reverse();
    const {stream,root}=fractionStream(f);
    try{
      await stream.prepareFraction(.3,{x:0,y:0,z:0});await idle(stream);
      assert.deepEqual(root.children.map(group=>group.userData.streamChunkId).sort(),['cell-0','cell-1','cell-9']);
      assert.equal(stream.stats.preparedTargetChunks,3);assert.equal(stream.stats.preparedResidentChunks,3);
      assert.equal(stream.stats.pinnedChunks,3);assert.equal(stream.stats.preparationComplete,true);
      assert.equal(stream.isViewReady,false,'The separate preparation API does not invent a required camera view');
    }finally{stream.dispose();}
  }
});

test('70 percent preparation waits for render preparation then survives movement and can release its pins',async()=>{
  const f=fractionFixture();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const {stream,root}=fractionStream(f,{prepareChunk:async group=>{
    if(group.userData.streamChunkId==='cell-5'){assert.equal(group.visible,false);entered();await gate;}
  }});
  try{
    assert.equal(stream.stats.preparationComplete,false);assert.equal(stream.stats.pinnedChunks,0);
    stream.update(view(0));await stream.whenReady();
    const request=stream.prepareFraction(.7);assert.equal(stream.prepareFraction(.7),request);
    let finished=false;void request.then(()=>{finished=true;});
    await started;await tick();
    assert.equal(stream.isViewReady,true);await stream.whenReady();
    assert.equal(finished,false);assert.equal(stream.stats.preparationComplete,false);
    assert.equal(stream.stats.preparedTargetChunks,7);assert.equal(stream.stats.preparedResidentChunks,6);
    release();await request;await idle(stream);
    assert.equal(stream.stats.preparedResidentChunks,7);assert.equal(stream.stats.preparationComplete,true);
    const retained=new Map(root.children.map(group=>[group.userData.streamChunkId,group]));
    stream.update(view(8400));await stream.whenReady();await idle(stream);
    assert.equal(stream.stats.residentChunks,8);assert.equal(stream.stats.pinnedChunks,7);assert.equal(stream.stats.evictions,0);
    for(const [id,group] of retained)assert.equal(root.children.find(child=>child.userData.streamChunkId===id),group,'Pinned meshes and their resource leases retain their identities');
    assert.equal(stream.stats.preparationComplete,true);
    await stream.prepareFraction(0);await idle(stream);
    assert.equal(stream.stats.pinnedChunks,0);assert.equal(stream.stats.preparedTargetChunks,0);assert.equal(stream.stats.preparationComplete,true);
    assert.deepEqual(root.children.map(group=>group.userData.streamChunkId).sort(),['cell-7','cell-9']);
  }finally{release();stream.dispose();}
});

test('70 percent of a 422-cell world prepares exactly 296 complete resident cells',async()=>{
  const f=fractionFixture(422);let prepared=0;
  const {stream}=fractionStream(f,{prepareChunk:async()=>{prepared++;}});
  try{
    await stream.prepareFraction(.7,{x:0,y:0,z:0});await idle(stream);
    assert.equal(stream.stats.preparedTargetChunks,296);assert.equal(stream.stats.preparedResidentChunks,296);
    assert.equal(stream.stats.residentChunks,296);assert.equal(prepared,296);assert.equal(stream.stats.preparationComplete,true);
    assert.equal(stream.stats.residentTriangles,296);assert.equal(stream.stats.residentPlacements,296);
  }finally{stream.dispose();}
});

test('a failed pinned offscreen cell rejects preparation without blocking ready camera geometry',async()=>{
  const f=fractionFixture(),{stream}=fractionStream(f,{readJSON:async url=>{
    if(url==='/cell-2.json')throw new Error('Pinned resource unavailable');return f.data.get(url);
  }});
  try{
    stream.update(view(0));await stream.whenReady();
    await assert.rejects(stream.prepareFraction(.7),/Pinned resource unavailable/);await idle(stream);
    assert.equal(stream.isViewReady,true);await stream.whenReady();
    assert.equal(stream.stats.preparationComplete,false);assert.equal(stream.stats.preparedResidentChunks,6);
    assert.equal(stream.stats.preparedTargetChunks,7);
  }finally{stream.dispose();}
});

test('an independently aborted pinned resource rejects its barrier without an endless retry',async()=>{
  const f=fractionFixture();let attempts=0;
  const {stream}=fractionStream(f,{prepareChunk:async(group,signal)=>{
    if(group.userData.streamChunkId==='cell-9'){attempts++;assert.equal(signal.aborted,false);throw new DOMException('Preparation interrupted externally','AbortError');}
  }});
  try{
    await assert.rejects(stream.prepareFraction(.1,{x:0,y:0,z:0}),{name:'AbortError'});await idle(stream);
    assert.equal(attempts,1);assert.equal(stream.stats.preparationComplete,false);assert.equal(stream.stats.preparedResidentChunks,0);
  }finally{stream.dispose();}
});

test('disposal cancels the fraction barrier and aborts a still-hidden render preparation',async()=>{
  const f=fractionFixture();let release,entered,signal;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const {stream,root}=fractionStream(f,{prepareChunk:async(group,requestSignal)=>{
    if(group.userData.streamChunkId==='cell-9'){signal=requestSignal;entered();await gate;}
  }});
  try{
    const request=stream.prepareFraction(.7,{x:0,y:0,z:0});await started;
    stream.dispose();await assert.rejects(request,{name:'AbortError'});
    assert.equal(signal.aborted,true);assert.equal(root.children.length,0);assert.equal(stream.stats.preparationComplete,false);
    release();await idle(stream);assert.equal(root.children.length,0);assert.equal(stream.stats.geometryBytes,0);
    await assert.rejects(stream.prepareFraction(.7),{name:'AbortError'});
  }finally{release();stream.dispose();}
});

test('replacing a preparation target cancels its old barrier and validation leaves ordinary streaming untouched',async()=>{
  const f=fractionFixture();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const {stream,root}=fractionStream(f,{readJSON:async url=>{
    if(url==='/cell-0.json'){entered();await gate;}return f.data.get(url);
  }});
  try{
    for(const fraction of [-.1,1.1,NaN,Infinity])await assert.rejects(stream.prepareFraction(fraction,{x:0,y:0,z:0}),/between zero and one/);
    await assert.rejects(stream.prepareFraction(.7),/finite center/);
    await assert.rejects(stream.prepareFraction(.7,{x:NaN,y:0,z:0}),/finite center/);
    assert.equal(stream.stats.loadingChunks,0);assert.equal(stream.stats.pinnedChunks,0);
    const old=stream.prepareFraction(1,{x:0,y:0,z:0});await started;
    const next=stream.prepareFraction(.1,{x:0,y:0,z:0});await assert.rejects(old,{name:'AbortError'});
    await next;assert.equal(stream.stats.preparedTargetChunks,1);assert.equal(stream.stats.preparationComplete,true);
    release();await idle(stream);assert.deepEqual(root.children.map(group=>group.userData.streamChunkId),['cell-9']);
  }finally{release();stream.dispose();}
});
