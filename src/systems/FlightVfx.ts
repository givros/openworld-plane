import * as THREE from 'three';
import { clamp, type FlightState, type GroundSampler } from '../game/types';
class ParticlePool {
  readonly mesh:THREE.Points;
  private readonly position:Float32Array;
  private readonly life:Float32Array;
  private readonly size:Float32Array;
  private readonly velocity:Float32Array;
  private readonly duration:Float32Array;
  private cursor=0;
  constructor(private readonly count:number,color:string){
    const g=new THREE.BufferGeometry();this.position=new Float32Array(count*3);this.life=new Float32Array(count);this.size=new Float32Array(count);this.velocity=new Float32Array(count*3);this.duration=new Float32Array(count);
    g.setAttribute('position',new THREE.BufferAttribute(this.position,3).setUsage(THREE.DynamicDrawUsage));g.setAttribute('alpha',new THREE.BufferAttribute(this.life,1).setUsage(THREE.DynamicDrawUsage));g.setAttribute('size',new THREE.BufferAttribute(this.size,1).setUsage(THREE.DynamicDrawUsage));
    const m=new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{color:{value:new THREE.Color(color)}},
      vertexShader:`attribute float alpha; attribute float size; varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){vAlpha=alpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(size*450./max(1.,-p.z),1.,90.);
#include <logdepthbuf_vertex>
}`,
      fragmentShader:`uniform vec3 color;varying float vAlpha;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
float d=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(color,pow(max(0.,1.-d),2.)*vAlpha*.32);}`,
    });this.mesh=new THREE.Points(g,m);this.mesh.frustumCulled=false;
  }
  emit(x:number,y:number,z:number,vx:number,vy:number,vz:number,lifetime:number,size:number):void {const i=this.cursor,k=i*3;this.position[k]=x;this.position[k+1]=y;this.position[k+2]=z;this.velocity[k]=vx;this.velocity[k+1]=vy;this.velocity[k+2]=vz;this.duration[i]=lifetime;this.life[i]=1;this.size[i]=size;this.cursor=(i+1)%this.count;}
  update(dt:number):void {for(let i=0;i<this.count;i++){if(this.life[i]<=0)continue;const k=i*3;this.life[i]=Math.max(0,this.life[i]-dt/this.duration[i]);this.position[k]+=this.velocity[k]*dt;this.position[k+1]+=this.velocity[k+1]*dt;this.position[k+2]+=this.velocity[k+2]*dt;this.size[i]+=dt*.42;}this.mesh.geometry.attributes.position.needsUpdate=true;this.mesh.geometry.attributes.alpha.needsUpdate=true;this.mesh.geometry.attributes.size.needsUpdate=true;}
  reset():void {this.life.fill(0);this.mesh.geometry.attributes.alpha.needsUpdate=true;}
  dispose():void {this.mesh.geometry.dispose();(this.mesh.material as THREE.Material).dispose();}
}
export class FlightVfx {
  readonly root=new THREE.Group();
  private readonly smoke=new ParticlePool(56,'#777d79');
  private readonly dust=new ParticlePool(42,'#d6c49b');
  private readonly trails:THREE.Line[]=[];
  private readonly positions:Float32Array[]=[];
  private readonly point=new THREE.Vector3();
  private readonly shadow:THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>;
  private readonly shadowTexture:THREE.CanvasTexture;
  private smokeTime=0;private dustTime=0;private trailTime=0;private trailCount=0;private tick=0;
  constructor(private readonly sampleGround:GroundSampler){
    this.root.name='Flight effects';this.root.add(this.smoke.mesh,this.dust.mesh);
    for(let i=0;i<2;i++){const g=new THREE.BufferGeometry();const p=new Float32Array(72*3);g.setAttribute('position',new THREE.BufferAttribute(p,3).setUsage(THREE.DynamicDrawUsage));g.setDrawRange(0,0);const l=new THREE.Line(g,new THREE.LineBasicMaterial({color:i?'#efc49d':'#fff1d1',transparent:true,opacity:.22,depthWrite:false}));l.frustumCulled=false;this.positions.push(p);this.trails.push(l);this.root.add(l);}
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const c=canvas.getContext('2d')!;const gradient=c.createRadialGradient(32,32,1,32,32,32);gradient.addColorStop(0,'rgba(0,0,0,.65)');gradient.addColorStop(.5,'rgba(0,0,0,.3)');gradient.addColorStop(1,'rgba(0,0,0,0)');c.fillStyle=gradient;c.fillRect(0,0,64,64);this.shadowTexture=new THREE.CanvasTexture(canvas);
    this.shadow=new THREE.Mesh(new THREE.PlaneGeometry(9,11),new THREE.MeshBasicMaterial({map:this.shadowTexture,color:'#1c281e',transparent:true,opacity:.24,depthWrite:false}));this.shadow.rotation.x=-Math.PI/2;this.root.add(this.shadow);
  }
  update(dt:number,state:FlightState,model:THREE.Group):void {
    this.tick++;this.smoke.update(dt);this.dust.update(dt);const rpm=state.rpm/2500;
    if(rpm>.16){this.smokeTime+=dt;const interval=1/(3+rpm*13);while(this.smokeTime>=interval){this.smokeTime-=interval;this.point.set(this.tick%2?1.12:-1.12,1.86,2.35).applyMatrix4(model.matrixWorld);this.smoke.emit(this.point.x,this.point.y,this.point.z,Math.sin(this.tick)*.28,.7,-.8,2.2,.38);}}
    if(state.grounded&&state.speed>8){this.dustTime+=dt;const interval=1/(2+state.speed/78*20);while(this.dustTime>=interval){this.dustTime-=interval;this.point.set(this.tick%2?1.76:-1.76,.12,.72).applyMatrix4(model.matrixWorld);this.dust.emit(this.point.x,this.point.y,this.point.z,Math.sin(this.tick)*.8,.32,0,2,.7);}}
    this.trailTime+=dt;
    if(state.altitude>7&&state.speed>18&&this.trailTime>=.075){this.trailTime=0;this.trailCount=Math.min(72,this.trailCount+1);for(let i=0;i<2;i++){const p=this.positions[i];p.copyWithin(3,0,p.length-3);this.point.set(i?5.8:-5.8,2.7,0).applyMatrix4(model.matrixWorld);p[0]=this.point.x;p[1]=this.point.y;p[2]=this.point.z;this.trails[i].geometry.attributes.position.needsUpdate=true;this.trails[i].geometry.setDrawRange(0,this.trailCount);}}
    for(const line of this.trails){line.visible=state.altitude>4&&state.speed>16;}
    this.shadow.visible=state.altitude<1.4;this.shadow.position.set(state.position.x,this.sampleGround(state.position.x,state.position.z)+.018,state.position.z);this.shadow.material.opacity=.28*(1-clamp(state.altitude/1.4));
  }
  reset():void {this.smoke.reset();this.dust.reset();this.trailCount=0;this.smokeTime=this.dustTime=this.trailTime=0;for(const l of this.trails)l.geometry.setDrawRange(0,0);}
  dispose():void {this.smoke.dispose();this.dust.dispose();for(const l of this.trails){l.geometry.dispose();(l.material as THREE.Material).dispose();}this.shadow.geometry.dispose();this.shadow.material.dispose();this.shadowTexture.dispose();this.root.removeFromParent();}
}
