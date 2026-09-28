import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';

interface PendingProgram {
  program: WebGLProgram | undefined;
  isReady():boolean;
}

const cancelled=():DOMException=>new DOMException('Chunk shader preparation was cancelled.','AbortError');

function waitForPrograms(pending:Set<PendingProgram>,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    let finished=false;
    const finish=(error?:unknown):void=>{
      if(finished)return;
      finished=true;
      if(timer!==undefined)clearTimeout(timer);
      signal.removeEventListener('abort',onAbort);
      pending.clear();
      if(error!==undefined)reject(error);else resolve();
    };
    const onAbort=():void=>finish(cancelled());
    const poll=():void=>{
      timer=undefined;
      try{
        for(const program of pending){
          // Cancellation can dispose the material and its program. Check it
          // before touching the underlying WebGL handle, including each poll.
          if(signal.aborted){onAbort();return;}
          if(program.program==null)throw new Error('A chunk shader program was released before preparation completed.');
          if(program.isReady())pending.delete(program);
          if(finished)return;
        }
        if(signal.aborted){onAbort();return;}
        if(pending.size===0){finish();return;}
        timer=setTimeout(poll,10);
      }catch(error){finish(signal.aborted?cancelled():error);}
    };
    signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted){onAbort();return;}
    if(pending.size===0){finish();return;}
    // Three r184's WebGLProgram.isReady() uses KHR_parallel_shader_compile.
    // Yield even on the first check so chunk activation never busy-waits.
    timer=setTimeout(poll,10);
  });
}

/** Compile hidden chunk variants against the live scene before revealing it. */
export function prepareChunkPrograms(
  renderer:Pick<WebGLRenderer,'compile'|'properties'>,
  chunk:Object3D,
  camera:Camera,
  targetScene:Scene,
  signal:AbortSignal,
):Promise<void>{
  if(signal.aborted)return Promise.reject(cancelled());
  try{
    const materials=renderer.compile(chunk,camera,targetScene);
    const pending=new Set<PendingProgram>();
    for(const material of materials){
      if(signal.aborted)return Promise.reject(cancelled());
      // A shared material can have several object-layout variants. Waiting on
      // currentProgram alone misses earlier variants prepared by compile().
      const properties=renderer.properties.get(material) as {programs?:Map<unknown,PendingProgram>};
      const programs=properties.programs;
      if(!(programs instanceof Map))throw new Error('The Three.js material program cache is unavailable during chunk preparation.');
      for(const program of programs.values()){
        if(typeof program?.isReady!=='function')throw new Error('The Three.js shader readiness interface changed.');
        pending.add(program as PendingProgram);
      }
    }
    // The asynchronous closure owns only program references, never chunk,
    // scene, renderer or materials; disposal/cancellation clears them all.
    return waitForPrograms(pending,signal);
  }catch(error){return Promise.reject(signal.aborted?cancelled():error);}
}
