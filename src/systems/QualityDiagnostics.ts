import * as THREE from 'three';
import type { RenderPassStatistics } from '../core/Renderer';
export class QualityDiagnostics {
  frame=0;
  private readonly frameTimes=new Float32Array(600);
  private frameCount=0;
  private index=0;
  update(dt:number):void {this.frame++;if(dt>0&&Number.isFinite(dt)){this.frameTimes[this.index]=dt*1000;this.index=(this.index+1)%600;this.frameCount=Math.min(600,this.frameCount+1);}}
  get performance(){const a=Array.from(this.frameTimes.subarray(0,this.frameCount)).sort((x,y)=>x-y);const median=a[Math.floor(a.length*.5)]??0;return{samples:a.length,medianFps:median?1000/median:0,medianFrameMs:median,p95FrameMs:a[Math.floor(a.length*.95)]??0};}
  inspect(scene:THREE.Scene,renderer:THREE.WebGLRenderer,passes?:RenderPassStatistics){
    const materials=new Set<THREE.Material>();let objects=0,meshes=0,shadowCasters=0,instancedMeshes=0;
    scene.traverse(o=>{objects++;if(o instanceof THREE.Mesh){meshes++;if(o.castShadow)shadowCasters++;if(o instanceof THREE.InstancedMesh)instancedMeshes++;if(Array.isArray(o.material))for(const m of o.material)materials.add(m);else materials.add(o.material);}});
    return{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,depthMode:renderer.capabilities.logarithmicDepthBuffer?'logarithmic':renderer.capabilities.reversedDepthBuffer?'reversed':'standard',passes:passes?{shadow:{...passes.shadow},beauty:{...passes.beauty},total:{...passes.total}}:undefined,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,canvas:{width:renderer.domElement.width,height:renderer.domElement.height,dpr:renderer.getPixelRatio()},objects,meshes,instancedMeshes,materials:materials.size,shadowCasters};
  }
}
