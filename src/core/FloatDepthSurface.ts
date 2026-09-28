import * as THREE from 'three';

const skipShadowPass=():void=>{};

export interface FloatDepthSurfaceSupport {
  supported:boolean;
  samples:number;
  reason?:string;
}

/** Run on the default framebuffer before choosing renderer depth flags. */
export function checkFloatDepthSurfaceSupport(gl:WebGL2RenderingContext):FloatDepthSurfaceSupport {
  let samples=0;
  try{
    if(THREE.REVISION!=='184')return {supported:false,samples,reason:'The screen-output adapter requires review for this Three revision.'};
    samples=gl.getParameter(gl.SAMPLES) as number;
    if(!Number.isInteger(samples)||samples<1)return {supported:false,samples,reason:'The default framebuffer does not provide multisampling.'};
    if(!gl.getExtension('EXT_clip_control'))return {supported:false,samples,reason:'Reversed depth is unavailable.'};
    for(const format of [gl.RGBA8,gl.DEPTH_COMPONENT32F]){
      const supported=gl.getInternalformatParameter(gl.RENDERBUFFER,format,gl.SAMPLES) as Int32Array;
      if(!supported||!Array.from(supported).includes(samples))return {supported:false,samples,reason:'Float depth cannot preserve the default framebuffer sample count.'};
    }
    return {supported:true,samples};
  }catch{
    return {supported:false,samples,reason:'Float depth framebuffer support could not be verified.'};
  }
}

/**
 * Opt-in r184 adapter: floating-point depth, unchanged screen color semantics.
 *
 * Ordinary targets disable per-material tone mapping; a final OutputPass would
 * then tone-map the untonemapped sky and change transparent compositing. r184's
 * isXRRenderTarget gate preserves screen output semantics without enabling XR.
 * Its use is deliberately pinned and tested against the installed source.
 * RGBA8 storage is explicit: the sRGB metadata selects shader conversion only,
 * and must not create SRGB8_ALPHA8 storage or a second hardware conversion.
 */
export class FloatDepthSurface {
  readonly target:THREE.WebGLRenderTarget;
  readonly samples:number;
  readonly outputPass={calls:0,triangles:0};
  private readonly size=new THREE.Vector2();
  private readonly geometry:THREE.BufferGeometry;
  private readonly material:THREE.RawShaderMaterial;
  private readonly triangle:THREE.Mesh;
  private readonly camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  private active=false;
  private disposed=false;

  constructor(private readonly renderer:THREE.WebGLRenderer){
    if(renderer.getRenderTarget()!==null)throw new Error('Float depth must be configured from the default framebuffer.');
    const support=checkFloatDepthSurfaceSupport(renderer.getContext() as WebGL2RenderingContext);
    if(!support.supported)throw new Error(support.reason);
    if(!renderer.capabilities.reversedDepthBuffer||renderer.capabilities.logarithmicDepthBuffer)
      throw new Error('Float depth requires reversed depth without logarithmic fragment writes.');
    if(renderer.outputColorSpace!==THREE.SRGBColorSpace)throw new Error('This screen-output adapter supports the existing sRGB output only.');
    this.samples=support.samples;
    renderer.getDrawingBufferSize(this.size);
    this.target=new THREE.WebGLRenderTarget(this.size.x,this.size.y,{
      type:THREE.UnsignedByteType,format:THREE.RGBAFormat,internalFormat:'RGBA8',
      colorSpace:renderer.outputColorSpace,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,
      generateMipmaps:false,depthBuffer:true,stencilBuffer:false,samples:this.samples,
      depthTexture:new THREE.DepthTexture(this.size.x,this.size.y,THREE.FloatType),
      // No current pass samples scene depth. Avoid an unused depth resolve;
      // the full-precision multisampled depth attachment still renders every pixel.
      resolveDepthBuffer:false,resolveStencilBuffer:false,
    });
    (this.target as THREE.WebGLRenderTarget&{isXRRenderTarget:boolean}).isXRRenderTarget=true;
    this.target.texture.name='Screen color with floating-point depth';
    this.target.depthTexture!.name='Reversed floating-point scene depth';
    this.geometry=new THREE.BufferGeometry();
    this.geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    this.material=new THREE.RawShaderMaterial({
      name:'Exact screen color copy',glslVersion:THREE.GLSL3,
      uniforms:{surface:{value:this.target.texture}},
      vertexShader:'precision highp float; in vec3 position; void main(){gl_Position=vec4(position,1.0);}',
      fragmentShader:'precision highp float; precision highp int; uniform highp sampler2D surface; out vec4 color; void main(){color=texelFetch(surface,ivec2(gl_FragCoord.xy),0);}',
      depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false,
    });
    this.triangle=new THREE.Mesh(this.geometry,this.material);
    this.triangle.frustumCulled=false;
    try{this.validateFramebuffer();}catch(error){this.dispose();throw error;}
  }

  private assertUsable():void {
    if(this.disposed)throw new Error('The floating-point depth surface was disposed.');
    if(this.renderer.outputColorSpace!==this.target.texture.colorSpace)throw new Error('Screen output color space changed; recreate the depth surface.');
  }

  private validateFramebuffer():void {
    const gl=this.renderer.getContext() as WebGL2RenderingContext;
    const previous=this.renderer.getRenderTarget();
    try{
      this.renderer.setRenderTarget(this.target);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE||
        gl.getParameter(gl.SAMPLES)!==this.samples||gl.getParameter(gl.DEPTH_BITS)!==32||
        gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE)!==gl.FLOAT)
        throw new Error('The GPU did not provide the requested Float32 depth and unchanged MSAA sample count.');
    }finally{this.renderer.setRenderTarget(previous);}
  }

  /** Call after renderer.setSize(), or allow begin() to pick up the new size. */
  resize():void {
    this.assertUsable();
    if(this.active)throw new Error('Cannot resize a frame that is still being rendered.');
    this.renderer.getDrawingBufferSize(this.size);
    if(this.target.width===this.size.x&&this.target.height===this.size.y)return;
    this.target.setSize(this.size.x,this.size.y);
    this.validateFramebuffer();
  }

  /** Bind before the ordinary scene draw; all scene assets and passes are unchanged. */
  begin():void {
    this.assertUsable();
    if(this.active)throw new Error('The floating-point depth frame is already active.');
    if(this.renderer.getRenderTarget()!==null)throw new Error('Float depth screen rendering cannot nest inside another target.');
    this.resize();
    this.renderer.setRenderTarget(this.target);
    this.active=true;
  }

  /**
   * Present the resolved screen bytes without another tone/color conversion.
   * Scene counters and shadow hooks exclude this copy; outputPass reports its
   * additional draw separately. The renderer's frame counter remains monotonic.
   */
  end():void {
    this.assertUsable();
    if(!this.active)throw new Error('No floating-point depth frame is active.');
    const renderer=this.renderer,statistics=renderer.info.render;
    const calls=statistics.calls,triangles=statistics.triangles,points=statistics.points,lines=statistics.lines;
    const automaticReset=renderer.info.autoReset,shadowRender=renderer.shadowMap.render;
    this.active=false;
    renderer.setRenderTarget(null);
    renderer.info.autoReset=false;
    // This triangle has no shadows. Skipping the empty hook also preserves the
    // caller's scene shadow counters and avoids touching its instance culler.
    renderer.shadowMap.render=skipShadowPass;
    try{
      renderer.render(this.triangle,this.camera);
      this.outputPass.calls=statistics.calls-calls;
      this.outputPass.triangles=statistics.triangles-triangles;
    }finally{
      renderer.shadowMap.render=shadowRender;renderer.info.autoReset=automaticReset;
      statistics.calls=calls;statistics.triangles=triangles;statistics.points=points;statistics.lines=lines;
      renderer.setRenderTarget(null);
    }
  }

  /** Restore the canvas if the scene draw throws before end(). */
  abort():void {
    if(this.active){this.renderer.setRenderTarget(null);this.active=false;}
  }

  dispose():void {
    if(this.disposed)return;
    this.abort();this.disposed=true;
    // r184 disposes an allocated target's attached depth texture with the target.
    this.target.dispose();this.geometry.dispose();this.material.dispose();
  }
}
