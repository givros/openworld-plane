import * as THREE from 'three';
import { supportsOrthographicShadowDepth } from '../systems/OrthographicShadowDepth';

/** Experimental shadow-only path. Matrix regrouping changes floating-point rounding;
 * image parity must be measured before enabling it in production. Source geometry,
 * triangle order and canonical instance matrices remain untouched.
 */
export function supportsPrecomposedShadowMatrices(source:THREE.Mesh,camera:THREE.Camera):source is THREE.InstancedMesh {
  if(!(source instanceof THREE.InstancedMesh)||!(camera instanceof THREE.OrthographicCamera)||
    source.morphTexture||source.geometry instanceof THREE.InstancedBufferGeometry||source.geometry.indirect||
    Object.values(source.geometry.morphAttributes as Record<string,THREE.BufferAttribute[]>).some(attributes=>attributes.length>0)||
    source.geometry.hasAttribute('skinIndex')||source.geometry.hasAttribute('skinWeight')||
    source.onBeforeShadow!==THREE.Object3D.prototype.onBeforeShadow||source.onAfterShadow!==THREE.Object3D.prototype.onAfterShadow||
    !supportsOrthographicShadowDepth(source))return false;
  return true;
}

/** Caller must additionally reject renderer-wide clipping planes. The proxy keeps
 * the source's matrixWorld (including determinant/side policy) but must disable its
 * own bounds tests: its instanceMatrix now contains clip coordinates, not world poses.
 */
export function createPrecomposedShadowDepth():THREE.MeshDepthMaterial {
  const material=new THREE.MeshDepthMaterial();
  material.name='Experimental precomposed orthographic shadow depth';
  material.onBeforeCompile=shader=>{
    const projection='#include <project_vertex>',logarithmic='#include <logdepthbuf_fragment>';
    if(!shader.vertexShader.includes(projection)||!shader.fragmentShader.includes(logarithmic))
      throw new Error('Review precomposed shadow integration after the Three.js shader update');
    shader.vertexShader=shader.vertexShader.replace(projection,/* glsl */`
      #if !defined( USE_INSTANCING ) || defined( USE_BATCHING ) || NUM_CLIPPING_PLANES > 0
        #error Precomposed_shadow_depth_requires_unclipped_instanced_geometry
      #endif
      vec4 mvPosition = instanceMatrix * vec4( transformed, 1.0 );
      gl_Position = mvPosition;
    `);
    shader.fragmentShader=shader.fragmentShader.replace(logarithmic,'');
  };
  material.customProgramCacheKey=()=>'precomposed-orthographic-shadow-depth-v1';
  return material;
}

/** Reuses scratch storage; one instance may process every source/light serially. */
export class PrecomposedShadowMatrixWriter {
  private readonly modelView=new THREE.Matrix4();
  private readonly roundedProjection=new THREE.Matrix4();
  private readonly clip=new THREE.Matrix4();
  private configured=false;

  /** Match the native uniform conversion before regrouping its matrix products. */
  setTransform(projection:THREE.Matrix4,viewInverse:THREE.Matrix4,modelWorld:THREE.Matrix4):void {
    this.modelView.multiplyMatrices(viewInverse,modelWorld);
    const mv=this.modelView.elements,p=this.roundedProjection.elements,original=projection.elements;
    this.configured=false;
    for(let i=0;i<16;i++){
      if(!Number.isFinite(mv[i])||!Number.isFinite(original[i]))throw new Error('Shadow transforms must be finite');
      mv[i]=Math.fround(mv[i]);p[i]=Math.fround(original[i]);
      if(!Number.isFinite(mv[i])||!Number.isFinite(p[i]))throw new Error('Shadow transforms exceed GPU float range');
    }
    this.clip.multiplyMatrices(this.roundedProjection,this.modelView);
    this.configured=true;
  }

  /** Use canonical source matrices every time; never feed a previous clip buffer
   * back into this method. Only the selected prefix is overwritten. The caller
   * marks the proxy attribute dirty and chooses the appropriate upload range.
   */
  writeSelected(source:Float32Array,selected:ArrayLike<number>,count:number,target:Float32Array):void {
    if(!this.configured)throw new Error('Configure the shadow transform before writing');
    if(!Number.isInteger(count)||count<0||count>selected.length||count*16>target.length||source.length%16!==0)
      throw new Error('Invalid shadow matrix selection or output capacity');
    if(source.buffer===target.buffer)throw new Error('Shadow output must not alias canonical instance matrices');
    const e=this.clip.elements,sourceCount=source.length/16;
    for(let instance=0;instance<count;instance++){
      const index=selected[instance];
      if(!Number.isInteger(index)||index<0||index>=sourceCount)throw new Error('Shadow instance index is out of range');
      const from=index*16,to=instance*16;
      for(let column=0;column<16;column+=4){
        const x=source[from+column],y=source[from+column+1],z=source[from+column+2],w=source[from+column+3];
        target[to+column]=e[0]*x+e[4]*y+e[8]*z+e[12]*w;
        target[to+column+1]=e[1]*x+e[5]*y+e[9]*z+e[13]*w;
        target[to+column+2]=e[2]*x+e[6]*y+e[10]*z+e[14]*w;
        target[to+column+3]=e[3]*x+e[7]*y+e[11]*z+e[15]*w;
      }
    }
  }
}
