import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {ScrollingShadowCache,planShadowDepthScroll,unionShadowCacheRegions} from '../src/experiments/ScrollingShadowCache.ts';

test('scroll plans preserve exact world texels and update the disjoint exposed area',()=>{
  for(let width=1;width<=7;width++)for(let height=1;height<=5;height++)for(let dx=-width-1;dx<=width+1;dx++)for(let dy=-height-1;dy<=height+1;dy++){
    const plan=planShadowDepthScroll(width,height,dx,dy),coverage=new Uint8Array(width*height);
    if(plan.overlap){const{source,destination}=plan.overlap;
      for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
        assert.equal(source.x+x,destination.x+x+dx);assert.equal(source.y+y,destination.y+y+dy);
        coverage[(destination.y+y)*width+destination.x+x]++;
      }
    }
    let changed=0;
    for(const rect of plan.updates)for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++){
      assert.ok(x>=0&&x<width&&y>=0&&y<height);coverage[y*width+x]++;changed++;
    }
    assert.ok(coverage.every(value=>value===1),`coverage ${width}x${height}, shift${dx},${dy}`);
    assert.equal(changed,plan.updatedTexels);assert.equal(plan.reusedTexels+changed,width*height);
  }
  assert.throws(()=>planShadowDepthScroll(0,2,0,0));assert.throws(()=>planShadowDepthScroll(4,4,.5,0));
});

function fixture({initialized=true,nativeAllocated=true}={}){
  const properties=new WeakMap(),buffers=new WeakMap(),targets=[],calls=[];
  const gl={READ_FRAMEBUFFER:1,DRAW_FRAMEBUFFER:2,READ_FRAMEBUFFER_BINDING:3,DRAW_FRAMEBUFFER_BINDING:4,SCISSOR_TEST:5,DEPTH_BUFFER_BIT:6,NEAREST:7};
  let current=null,read=null,draw=null,scissor=false;
  const state={
    setScissorTest:value=>{scissor=value;},
    bindFramebuffer(kind,value){if(kind===gl.READ_FRAMEBUFFER)read=value;else if(kind===gl.DRAW_FRAMEBUFFER)draw=value;else throw new Error('Unexpected framebuffer binding');},
  };
  gl.getParameter=kind=>kind===gl.READ_FRAMEBUFFER_BINDING?read:kind===gl.DRAW_FRAMEBUFFER_BINDING?draw:undefined;
  gl.isEnabled=kind=>{assert.equal(kind,gl.SCISSOR_TEST);return scissor;};
  gl.blitFramebuffer=(x0,y0,x1,y1,tx0,ty0,tx1,ty1,mask,filter)=>{
    assert.equal(mask,gl.DEPTH_BUFFER_BIT);assert.equal(filter,gl.NEAREST);assert.equal(scissor,false);
    assert.equal(x1-x0,tx1-tx0);assert.equal(y1-y0,ty1-ty0);assert.notEqual(read,draw);
    calls.push({kind:'blit',source:read.target,destination:draw.target,rect:[x0,y0,x1,y1,tx0,ty0,tx1,ty1]});
    const src=buffers.get(read.target),dst=buffers.get(draw.target);
    for(let y=0;y<y1-y0;y++)for(let x=0;x<x1-x0;x++)dst[(ty0+y)*draw.target.width+tx0+x]=src[(y0+y)*read.target.width+x0+x];
  };
  const renderer={
    shadowMap:{type:THREE.PCFShadowMap,needsUpdate:false},capabilities:{maxTextureSize:8192},state,
    properties:{get:target=>properties.get(target)},
    getContext:()=>gl,getRenderTarget:()=>current,getActiveCubeFace:()=>0,getActiveMipmapLevel:()=>0,
    initRenderTarget(target){
      if(properties.has(target))return;properties.set(target,{__webglFramebuffer:{target}});
      buffers.set(target,new Float64Array(target.width*target.height).fill(NaN));targets.push(target);
    },
    setRenderTarget(target){current=target;const framebuffer=target?properties.get(target).__webglFramebuffer:null;read=draw=framebuffer;scissor=target?.scissorTest??false;},
    clear(color=true,depth=true,stencil=true){
      calls.push({kind:'clear',target:current,color,depth,stencil});if(!depth||!current)return;
      const rect=scissor?{x:current.scissor.x,y:current.scissor.y,width:current.scissor.z,height:current.scissor.w}:{x:0,y:0,width:current.width,height:current.height};
      const array=buffers.get(current);for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++)array[y*current.width+x]=Infinity;
    },
  };
  const light=new THREE.DirectionalLight(),camera=light.shadow.camera;
  camera.left=0;camera.right=4;camera.bottom=0;camera.top=4;camera.near=1;camera.far=100;
  camera.updateProjectionMatrix();camera.updateMatrixWorld();light.shadow.mapSize.set(4,4);
  const native=new THREE.WebGLRenderTarget(4,4,{depthBuffer:true,stencilBuffer:false});native.depthTexture=new THREE.DepthTexture(4,4,THREE.UnsignedIntType);
  if(nativeAllocated)renderer.initRenderTarget(native);light.shadow.map=initialized?native:null;
  const cache=new ScrollingShadowCache(renderer),events=[];
  let dynamic=[1,1],throwStatic=false;
  const casters=new Map();
  const staticAt=(x,y)=>casters.get(`${camera.position.x+x},${camera.position.y+y}`)??1000+(camera.position.y+y)*20+camera.position.x+x;
  const fillStatic=rect=>{
    const target=light.shadow.map,array=buffers.get(target);
    for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++)array[y*target.width+x]=Math.min(array[y*target.width+x],staticAt(x,y));
  };
  const fillDynamic=()=>{buffers.get(light.shadow.map)[dynamic[1]*4+dynamic[0]]=-100;};
  const nativeDraw=action=>{
    const previous=renderer.getRenderTarget();renderer.setRenderTarget(light.shadow.map);renderer.clear();action();
    renderer.setRenderTarget(previous);renderer.shadowMap.needsUpdate=false;light.shadow.needsUpdate=false;
  };
  const callbacks={
    drawStatic(rect){events.push({kind:'static',rect});nativeDraw(()=>{if(throwStatic)throw new Error('Static draw failed');fillStatic(rect);});},
    drawDynamic(){events.push({kind:'dynamic'});nativeDraw(fillDynamic);},
    drawAll(){events.push({kind:'all'});if(!light.shadow.map)light.shadow.map=native;native.scissorTest=false;nativeDraw(()=>{fillStatic({x:0,y:0,width:4,height:4});fillDynamic();});},
  };
  const expected=()=>Float64Array.from({length:16},(_,i)=>i===dynamic[1]*4+dynamic[0]?-100:staticAt(i%4,Math.floor(i/4)));
  return{renderer,light,camera,native,cache,callbacks,events,calls,targets,buffers,expected,
    releaseNativeFramebuffer(){properties.delete(native);buffers.delete(native);},
    move(x,y,z=0){camera.position.set(x,y,z);camera.updateMatrixWorld();},
    dynamic(x,y){dynamic=[x,y];},throwStatic(value){throwStatic=value;},
    caster(x,y,depth){const key=`${x},${y}`;if(depth===undefined)casters.delete(key);else casters.set(key,depth);},
    close(){cache.dispose();native.dispose();native.depthTexture.dispose();},
  };
}

test('cache copies exact static depth through positive/negative scrolling and combines a moving dynamic caster',()=>{
  const f=fixture();try{
    const clear=f.renderer.clear;
    const first=f.cache.render(f.light,1,f.callbacks);assert.equal(first.reason,'initial');assert.equal(first.staticDraws,1);
    assert.deepEqual(f.buffers.get(f.native),f.expected());assert.equal(f.light.shadow.map,f.native);assert.equal(f.renderer.getRenderTarget(),null);
    assert.equal(f.renderer.clear,clear);assert.equal(f.cache.allocatedBytes,4*4*8*2);
    f.dynamic(2,2);const steady=f.cache.render(f.light,1,f.callbacks);
    assert.equal(steady.staticDraws,0);assert.equal(steady.reusedTexels,16);assert.deepEqual(f.buffers.get(f.native),f.expected(),'Old dynamic shadow must disappear; it was never in the static cache');
    for(const [x,y]of [[1,1],[-1,0],[0,-2],[0,-2],[9,2]]){
      f.move(x,y);const result=f.cache.render(f.light,1,f.callbacks);assert.equal(result.fallback,false);
      assert.deepEqual(f.buffers.get(f.native),f.expected(),`scroll ${x},${y}`);assert.equal(f.renderer.clear,clear);
    }
    const offsetBlit=f.calls.find(call=>call.kind==='blit'&&call.rect[0]===1&&call.rect[1]===1&&call.rect[2]===4&&call.rect[3]===4);
    assert.ok(offsetBlit,'Source endpoint must be offset + extent, not the extent alone');
    assert.ok(f.calls.some(call=>call.kind==='blit'&&call.rect[4]===2&&call.rect[6]===4),'Destination endpoint must also include its offset');
    const refresh=f.cache.render(f.light,2,f.callbacks);assert.equal(refresh.reason,'static-revision');assert.equal(refresh.updatedTexels,16);
  }finally{f.close();}
});

test('unsupported projection, depth, and fractional grid movement fall back instead of reusing invalid pixels',()=>{
  const f=fixture();try{
    f.cache.render(f.light,1,f.callbacks);f.move(.25,0);
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'noninteger-texel-shift');assert.deepEqual(f.buffers.get(f.native),f.expected());
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'initial');
    f.move(.25,0,2);assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'projection-or-depth-changed');
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'initial');
    f.camera.right=5;f.camera.updateProjectionMatrix();assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'projection-or-depth-changed');
    f.light.shadow.mapSize.x=8;assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'native-map-size-mismatch');
    assert.equal(f.light.shadow.map,f.native);assert.equal(f.renderer.getRenderTarget(),null);
  }finally{f.close();}
});

test('first native allocation is retained; failed static updates restore native state and redraw canonically',()=>{
  const f=fixture({initialized:false});try{
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'native-map-not-initialized');assert.equal(f.light.shadow.map,f.native);
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'initial');
    const clear=f.renderer.clear;f.move(1,0);f.throwStatic(true);
    const result=f.cache.render(f.light,1,f.callbacks);assert.equal(result.fallback,true);assert.match(result.reason,/Static draw failed/);
    assert.equal(f.renderer.clear,clear);assert.equal(f.light.shadow.map,f.native);assert.equal(f.renderer.getRenderTarget(),null);
    assert.deepEqual(f.buffers.get(f.native),f.expected());f.throwStatic(false);
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'initial');
    let disposed=0;for(const target of f.targets.filter(target=>target!==f.native))target.addEventListener('dispose',()=>disposed++);
    f.cache.dispose();assert.equal(disposed,2);assert.equal(f.cache.allocatedBytes,0);
    assert.throws(()=>f.cache.render(f.light,1,f.callbacks),/disposed/);
  }finally{f.close();}
});

test('an existing native map is allocated before its first depth copy and after framebuffer disposal',()=>{
  const f=fixture({nativeAllocated:false});try{
    assert.equal(f.buffers.has(f.native),false);
    const first=f.cache.render(f.light,1,f.callbacks);
    assert.equal(first.reason,'initial');assert.equal(first.fallback,false);
    assert.deepEqual(f.buffers.get(f.native),f.expected());
    assert.ok(!f.events.some(event=>event.kind==='all'),'An unallocated native destination must not require a redundant canonical shadow pass');
    f.native.dispose();f.releaseNativeFramebuffer();
    const restored=f.cache.render(f.light,1,f.callbacks);
    assert.equal(restored.reason,'unchanged');assert.equal(restored.fallback,false);assert.equal(restored.staticDraws,0);
    assert.deepEqual(f.buffers.get(f.native),f.expected(),'A reallocated native map receives the complete valid cached depth');
    assert.equal(f.light.shadow.map,f.native);assert.equal(f.renderer.getRenderTarget(),null);
  }finally{f.close();}
});

test('dynamic clear suppression is narrowly scoped and restored if dynamic rendering fails',()=>{
  const f=fixture();try{
    const clear=f.renderer.clear;
    f.callbacks.drawDynamic=()=>{f.renderer.setRenderTarget(f.native);f.renderer.clear();throw new Error('Dynamic draw failed');};
    const result=f.cache.render(f.light,1,f.callbacks);assert.match(result.reason,/Dynamic draw failed/);
    assert.equal(f.renderer.clear,clear);assert.equal(f.renderer.getRenderTarget(),null);assert.equal(f.light.shadow.map,f.native);
    assert.deepEqual(f.buffers.get(f.native),f.expected());
  }finally{f.close();}
});

test('shadow-type transitions rebuild each native map before any scratch target is used',()=>{
  const f=fixture(),nativeMaps=[];try{
    f.cache.render(f.light,1,f.callbacks);
    let nativeCalls=0;
    const callbacks={...f.callbacks,drawAll(){
      nativeCalls++;
      if(!f.light.shadow.map){
        const target=new THREE.WebGLRenderTarget(4,4,{depthBuffer:true,stencilBuffer:false});
        target.depthTexture=new THREE.DepthTexture(4,4,THREE.UnsignedIntType);
        f.renderer.initRenderTarget(target);f.light.shadow.map=target;nativeMaps.push(target);
      }
    }};
    f.renderer.shadowMap.type=THREE.BasicShadowMap;
    const basic=f.cache.render(f.light,1,callbacks);
    assert.equal(basic.reason,'shadow-type-changed');assert.equal(f.cache.allocatedBytes,0);
    assert.notEqual(f.light.shadow.map,f.native);assert.equal(nativeCalls,1);
    assert.equal(f.cache.render(f.light,1,callbacks).reason,'unsupported-shadow-type');
    assert.equal(nativeMaps.length,1);
    f.renderer.shadowMap.type=THREE.PCFShadowMap;
    assert.equal(f.cache.render(f.light,1,callbacks).reason,'shadow-type-changed');
    assert.equal(nativeMaps.length,2);assert.equal(f.light.shadow.map,nativeMaps[1]);
    assert.equal(f.cache.render(f.light,1,callbacks).reason,'initial');
    assert.equal(f.renderer.getRenderTarget(),null);
  }finally{f.close();for(const target of nativeMaps){target.dispose();target.depthTexture.dispose();}}
});

test('same-object native target resizing or depth format changes replace incompatible cache allocations',()=>{
  const f=fixture();try{
    f.cache.render(f.light,1,f.callbacks);const originalCacheTargets=f.targets.filter(target=>target!==f.native);
    let disposed=0;for(const target of originalCacheTargets)target.addEventListener('dispose',()=>disposed++);
    // Keep4x4 pixels to exercise type compatibility independently of allocation identity.
    f.native.depthTexture.type=THREE.FloatType;
    assert.equal(f.cache.render(f.light,1,f.callbacks).reason,'initial');assert.equal(disposed,2);
    assert.ok(f.targets.slice(-2).every(target=>target.depthTexture.type===THREE.FloatType));
    const secondTargets=f.targets.slice(-2);let secondDisposed=0;for(const target of secondTargets)target.addEventListener('dispose',()=>secondDisposed++);
    // A real renderer reallocates this native target; fake callbacks below only
    // validate allocation replacement and deliberately request a canonical fallback.
    f.native.setSize(8,8);f.light.shadow.mapSize.set(8,8);f.camera.right=8;f.camera.top=8;f.camera.updateProjectionMatrix();
    const callbacks={drawStatic(){throw new Error('Allocation test stops before rasterization');},drawDynamic(){},drawAll(){}};
    const result=f.cache.render(f.light,1,callbacks);assert.equal(result.fallback,true);assert.equal(secondDisposed,2);
    assert.ok(f.targets.slice(-2).every(target=>target.width===8&&target.height===8));
    assert.equal(f.cache.allocatedBytes,8*8*8*2);
  }finally{f.close();}
});

test('dirty rectangle union is clipped, disjoint, and does not fill holes between unrelated regions',()=>{
  const inputs=[
    [{x:0,y:0,width:2,height:2},{x:4,y:4,width:2,height:2}],
    [{x:-2,y:-1,width:5,height:4},{x:2,y:1,width:4,height:3},{x:1,y:0,width:2,height:6}],
    [{x:0,y:0,width:6,height:1},{x:0,y:5,width:6,height:1},{x:0,y:0,width:1,height:6},{x:5,y:0,width:1,height:6}],
    [{x:50,y:50,width:2,height:2},{x:2,y:2,width:0,height:1}],
  ];
  for(const input of inputs){
    const regions=unionShadowCacheRegions(6,6,input),coverage=new Uint8Array(36);
    for(const rect of regions)for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++)coverage[y*6+x]++;
    for(let y=0;y<6;y++)for(let x=0;x<6;x++){
      const dirty=input.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
      assert.equal(coverage[y*6+x],Number(dirty),`union pixel${x},${y}`);
    }
  }
  assert.throws(()=>unionShadowCacheRegions(4,4,[{x:.5,y:0,width:1,height:1}]),/integer/);
});

test('dirty add/remove regions replace old depth, combine with scrolling, and preserve all other cached texels',()=>{
  const f=fixture();try{
    f.caster(2,0,50);f.cache.render(f.light,1,f.callbacks);
    f.caster(2,0,undefined);f.caster(0,3,42);
    f.callbacks.dirtyRegions=[{x:2,y:0,width:1,height:1},{x:0,y:3,width:1,height:1}];
    const edit=f.cache.render(f.light,2,f.callbacks);
    assert.equal(edit.reason,'static-regions');assert.equal(edit.updatedTexels,2);assert.equal(edit.reusedTexels,14);
    assert.deepEqual(f.buffers.get(f.native),f.expected(),'Removed nearer depth must be cleared before redrawing a farther remaining surface');
    f.move(1,1);f.caster(0,3,undefined);f.caster(3,1,33);
    f.callbacks.dirtyRegions=[{x:-1,y:2,width:1,height:1},{x:2,y:0,width:1,height:1},{x:3,y:0,width:1,height:2}];
    const moving=f.cache.render(f.light,3,f.callbacks);
    assert.equal(moving.reason,'scroll-and-static-regions');assert.equal(moving.updatedTexels,8);
    assert.deepEqual(f.buffers.get(f.native),f.expected(),'Dirty/exposed overlap must not leave uncleared stale depth or uninitialized copied pixels');
    f.caster(3,1,undefined);f.callbacks.dirtyRegions=[{x:2,y:0,width:1,height:1},{x:2,y:0,width:1,height:1}];
    const removed=f.cache.render(f.light,4,f.callbacks);assert.equal(removed.updatedTexels,1);assert.equal(removed.staticDraws,1);
    assert.deepEqual(f.buffers.get(f.native),f.expected());
    f.caster(200,200,4);f.callbacks.dirtyRegions=[];
    const outside=f.cache.render(f.light,5,f.callbacks);assert.equal(outside.updatedTexels,0);assert.equal(outside.staticDraws,0);assert.equal(outside.reusedTexels,16);
    delete f.callbacks.dirtyRegions;
    const unknown=f.cache.render(f.light,6,f.callbacks);assert.equal(unknown.updatedTexels,16);assert.equal(unknown.reason,'static-revision');
    assert.deepEqual(f.buffers.get(f.native),f.expected());
  }finally{f.close();}
});
