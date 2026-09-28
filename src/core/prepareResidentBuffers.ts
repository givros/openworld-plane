import * as THREE from 'three';

export interface ResidentBufferPreparationProgress {
  completed:number;total:number;meshes:number;textures:number;geometries:number;elapsedMs:number;
  /** Unique supplied GPU attribute storage, not RAM/VRAM telemetry or texture bytes. */
  bufferBytes:number;
  stage:'textures'|'buffers'|'gpu'|'complete';
}
export interface ResidentBufferPreparationMetrics extends ResidentBufferPreparationProgress {
  slices:number;renderCalls:number;
}
const cancelled=()=>new DOMException('Resident resource preparation was cancelled.','AbortError');
const noRender=()=>{};

function yieldPreparation(signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(cancelled());return;}
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(cancelled());};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},0);
    signal.addEventListener('abort',abort,{once:true});
  });
}

/** Upload supplied resident meshes and their textures without rasterizing them.
 * Existing instance buffers are warmed on their actual owning objects. Ordinary
 * meshes use an owned zero-count carrier sharing geometry only. Callers retain
 * resource leases until completion, and supply any additional shadow geometries
 * or already-created region proxies they want warmed. This does not prepare every
 * beauty/shadow shader variant; shader preparation has a separate lifecycle.
 */
export async function prepareResidentBuffers(
  renderer:THREE.WebGLRenderer,meshes:Iterable<THREE.Mesh>,signal:AbortSignal,
  progress?:(snapshot:ResidentBufferPreparationProgress)=>void,
):Promise<ResidentBufferPreparationMetrics> {
  const started=performance.now(),gl=renderer.getContext() as WebGL2RenderingContext;
  const check=()=>{if(signal.aborted)throw cancelled();if(gl.isContextLost())throw new Error('WebGL context was lost during resident resource preparation.');};
  check();
  const sources=[...new Set(meshes)],materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
  const geometries=new Set<THREE.BufferGeometry>();
  const buffers=new Set<THREE.BufferAttribute|THREE.InterleavedBuffer>();
  const collectBuffer=(attribute:THREE.BufferAttribute|THREE.InterleavedBufferAttribute|null)=>{
    if(attribute)buffers.add(attribute instanceof THREE.InterleavedBufferAttribute?attribute.data:attribute);
  };
  for(const source of sources){
    if(!(source instanceof THREE.Mesh)||source instanceof THREE.SkinnedMesh)throw new Error('Resident buffer preparation requires static meshes.');
    geometries.add(source.geometry);
    collectBuffer(source.geometry.index);
    for(const attribute of Object.values(source.geometry.attributes))collectBuffer(attribute);
    if(source instanceof THREE.InstancedMesh){collectBuffer(source.instanceMatrix);collectBuffer(source.instanceColor);}
    for(const material of Array.isArray(source.material)?source.material:[source.material])if(material)materials.add(material);
    if(source.customDepthMaterial)materials.add(source.customDepthMaterial);
    if(source.customDistanceMaterial)materials.add(source.customDistanceMaterial);
  }
  const collectTexture=(value:unknown):void=>{
    if(value instanceof THREE.Texture){if(!value.isRenderTargetTexture)textures.add(value);}
    else if(Array.isArray(value))for(const item of value)collectTexture(item);
  };
  for(const material of materials){
    for(const value of Object.values(material))collectTexture(value);
    if(material instanceof THREE.ShaderMaterial)for(const uniform of Object.values(material.uniforms))collectTexture(uniform.value);
  }
  let bufferBytes=0;for(const buffer of buffers)bufferBytes+=buffer.array.byteLength;
  const metrics:ResidentBufferPreparationMetrics={completed:0,total:sources.length+textures.size,meshes:0,textures:0,geometries:geometries.size,bufferBytes,elapsedMs:0,stage:'textures',slices:0,renderCalls:0};
  const publish=()=>{metrics.elapsedMs=performance.now()-started;progress?.({...metrics});check();};
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);
  scene.matrixAutoUpdate=false;scene.matrixWorldAutoUpdate=false;
  camera.matrixAutoUpdate=false;camera.matrixWorldAutoUpdate=false;camera.updateMatrixWorld();camera.layers.enableAll();
  const material=new THREE.MeshBasicMaterial();
  const emptyGeometry=new THREE.BufferGeometry(),carrier=new THREE.InstancedMesh(emptyGeometry,material,1);carrier.count=0;
  let sliceStart=performance.now(),sliceItems=0;
  const yieldIfNeeded=async()=>{
    if(++sliceItems>=16||performance.now()-sliceStart>=6){
      metrics.slices++;publish();await yieldPreparation(signal);check();sliceItems=0;sliceStart=performance.now();
    }
  };
  const warm=(source:THREE.Mesh)=>{
    check();
    const object=source instanceof THREE.InstancedMesh?source:carrier,geometry=source.geometry;
    const available=geometry.index?.count??geometry.getAttribute('position')?.count??0;
    if(Math.min(geometry.drawRange.start+geometry.drawRange.count,available)<Math.max(0,geometry.drawRange.start))
      throw new Error('Resident geometry has a draw range that prevents index preparation.');
    const prior={geometry:object.geometry,material:object.material,count:object.count,visible:object.visible,frustum:object.frustumCulled,
      layers:object.layers.mask,children:object.children,before:object.onBeforeRender,after:object.onAfterRender,
      modelView:object.modelViewMatrix.clone(),normal:object.normalMatrix.clone()};
    const target=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),level=renderer.getActiveMipmapLevel();
    const viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest();
    const autoClear=renderer.autoClear,sort=renderer.sortObjects,xr=renderer.xr.enabled,shadowRender=renderer.shadowMap.render,autoReset=renderer.info.autoReset;
    const counts={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,points:renderer.info.render.points,lines:renderer.info.render.lines};
    try{
      object.geometry=geometry;object.material=material;object.count=0;object.visible=true;object.frustumCulled=false;object.layers.enableAll();
      object.children=[];object.onBeforeRender=noRender;object.onAfterRender=noRender;
      // Direct references preserve each real parent and sibling sequence.
      scene.children=[object];renderer.autoClear=false;renderer.sortObjects=false;renderer.xr.enabled=false;
      renderer.shadowMap.render=noRender;renderer.info.autoReset=false;
      renderer.render(scene,camera);metrics.renderCalls++;check();
    }finally{
      scene.children=[];object.geometry=prior.geometry;object.material=prior.material;object.count=prior.count;
      object.visible=prior.visible;object.frustumCulled=prior.frustum;object.layers.mask=prior.layers;object.children=prior.children;
      object.onBeforeRender=prior.before;object.onAfterRender=prior.after;object.modelViewMatrix.copy(prior.modelView);object.normalMatrix.copy(prior.normal);
      renderer.autoClear=autoClear;renderer.sortObjects=sort;renderer.xr.enabled=xr;renderer.shadowMap.render=shadowRender;renderer.info.autoReset=autoReset;
      Object.assign(renderer.info.render,counts); // Never rewind the upload frame token.
      renderer.setRenderTarget(target,face,level);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);
    }
  };
  let fence:WebGLSync|null=null;
  try{
    publish();
    for(const texture of textures){check();renderer.initTexture(texture);check();metrics.textures++;metrics.completed++;await yieldIfNeeded();}
    metrics.stage='buffers';
    for(const source of sources){warm(source);metrics.meshes++;metrics.completed++;await yieldIfNeeded();}
    metrics.stage='gpu';publish();
    // Wait for queued transfers without blocking the main thread with finish().
    fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    if(!fence)throw new Error('Could not create the resident upload completion fence.');
    gl.flush();
    while(true){
      check();const status=gl.clientWaitSync(fence,0,0);
      if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;
      if(status===gl.WAIT_FAILED)throw new Error('Resident upload completion wait failed.');
      metrics.slices++;await yieldPreparation(signal);
    }
    check();metrics.stage='complete';publish();return{...metrics};
  }finally{
    if(fence)gl.deleteSync(fence);
    scene.children=[];carrier.dispose();emptyGeometry.dispose();material.dispose();
    sources.length=0;materials.clear();textures.clear();geometries.clear();buffers.clear();
  }
}
