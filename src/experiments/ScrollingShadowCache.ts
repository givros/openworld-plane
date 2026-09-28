import * as THREE from 'three';

export interface ShadowCacheRect { x:number;y:number;width:number;height:number }
export interface ShadowScrollPlan {
  overlap?:{source:ShadowCacheRect;destination:ShadowCacheRect};
  updates:ShadowCacheRect[];
  reusedTexels:number;
  updatedTexels:number;
}
export interface ShadowCacheCallbacks {
  /** Complete changed-caster coverage since the cache's committed revision, in
   * CURRENT native map pixels. Include both old and new bounds for moves/removal.
   * [] proves all changes are outside this window; omission requests a full refill.
   */
  dirtyRegions?:readonly ShadowCacheRect[];
  /** Render this light's complete static caster set for the supplied native pixel region. */
  drawStatic:(region:ShadowCacheRect)=>void;
  /** Render only dynamic casters. The cache suppresses this target's first native clear. */
  drawDynamic:()=>void;
  /** Canonical static + dynamic fallback. Must preserve normal native clearing. */
  drawAll:()=>void;
}
export interface ShadowCacheResult {
  cached:boolean;fallback:boolean;reason:string;
  reusedTexels:number;updatedTexels:number;staticDraws:number;
}

/** Positive shift means the new world window moved towards positive light X/Y. */
export function planShadowDepthScroll(width:number,height:number,shiftX:number,shiftY:number):ShadowScrollPlan {
  if(![width,height,shiftX,shiftY].every(Number.isSafeInteger)||width<1||height<1)
    throw new Error('Shadow scroll dimensions and offsets must be integers');
  const total=width*height;
  if(!Number.isSafeInteger(total))throw new Error('Shadow scroll size is out of range');
  if(Math.abs(shiftX)>=width||Math.abs(shiftY)>=height)
    return{updates:[{x:0,y:0,width,height}],reusedTexels:0,updatedTexels:total};
  const w=width-Math.abs(shiftX),h=height-Math.abs(shiftY);
  const source={x:Math.max(0,shiftX),y:Math.max(0,shiftY),width:w,height:h};
  const destination={x:Math.max(0,-shiftX),y:Math.max(0,-shiftY),width:w,height:h};
  const updates:ShadowCacheRect[]=[];
  if(shiftX>0)updates.push({x:width-shiftX,y:0,width:shiftX,height});
  else if(shiftX<0)updates.push({x:0,y:0,width:-shiftX,height});
  if(shiftY>0)updates.push({x:destination.x,y:height-shiftY,width:w,height:shiftY});
  else if(shiftY<0)updates.push({x:destination.x,y:0,width:w,height:-shiftY});
  return{overlap:{source,destination},updates,reusedTexels:w*h,updatedTexels:total-w*h};
}

/** Exact clipped rectangle union. Horizontal runs are vertically coalesced so
 * no cached pixel is cleared twice and unrelated dirty areas stay independent.
 */
export function unionShadowCacheRegions(width:number,height:number,regions:readonly ShadowCacheRect[]):ShadowCacheRect[] {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)
    throw new Error('Shadow dirty-region dimensions must be positive integers');
  const clipped:ShadowCacheRect[]=[],boundaries=new Set<number>();
  for(const rect of regions){
    if(![rect.x,rect.y,rect.width,rect.height,rect.x+rect.width,rect.y+rect.height].every(Number.isSafeInteger)||rect.width<0||rect.height<0)
      throw new Error('Shadow dirty-region coordinates must be integer pixel rectangles');
    const left=Math.max(0,rect.x),bottom=Math.max(0,rect.y),right=Math.min(width,rect.x+rect.width),top=Math.min(height,rect.y+rect.height);
    if(left>=right||bottom>=top)continue;
    const bounded={x:left,y:bottom,width:right-left,height:top-bottom};clipped.push(bounded);boundaries.add(bottom);boundaries.add(top);
  }
  const ys=[...boundaries].sort((a,b)=>a-b),output:ShadowCacheRect[]=[];
  let previousRuns=new Map<string,ShadowCacheRect>();
  for(let i=0;i<ys.length-1;i++){
    const y=ys[i],top=ys[i+1],intervals:ShadowCacheRect[]=[];
    for(const rect of clipped)if(rect.y<=y&&rect.y+rect.height>=top)intervals.push(rect);
    intervals.sort((a,b)=>a.x-b.x||a.width-b.width);
    const runs:{left:number;right:number}[]=[];
    for(const rect of intervals){
      const last=runs[runs.length-1],right=rect.x+rect.width;
      if(last&&rect.x<=last.right)last.right=Math.max(last.right,right);
      else runs.push({left:rect.x,right});
    }
    const currentRuns=new Map<string,ShadowCacheRect>();
    for(const run of runs){
      const key=`${run.left}:${run.right}`,previous=previousRuns.get(key);
      if(previous&&previous.y+previous.height===y){previous.height+=top-y;currentRuns.set(key,previous);}
      else{const rect={x:run.left,y,width:run.right-run.left,height:top-y};output.push(rect);currentRuns.set(key,rect);}
    }
    previousRuns=currentRuns;
  }
  return output;
}

interface ShadowFrame { projection:number[];view:number[];texelX:number;texelY:number }
interface Entry {
  native:THREE.WebGLRenderTarget;
  current:THREE.WebGLRenderTarget;
  spare:THREE.WebGLRenderTarget;
  frame:ShadowFrame;
  dirtyRevision:string|number;
  valid:boolean;
}
const full=(target:THREE.WebGLRenderTarget):ShadowCacheRect=>({x:0,y:0,width:target.width,height:target.height});
const finiteRevision=(value:string|number):boolean=>typeof value==='string'||typeof value==='number'&&Number.isFinite(value);

/** Fixed-projection, fixed-Z native depth cache. Opt-in only: no asset reduction.
 * Camera-dependent receiver trimming must be disabled for static cache fills.
 * Caller provides conservative strip caster selection and visibility isolation.
 */
export class ScrollingShadowCache {
  private readonly entries=new Map<THREE.DirectionalLight,Entry>();
  private readonly observedShadowTypes=new WeakMap<THREE.DirectionalLight,number>();
  private disposed=false;
  private rendering=false;
  private readonly maxLights:number;
  readonly statistics={cachedFrames:0,fallbackFrames:0,staticDraws:0,reusedTexels:0,updatedTexels:0,lastReason:'unused'};

  constructor(private readonly renderer:THREE.WebGLRenderer,options:{maxLights?:number}={}){
    this.maxLights=options.maxLights??2;
    if(!Number.isInteger(this.maxLights)||this.maxLights<1)throw new Error('Shadow cache light limit must be positive');
  }

  get allocatedBytes():number {
    // Standard color-backed targets: RGBA8 + native depth (conservative4bytes).
    let bytes=0;for(const entry of this.entries.values())bytes+=entry.current.width*entry.current.height*8*2;
    return bytes;
  }

  render(light:THREE.DirectionalLight,dirtyRevision:string|number,callbacks:ShadowCacheCallbacks):ShadowCacheResult {
    if(this.disposed)throw new Error('Shadow cache is disposed');
    if(this.rendering)throw new Error('Recursive shadow cache dispatch is unsupported');
    const shadow=light.shadow;
    let native=shadow.map;
    const previousTarget=this.renderer.getRenderTarget();
    const previousFace=this.renderer.getActiveCubeFace(),previousLevel=this.renderer.getActiveMipmapLevel();
    let fallingBack=false;
    const fallback=(reason:string):ShadowCacheResult=>{
      fallingBack=true;
      shadow.map=native;this.forceDraw(light,callbacks.drawAll);native=shadow.map;
      this.statistics.fallbackFrames++;this.statistics.lastReason=reason;
      return{cached:false,fallback:true,reason,reusedTexels:0,updatedTexels:0,staticDraws:0};
    };
    this.rendering=true;
    try{
      const shadowType=this.renderer.shadowMap.type,previousType=this.observedShadowTypes.get(light);
      this.observedShadowTypes.set(light,shadowType);
      if(previousType!==undefined&&previousType!==shadowType){
        const previousEntry=this.entries.get(light);
        if(previousEntry){this.release(previousEntry);this.entries.delete(light);}
        // Native shadow rendering consumes its type-change flag globally. Each
        // separately dispatched light must therefore request a fresh native map
        // before any temporary cache target can be substituted or sampled.
        native?.depthTexture?.dispose();native?.dispose();shadow.map=null;native=null;
        return fallback('shadow-type-changed');
      }
      const unsupported=this.unsupported(light,dirtyRevision);
      if(unsupported){this.invalidate(light);return fallback(unsupported);}
      const target=native as THREE.WebGLRenderTarget,camera=shadow.camera as THREE.OrthographicCamera;
      // A native map can already exist while its framebuffer was released by
      // setSize(). Static draws target our scratch maps, so no native draw would
      // initialize this destination before the first full depth copy. Allocation
      // alone is sufficient: every native depth pixel is overwritten below.
      this.renderer.initRenderTarget(target);
      const frame:ShadowFrame={projection:[...camera.projectionMatrix.elements],view:[...camera.matrixWorldInverse.elements],
        texelX:(camera.right-camera.left)/target.width,texelY:(camera.top-camera.bottom)/target.height};
      let entry=this.entries.get(light);
      if(entry&&(entry.native!==target||entry.current.width!==target.width||entry.current.height!==target.height||
        entry.current.depthTexture?.type!==target.depthTexture?.type||entry.current.depthTexture?.format!==target.depthTexture?.format)){
        this.release(entry);this.entries.delete(light);entry=undefined;
      }
      if(!entry){
        if(this.entries.size>=this.maxLights)return fallback('light-limit');
        entry=this.createEntry(target,frame,dirtyRevision);this.entries.set(light,entry);
      }
      let reason='unchanged',plan:ShadowScrollPlan;
      if(!this.sameProjection(entry.frame,frame)){
        entry.frame=frame;entry.valid=false;return fallback('projection-or-depth-changed');
      }
      const x=(entry.frame.view[12]-frame.view[12])/frame.texelX;
      const y=(entry.frame.view[13]-frame.view[13])/frame.texelY;
      const shiftX=Math.round(x),shiftY=Math.round(y);
      if(Math.abs(x-shiftX)>1e-5||Math.abs(y-shiftY)>1e-5){
        entry.frame=frame;entry.valid=false;return fallback('noninteger-texel-shift');
      }
      const revisionChanged=entry.dirtyRevision!==dirtyRevision;
      if(!entry.valid||revisionChanged&&callbacks.dirtyRegions===undefined){
        reason=entry.valid?'static-revision':'initial';
        plan={updates:[full(target)],reusedTexels:0,updatedTexels:target.width*target.height};
      }else{
        plan=planShadowDepthScroll(target.width,target.height,shiftX,shiftY);
        reason=plan.updatedTexels===0?'unchanged':plan.reusedTexels===0?'teleport':'scroll';
        if(revisionChanged){
          const updates=unionShadowCacheRegions(target.width,target.height,[...plan.updates,...callbacks.dirtyRegions!]);
          const updatedTexels=updates.reduce((total,rect)=>total+rect.width*rect.height,0);
          plan={...plan,updates,updatedTexels,reusedTexels:target.width*target.height-updatedTexels};
          reason=updatedTexels===0?'static-revision-outside-window':shiftX||shiftY?'scroll-and-static-regions':'static-regions';
        }
      }
      let staticDraws=0;
      if(plan.updatedTexels){
        const destination=entry.spare;
        if(plan.overlap&&plan.reusedTexels)this.blitDepth(entry.current,destination,plan.overlap.source,plan.overlap.destination);
        shadow.map=destination;
        for(const rect of plan.updates){
          destination.scissor.set(rect.x,rect.y,rect.width,rect.height);destination.scissorTest=true;
          this.forceDraw(light,()=>callbacks.drawStatic(rect));staticDraws++;
        }
        destination.scissorTest=false;
        shadow.map=target;
        const previous=entry.current;entry.current=destination;entry.spare=previous;
      }
      entry.frame=frame;entry.dirtyRevision=dirtyRevision;entry.valid=true;
      shadow.map=target;
      this.blitDepth(entry.current,target,full(target),full(target));
      this.drawDynamicOverCache(light,target,callbacks.drawDynamic);
      this.statistics.cachedFrames++;this.statistics.staticDraws+=staticDraws;
      this.statistics.reusedTexels+=plan.reusedTexels;this.statistics.updatedTexels+=plan.updatedTexels;this.statistics.lastReason=reason;
      return{cached:true,fallback:false,reason,reusedTexels:plan.reusedTexels,updatedTexels:plan.updatedTexels,staticDraws};
    }catch(error){
      if(fallingBack)throw error;
      this.invalidate(light);shadow.map=native;
      // A failed experimental path must never leave old or partial depth visible.
      return fallback(`cache-error: ${error instanceof Error?error.message:String(error)}`);
    }finally{
      shadow.map=native;
      try{this.renderer.setRenderTarget(previousTarget,previousFace,previousLevel);}finally{this.rendering=false;}
    }
  }

  invalidate(light?:THREE.DirectionalLight):void {
    if(light){const entry=this.entries.get(light);if(entry)entry.valid=false;}
    else for(const entry of this.entries.values())entry.valid=false;
  }

  private unsupported(light:THREE.DirectionalLight,dirtyRevision:string|number):string|undefined {
    const shadow=light.shadow,target=shadow.map,camera=shadow.camera;
    if(!light.isDirectionalLight||!(camera instanceof THREE.OrthographicCamera))return'unsupported-light';
    if(!finiteRevision(dirtyRevision))return'invalid-static-revision';
    if(this.renderer.shadowMap.type!==THREE.PCFShadowMap)return'unsupported-shadow-type';
    if(!target)return'native-map-not-initialized';
    if(!(target instanceof THREE.WebGLRenderTarget)||target instanceof THREE.WebGLCubeRenderTarget||target.samples!==0||target.stencilBuffer||!target.depthTexture)return'unsupported-target';
    const depthTypes:number[]=[THREE.UnsignedIntType,THREE.FloatType,THREE.UnsignedShortType];
    if(target.depthTexture.format!==THREE.DepthFormat||!depthTypes.includes(target.depthTexture.type))return'unsupported-depth-format';
    if(target.width!==shadow.mapSize.x||target.height!==shadow.mapSize.y)return'native-map-size-mismatch';
    if(![target.width,target.height].every(value=>Number.isInteger(value)&&value>0&&value<=this.renderer.capabilities.maxTextureSize))return'unsupported-map-size';
    if(!camera.projectionMatrix.elements.every(Number.isFinite)||!camera.matrixWorldInverse.elements.every(Number.isFinite)||
      !(camera.right>camera.left)||!(camera.top>camera.bottom)||!(camera.far>camera.near))return'invalid-camera';
    const e=camera.matrixWorldInverse.elements;
    if(e[3]!==0||e[7]!==0||e[11]!==0||e[15]!==1)return'non-affine-light-view';
    return undefined;
  }

  private sameProjection(previous:ShadowFrame,next:ShadowFrame):boolean {
    // Preserve the light-axis depth interval and orientation. Only X/Y translation
    // can change; compare GPU-representable basis/Z coefficients conservatively.
    if(previous.texelX!==next.texelX||previous.texelY!==next.texelY)return false;
    for(let i=0;i<16;i++){
      if(previous.projection[i]!==next.projection[i])return false;
      if(i!==12&&i!==13&&Math.fround(previous.view[i])!==Math.fround(next.view[i]))return false;
    }
    return true;
  }

  private createEntry(native:THREE.WebGLRenderTarget,frame:ShadowFrame,dirtyRevision:string|number):Entry {
    const create=():THREE.WebGLRenderTarget=>{
      const target=new THREE.WebGLRenderTarget(native.width,native.height,{depthBuffer:true,stencilBuffer:false,samples:0});
      target.texture.name='Static shadow cache color attachment';target.texture.generateMipmaps=false;
      target.depthTexture=native.depthTexture!.clone();
      target.depthTexture.name='Static shadow cache native depth';
      target.viewport.set(0,0,native.width,native.height);target.scissor.copy(target.viewport);
      try{this.renderer.initRenderTarget(target);}catch(error){target.dispose();target.depthTexture.dispose();throw error;}
      return target;
    };
    const current=create();
    try{return{native,current,spare:create(),frame,dirtyRevision,valid:false};}
    catch(error){current.dispose();current.depthTexture?.dispose();throw error;}
  }

  private forceDraw(light:THREE.DirectionalLight,draw:()=>void):void {
    this.renderer.shadowMap.needsUpdate=true;light.shadow.needsUpdate=true;draw();
  }

  private drawDynamicOverCache(light:THREE.DirectionalLight,target:THREE.WebGLRenderTarget,draw:()=>void):void {
    const renderer=this.renderer,clear=renderer.clear;
    let suppressed=false;
    renderer.clear=function(color?:boolean,depth?:boolean,stencil?:boolean):void {
      if(!suppressed&&renderer.getRenderTarget()===target&&color===undefined&&depth===undefined&&stencil===undefined){suppressed=true;return;}
      clear.call(renderer,color,depth,stencil);
    };
    try{
      this.forceDraw(light,draw);
      if(!suppressed)throw new Error('Native dynamic shadow clear was not observed');
    }finally{renderer.clear=clear;}
  }

  /** Exact depth copy, including nonzero source/destination offsets. Three r184's
   * copyTextureToTexture depth branch passes extents as endpoints for this case.
   */
  private blitDepth(source:THREE.WebGLRenderTarget,destination:THREE.WebGLRenderTarget,from:ShadowCacheRect,to:ShadowCacheRect):void {
    if(source===destination)throw new Error('Overlapping in-place shadow depth copies are forbidden');
    const validate=(rect:ShadowCacheRect,target:THREE.WebGLRenderTarget):void=>{
      if(![rect.x,rect.y,rect.width,rect.height].every(Number.isInteger)||rect.x<0||rect.y<0||rect.width<1||rect.height<1||
        rect.x+rect.width>target.width||rect.y+rect.height>target.height)throw new Error('Invalid shadow depth copy rectangle');
    };
    validate(from,source);validate(to,destination);
    if(from.width!==to.width||from.height!==to.height||source.depthTexture?.format!==destination.depthTexture?.format||
      source.depthTexture?.type!==destination.depthTexture?.type)throw new Error('Shadow depth copy must preserve format and pixel dimensions');
    const renderer=this.renderer,gl=renderer.getContext() as WebGL2RenderingContext,state=renderer.state;
    const sourceFramebuffer=(renderer.properties.get(source) as {__webglFramebuffer?:WebGLFramebuffer}).__webglFramebuffer;
    const destinationFramebuffer=(renderer.properties.get(destination) as {__webglFramebuffer?:WebGLFramebuffer}).__webglFramebuffer;
    if(!sourceFramebuffer||!destinationFramebuffer||Array.isArray(sourceFramebuffer)||Array.isArray(destinationFramebuffer))throw new Error('Shadow framebuffer is unavailable');
    const previousRead=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer|null;
    const previousDraw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer|null;
    const previousScissor=gl.isEnabled(gl.SCISSOR_TEST);
    try{
      state.setScissorTest(false);
      state.bindFramebuffer(gl.READ_FRAMEBUFFER,sourceFramebuffer);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER,destinationFramebuffer);
      gl.blitFramebuffer(from.x,from.y,from.x+from.width,from.y+from.height,
        to.x,to.y,to.x+to.width,to.y+to.height,gl.DEPTH_BUFFER_BIT,gl.NEAREST);
    }finally{
      state.bindFramebuffer(gl.READ_FRAMEBUFFER,previousRead);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER,previousDraw);
      state.setScissorTest(previousScissor);
    }
  }

  private release(entry:Entry):void {
    entry.current.dispose();entry.current.depthTexture?.dispose();entry.spare.dispose();entry.spare.depthTexture?.dispose();
  }
  dispose():void {
    if(this.disposed)return;
    if(this.rendering)throw new Error('Cannot dispose a shadow cache during rendering');
    for(const entry of this.entries.values())this.release(entry);
    this.entries.clear();this.disposed=true;
  }
}
