import * as THREE from 'three';

export interface ResidentBindingProgress {
  completed:number;total:number;beautyBindings:number;shadowBindings:number;unsupportedShadows:number;
  slices:number;elapsedMs:number;realDraws:number;stage:'bindings'|'gpu'|'complete';
}
export interface ResidentBindingOptions {
  shadowCamera?:THREE.Camera;shadowTarget?:THREE.WebGLRenderTarget;
  /** Diagnostic native-driver warmup: submit one original instance/range with
   * zero-area scissoring. Default false only prepares bindings without a draw. */
  realDraw?:boolean;
}
const noRender=()=>{};
const cancelled=()=>new DOMException('Resident binding preparation was cancelled.','AbortError');
function yieldPreparation(signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(cancelled());return;}
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(cancelled());};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},0);
    signal.addEventListener('abort',abort,{once:true});
  });
}

/** Prepares the actual object/geometry/program VAO combinations. Requires the
 * live scene's lights and matrices to have been prepared, and exclusive ownership
 * of the renderer for each synchronous slice. Shader hooks remain the real ones.
 * Only public renderer operations are used. Default instance count is zero;
 * optional realDraw submits one instance with zero-area scissoring to exercise
 * driver draw preparation. Full original geometry ranges/storage are preserved.
 * Explicit solid custom shadow-depth materials can additionally be warmed with
 * the actual shadow camera. Native private depth-material variants are counted
 * as unsupported rather than replaced with approximate shader programs.
 */
export async function prepareResidentBindings(
  renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,
  meshes:Iterable<THREE.InstancedMesh>,signal:AbortSignal,
  progress?:(state:ResidentBindingProgress)=>void,options:ResidentBindingOptions={},
):Promise<ResidentBindingProgress>{
  const started=performance.now(),gl=renderer.getContext() as WebGL2RenderingContext;
  const check=()=>{if(signal.aborted)throw cancelled();if(gl.isContextLost())throw new Error('WebGL context was lost during resident binding preparation.');};
  check();
  const sources=[...new Set(meshes)],lights:THREE.Object3D[]=[];
  scene.traverseVisible(object=>{if(object instanceof THREE.Light)lights.push(object);});
  const shadowLight=lights.find(light=>light instanceof THREE.DirectionalLight&&light.shadow.camera===options.shadowCamera) as THREE.DirectionalLight|undefined;
  const shadowTarget=shadowLight?.shadow.map;
  const depthTarget=options.shadowTarget??(shadowTarget instanceof THREE.WebGLRenderTarget?shadowTarget:undefined);
  for(const mesh of sources)if(!(mesh instanceof THREE.InstancedMesh)||Array.isArray(mesh.material)||mesh.material.transparent||
    (mesh.material as THREE.MeshPhysicalMaterial).transmission>0)throw new Error('Resident binding preparation requires opaque single-material instanced meshes.');
  const state:ResidentBindingProgress={completed:0,total:sources.length,beautyBindings:0,shadowBindings:0,unsupportedShadows:0,slices:0,elapsedMs:0,realDraws:0,stage:'bindings'};
  const publish=()=>{state.elapsedMs=performance.now()-started;progress?.({...state});check();};

  const warm=(mesh:THREE.InstancedMesh,renderCamera:THREE.Camera,depth?:THREE.MeshDepthMaterial)=>{
    check();
    const realDraw=options.realDraw===true&&mesh.instanceMatrix.count>0&&(!mesh.instanceColor||mesh.instanceColor.count>0);
    const original={children:scene.children,background:scene.background,override:scene.overrideMaterial,
      matrix:scene.matrixWorldAutoUpdate,before:scene.onBeforeRender,after:scene.onAfterRender,
      material:mesh.material,count:mesh.count,visible:mesh.visible,frustum:mesh.frustumCulled,layers:mesh.layers.mask,
      meshChildren:mesh.children,meshBefore:mesh.onBeforeRender,meshAfter:mesh.onAfterRender,
      modelView:mesh.modelViewMatrix.clone(),normal:mesh.normalMatrix.clone(),cameraMatrix:renderCamera.matrixWorldAutoUpdate};
    const lightChildren=lights.map(light=>light.children);
    const rendererState={autoClear:renderer.autoClear,sort:renderer.sortObjects,xr:renderer.xr.enabled,
      shadow:renderer.shadowMap.render,autoReset:renderer.info.autoReset,direct:renderer.renderBufferDirect,
      target:renderer.getRenderTarget(),face:renderer.getActiveCubeFace(),level:renderer.getActiveMipmapLevel(),
      viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),
      calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,points:renderer.info.render.points,lines:renderer.info.render.lines};
    const depthState=depth?{visible:depth.visible,wireframe:depth.wireframe,side:depth.side,alphaMap:depth.alphaMap,
      alphaTest:depth.alphaTest,map:depth.map,clipShadows:depth.clipShadows,clippingPlanes:depth.clippingPlanes,
      clipIntersection:depth.clipIntersection,displacementMap:depth.displacementMap,
      displacementScale:depth.displacementScale,displacementBias:depth.displacementBias,wireframeLinewidth:depth.wireframeLinewidth}:undefined;
    try{
      scene.children=[...lights,mesh];scene.background=null;scene.matrixWorldAutoUpdate=false;
      scene.onBeforeRender=noRender;scene.onAfterRender=noRender;renderCamera.matrixWorldAutoUpdate=false;
      for(const light of lights)light.children=[];
      mesh.count=realDraw?1:0;mesh.visible=true;mesh.frustumCulled=false;mesh.layers.enableAll();mesh.children=[];
      mesh.onBeforeRender=noRender;mesh.onAfterRender=noRender;
      renderer.autoClear=false;renderer.sortObjects=false;renderer.xr.enabled=false;
      renderer.shadowMap.render=noRender;renderer.info.autoReset=false;
      if(depth){
        const surface=original.material as THREE.MeshStandardMaterial;
        depth.visible=surface.visible;depth.wireframe=surface.wireframe;
        depth.side=surface.shadowSide??(renderer.shadowMap.type===THREE.VSMShadowMap?surface.side:
          surface.side===THREE.FrontSide?THREE.BackSide:surface.side===THREE.BackSide?THREE.FrontSide:THREE.DoubleSide);
        depth.alphaMap=surface.alphaMap;depth.alphaTest=surface.alphaToCoverage ? .5 : surface.alphaTest;depth.map=surface.map;
        depth.clipShadows=surface.clipShadows;depth.clippingPlanes=surface.clippingPlanes;depth.clipIntersection=surface.clipIntersection;
        depth.displacementMap=surface.displacementMap;depth.displacementScale=surface.displacementScale;depth.displacementBias=surface.displacementBias;
        depth.wireframeLinewidth=surface.wireframeLinewidth;
        mesh.material=depth;scene.overrideMaterial=null;
        renderer.setRenderTarget(depthTarget!);
      }
      if(depth||realDraw){
        renderer.renderBufferDirect=(cam,drawScene,geometry,material,object,group)=>{
          // Reassert after any renderer target transition; no framebuffer sample
          // can be written, while the original program/range still reaches draw.
          if(realDraw){renderer.setScissor(0,0,0,0);renderer.setScissorTest(true);}
          // Native shadows use null here; r184 accepts it despite its typings.
          return rendererState.direct.call(renderer,cam,depth?null as unknown as THREE.Scene:drawScene,geometry,material,object,group);
        };
      }
      if(realDraw){renderer.setScissor(0,0,0,0);renderer.setScissorTest(true);}
      renderer.render(scene,renderCamera);check();if(realDraw)state.realDraws++;
    }finally{
      scene.children=original.children;scene.background=original.background;scene.overrideMaterial=original.override;
      scene.matrixWorldAutoUpdate=original.matrix;scene.onBeforeRender=original.before;scene.onAfterRender=original.after;
      lights.forEach((light,i)=>light.children=lightChildren[i]);
      renderCamera.matrixWorldAutoUpdate=original.cameraMatrix;
      mesh.material=original.material;mesh.count=original.count;mesh.visible=original.visible;mesh.frustumCulled=original.frustum;
      mesh.layers.mask=original.layers;mesh.children=original.meshChildren;mesh.onBeforeRender=original.meshBefore;mesh.onAfterRender=original.meshAfter;
      mesh.modelViewMatrix.copy(original.modelView);mesh.normalMatrix.copy(original.normal);
      if(depth&&depthState)Object.assign(depth,depthState);
      renderer.autoClear=rendererState.autoClear;renderer.sortObjects=rendererState.sort;renderer.xr.enabled=rendererState.xr;
      renderer.shadowMap.render=rendererState.shadow;renderer.info.autoReset=rendererState.autoReset;renderer.renderBufferDirect=rendererState.direct;
      Object.assign(renderer.info.render,{calls:rendererState.calls,triangles:rendererState.triangles,points:rendererState.points,lines:rendererState.lines});
      renderer.setRenderTarget(rendererState.target,rendererState.face,rendererState.level);
      renderer.setViewport(rendererState.viewport);renderer.setScissor(rendererState.scissor);renderer.setScissorTest(rendererState.scissorTest);
    }
  };
  let fence:WebGLSync|null=null,sliceStart=performance.now(),sliceItems=0;
  try{
    publish();
    for(const source of sources){
      warm(source,camera);state.beautyBindings++;
      if(source.castShadow){
        const material=source.material as THREE.MeshStandardMaterial,depth=source.customDepthMaterial;
        if(options.shadowCamera&&depthTarget&&depth instanceof THREE.MeshDepthMaterial&&material.opacity===1&&material.alphaTest===0&&
          !material.alphaHash&&!material.alphaToCoverage&&!material.clippingPlanes?.length&&!material.displacementMap&&!material.alphaMap&&!material.map){
          warm(source,options.shadowCamera,depth);state.shadowBindings++;
        }else state.unsupportedShadows++;
      }
      state.completed++;
      if(++sliceItems>=16||performance.now()-sliceStart>=6){
        state.slices++;publish();await yieldPreparation(signal);check();sliceItems=0;sliceStart=performance.now();
      }
    }
    state.stage='gpu';publish();fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    if(!fence)throw new Error('Could not create the resident binding completion fence.');
    gl.flush();
    while(true){
      check();const status=gl.clientWaitSync(fence,0,0);
      if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;
      if(status===gl.WAIT_FAILED)throw new Error('Resident binding completion wait failed.');
      state.slices++;await yieldPreparation(signal);
    }
    state.stage='complete';publish();return{...state};
  }finally{if(fence)gl.deleteSync(fence);sources.length=0;lights.length=0;}
}
