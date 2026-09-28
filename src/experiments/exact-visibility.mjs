import * as THREE from 'three';
import kernel from './exact-visibility.wgsl?raw';

/** Isolated, full-triangle visibility benchmark; this is not a shaded game renderer. */
export class ExactVisibilityProbe {
 static async create(baseURL,{width=1440,height=900,samples=1,stackDepth=64,kernelVariant='scalar'}={}){
  const probe=new ExactVisibilityProbe();await probe.initialize(baseURL,width,height,samples,stackDepth,kernelVariant);return probe;
 }
 async initialize(baseURL,width,height,samples,stackDepth,kernelVariant){
  if(![1,4].includes(samples))throw new Error('Probe supports one visibility ray or four MSAA sample locations.');
  this.manifest=await(await fetch(`${baseURL}/manifest.json`)).json();this.width=width;this.height=height;this.samples=samples;this.kernelVariant=kernelVariant;this.errors=[];
  const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('WebGPU unavailable');
  this.adapterInfo={vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description};
  const buffers=[];
  for(const name of ['nodes','positions','triangles','instances','instance-order']){
   const response=await fetch(`${baseURL}/${name==='positions'&&kernelVariant==='packed'?'triangle-positions':name}.bin`);if(!response.ok)throw new Error(`Missing ${name}.bin`);buffers.push(await response.arrayBuffer());
  }
  const maxBinding=Math.max(...buffers.map(data=>data.byteLength),width*height*samples*32);
  if(maxBinding>adapter.limits.maxStorageBufferBindingSize)throw new Error(`Exact buffer exceeds supported limit: ${maxBinding}`);
  this.device=await adapter.requestDevice({requiredFeatures:adapter.features.has('timestamp-query')?['timestamp-query']:[],requiredLimits:{maxStorageBufferBindingSize:maxBinding,maxBufferSize:maxBinding,maxStorageBuffersPerShaderStage:6}});
  this.device.addEventListener('uncapturederror',event=>this.errors.push(event.error.message));
  this.device.lost.then(info=>{if(info.reason!=='destroyed')this.errors.push(`Device lost: ${info.message}`);});
  const device=this.device;this.owned=[];
  const makeBuffer=(size,usage,label)=>{const buffer=device.createBuffer({size:Math.max(4,size),usage,label});this.owned.push(buffer);return buffer;};
  this.sourceBuffers=buffers.map((data,index)=>{const buffer=makeBuffer(data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,`Exact source ${index}`);device.queue.writeBuffer(buffer,0,data);return buffer;});
  this.params=makeBuffer(96,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'Camera');
  this.hits=makeBuffer(width*height*samples*32,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC,'Full precision visibility samples');
  this.output=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
  if((this.manifest.maximumBLASDepth??0)>=stackDepth||(this.manifest.tlasMaxDepth??0)>=stackDepth)throw new Error('Requested traversal stack is too small for this exact hierarchy.');
  let code=kernel;
  if(!['scalar','stack8'].includes(kernelVariant)){const imported=await import(/* @vite-ignore */`/src/experiments/exact-visibility-${kernelVariant}.wgsl?raw`);code=imported.default;}
  if(kernelVariant==='stack8')code=code.replaceAll('array<u32,64>','array<u32,8>').replaceAll('>64u','>8u');
  if(stackDepth!==64)code=code.replaceAll('array<u32,64>','array<u32,'+stackDepth+'>').replaceAll('>64u','>'+stackDepth+'u');
  const module=device.createShaderModule({code,label:'Exact triangle visibility'});const messages=await module.getCompilationInfo();
  const failures=messages.messages.filter(message=>message.type==='error');if(failures.length)throw new Error(JSON.stringify(failures));
  this.pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  if(kernelVariant==='stack8'){
   let fallbackCode=kernel.replaceAll('array<u32,64>','array<u32,32>').replaceAll('>64u','>32u');
   fallbackCode=fallbackCode.replace('let offsets=array<vec2<f32>,4>',`var needsFallback=false;for(var s=0u;s<params.shape.w;s++){if(hits[(id.y*params.shape.x+id.x)*params.shape.w+s].spare.x!=0u){needsFallback=true;}}if(!needsFallback){return;}
 let offsets=array<vec2<f32>,4>`);
   fallbackCode=fallbackCode.replace('let hit=traceWorld','var hit=traceWorld').replace('hits[(id.y*params.shape.x+id.x)*params.shape.w+sample]=hit;','hit.spare.y=1u;hits[(id.y*params.shape.x+id.x)*params.shape.w+sample]=hit;');
   const fallbackModule=device.createShaderModule({code:fallbackCode});
   this.fallbackPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:fallbackModule,entryPoint:'main'}});
  }
  this.bindGroup=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[...this.sourceBuffers.map((buffer,binding)=>({binding,resource:{buffer}})),{binding:5,resource:{buffer:this.params}},{binding:6,resource:{buffer:this.hits}},{binding:7,resource:this.output.createView()}]});
  if(this.fallbackPipeline)this.fallbackBindGroup=device.createBindGroup({layout:this.fallbackPipeline.getBindGroupLayout(0),entries:[...this.sourceBuffers.map((buffer,binding)=>({binding,resource:{buffer}})),{binding:5,resource:{buffer:this.params}},{binding:6,resource:{buffer:this.hits}},{binding:7,resource:this.output.createView()}]});
  if(device.features.has('timestamp-query')){this.queries=device.createQuerySet({type:'timestamp',count:2});this.queryResolve=makeBuffer(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC,'Timing');this.queryRead=makeBuffer(16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'Timing readback');}
  this.bytes=buffers.reduce((sum,data)=>sum+data.byteLength,0)+width*height*samples*32+width*height*4;
  this.canvas=document.querySelector('canvas');this.canvas.width=width;this.canvas.height=height;
 }
 setCamera(position,target,fov=48){
  const camera=new THREE.PerspectiveCamera(fov,this.width/this.height,.15,16000);camera.position.fromArray(position);camera.lookAt(new THREE.Vector3().fromArray(target));camera.updateMatrixWorld();
  const half=Math.tan(THREE.MathUtils.degToRad(fov*.5));const base=new THREE.Vector3(-half*camera.aspect,half,-1).applyQuaternion(camera.quaternion),dx=new THREE.Vector3(2*half*camera.aspect/this.width,0,0).applyQuaternion(camera.quaternion),dy=new THREE.Vector3(0,-2*half/this.height,0).applyQuaternion(camera.quaternion);
  const data=new ArrayBuffer(96),f=new Float32Array(data),u=new Uint32Array(data);f.set([...position,1,...base,0,...dx,0,...dy,0]);u.set([this.width,this.height,this.manifest.tlasRoot??this.manifest.rootTLAS,this.samples],16);f.set([camera.near,camera.far,0,0],20);this.device.queue.writeBuffer(this.params,0,data);this.cameraParams={origin:Array.from(f.slice(0,3)),base:Array.from(f.slice(4,7)),dx:Array.from(f.slice(8,11)),dy:Array.from(f.slice(12,15)),near:camera.near,far:camera.far};
 }
 async render(){
  const start=performance.now(),encoder=this.device.createCommandEncoder();
  const pass=encoder.beginComputePass(this.queries?{timestampWrites:{querySet:this.queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
  pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bindGroup);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8),this.kernelVariant==='parallel'?this.samples:1);if(this.fallbackPipeline){pass.setPipeline(this.fallbackPipeline);pass.setBindGroup(0,this.fallbackBindGroup);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));}pass.end();
  if(this.queries){encoder.resolveQuerySet(this.queries,0,2,this.queryResolve,0);encoder.copyBufferToBuffer(this.queryResolve,0,this.queryRead,0,16);}
  this.device.queue.submit([encoder.finish()]);await this.device.queue.onSubmittedWorkDone();const completedMs=performance.now()-start;let gpuMs=null;
  if(this.queries){await this.queryRead.mapAsync(GPUMapMode.READ);const times=new BigUint64Array(this.queryRead.getMappedRange());gpuMs=Number(times[1]-times[0])/1e6;this.queryRead.unmap();}
  return {completedMs,gpuMs,errors:[...this.errors]};
 }
 async inspect(){
  const device=this.device,pitch=Math.ceil(this.width*4/256)*256,read=device.createBuffer({size:pitch*this.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:this.output},{buffer:read,bytesPerRow:pitch},[this.width,this.height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
  const source=new Uint8Array(read.getMappedRange()),pixels=new Uint8ClampedArray(this.width*this.height*4);for(let y=0;y<this.height;y++)pixels.set(source.subarray(y*pitch,y*pitch+this.width*4),y*this.width*4);read.unmap();read.destroy();
  this.canvas.getContext('2d').putImageData(new ImageData(pixels,this.width,this.height),0,0);
  const bytes=this.width*this.height*this.samples*32,hitRead=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});const e=device.createCommandEncoder();e.copyBufferToBuffer(this.hits,0,hitRead,0,bytes);device.queue.submit([e.finish()]);await hitRead.mapAsync(GPUMapMode.READ);const words=new Uint32Array(hitRead.getMappedRange()),floats=new Float32Array(words.buffer,words.byteOffset,words.length);let found=0,steps=0,overflow=0,fallback=0;for(let i=0;i<words.length;i+=8){found+=Number(words[i]!==0xffffffff);steps+=words[i+5];overflow+=Number(words[i+6]!==0);fallback+=Number(words[i+7]!==0);}
  const validationHits=[];for(let y=0;y<12;y++)for(let x=0;x<16;x++)for(let sample=0;sample<this.samples;sample++){const px=Math.floor((x+.5)*this.width/16),py=Math.floor((y+.5)*this.height/12),index=((py*this.width+px)*this.samples+sample)*8;validationHits.push({x:px,y:py,sample,instance:words[index],triangle:words[index+1],distance:floats[index+2],u:floats[index+3],v:floats[index+4]});}
  const hitBytes=new Uint8Array(words.buffer,words.byteOffset,words.byteLength).slice();this.hitBytes=hitBytes;const hitHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',hitBytes))).map(x=>x.toString(16).padStart(2,'0')).join('');hitRead.unmap();hitRead.destroy();
  return {found,totalSamples:this.width*this.height*this.samples,meanNodeTests:steps/(this.width*this.height*this.samples),stackOverflow:overflow,scalarFallbackSamples:fallback,hitHash,cameraParams:this.cameraParams,validationHits,png:this.canvas.toDataURL('image/png')};
 }
 dispose(){for(const buffer of this.owned??[])buffer.destroy();this.output?.destroy();this.queries?.destroy();this.device?.destroy();}
}
