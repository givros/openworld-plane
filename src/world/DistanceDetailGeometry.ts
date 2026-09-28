import * as THREE from 'three';
import type { CanonicalInstanceSource } from './PassInstanceCuller';
import { disposeExactShadowVertices } from './reuseExactVertices';

interface DetailIndex {url:string;byteOffset:number;bytes:number;count:number;arrayType:string;sha256:string}
interface DetailLevelDefinition {level:number;triangles:number;errorAbsolute:number;index:DetailIndex}
interface DetailGeometryDefinition {geometryId:number;sourceSha256:string;levels:DetailLevelDefinition[]}
interface DetailManifest {version:number;complete:boolean;sourceManifestSha256:string;geometries:DetailGeometryDefinition[];buffer?:{url:string;bytes:number;sha256:string};indices?:{url:string;bytes:number;sha256:string}}
export interface DistanceDetailPack {definitions:Map<number,DetailGeometryDefinition>;binary:ArrayBuffer}
export interface DistanceDetailLevel {level:number;error:number;geometry:THREE.BufferGeometry}
const variants=new WeakMap<THREE.BufferGeometry,readonly DistanceDetailLevel[]>();
const emptyLevels:readonly DistanceDetailLevel[]=Object.freeze([]);
const shadowVariants=new WeakMap<THREE.BufferGeometry,readonly (THREE.BufferGeometry|undefined)[]>();
const digest=async(data:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),value=>value.toString(16).padStart(2,'0')).join('');

/** Derived index buffers are separate from every original authored asset. */
export async function loadDistanceDetailPack(sourceManifest:string,read:(url:string)=>Promise<Response>):Promise<DistanceDetailPack>{
  const manifest=await (await read('/environments/lod/manifest.json')).json() as DetailManifest;
  if(manifest.version!==1||!manifest.complete||!Array.isArray(manifest.geometries)||
    manifest.sourceManifestSha256!==await digest(new TextEncoder().encode(sourceManifest)))throw new Error('Distance detail pack does not match the source world');
  const buffer=manifest.buffer??manifest.indices;
  if(!buffer||!Number.isInteger(buffer.bytes)||buffer.bytes<0)throw new Error('Missing distance detail buffer');
  const binary=await(await read(buffer.url)).arrayBuffer();
  if(binary.byteLength!==buffer.bytes||await digest(binary)!==buffer.sha256)throw new Error('Distance detail buffer is incomplete');
  return{definitions:new Map(manifest.geometries.map(definition=>[definition.geometryId,definition])),binary};
}

export function registerDistanceDetailGeometry(source:THREE.BufferGeometry,id:number,pack:DistanceDetailPack):void{
  const definition=pack.definitions.get(id);
  if(!definition||definition.sourceSha256!==source.userData.sourceSha256)return;
  if(variants.has(source))throw new Error('Distance detail geometry already registered');
  const position=source.getAttribute('position');
  const levels:DistanceDetailLevel[]=[];
  try{
    for(const item of definition.levels){
      const index=item.index;
      if(!Number.isInteger(item.level)||item.level<=0||!Number.isFinite(item.errorAbsolute)||item.errorAbsolute<0||
        index.arrayType!=='Uint32Array'||!Number.isInteger(index.byteOffset)||index.byteOffset<0||index.byteOffset%4||
        !Number.isInteger(index.count)||index.count<3||index.count%3||index.bytes!==index.count*4||index.byteOffset+index.bytes>pack.binary.byteLength)
        throw new Error('Invalid distance detail index metadata');
      const array=new Uint32Array(pack.binary,index.byteOffset,index.count);
      for(const value of array)if(value>=position.count)throw new Error('Distance detail index exceeds source vertices');
      const geometry=new THREE.BufferGeometry();
      geometry.name=`${source.name} / distance ${item.level}`;
      for(const [name,attribute]of Object.entries(source.attributes))geometry.setAttribute(name,attribute);
      geometry.setIndex(new THREE.BufferAttribute(array,1));
      // Pack generation accepts only single-material complete index ranges.
      geometry.boundingBox=source.boundingBox;geometry.boundingSphere=source.boundingSphere;
      geometry.userData={distanceDetailLevel:item.level,sourceGeometry:source.id};
      levels.push({level:item.level,error:item.errorAbsolute,geometry});
    }
    levels.sort((a,b)=>a.level-b.level);
    variants.set(source,levels);
    const shadows:Array<THREE.BufferGeometry|undefined>=[undefined,undefined];
    for(let pass=2;pass<=4;pass++)for(const level of levels)if(level.level<=pass-1)shadows[pass]=level.geometry;
    shadowVariants.set(source,shadows);
    const release=()=>{variants.delete(source);shadowVariants.delete(source);for(const level of levels)disposeExactShadowVertices(level.geometry,source);source.removeEventListener('dispose',release);};
    source.addEventListener('dispose',release);
  }catch(error){for(const level of levels)disposeExactShadowVertices(level.geometry,source);throw error;}
}
export const distanceDetailLevels=(source:THREE.BufferGeometry):readonly DistanceDetailLevel[]=>variants.get(source)??emptyLevels;

/** Screen-error selection affects render proxies only, never source leases or bounds. */
export class DistanceDetailController{
  private readonly states=new WeakMap<THREE.InstancedMesh,{geometry:THREE.BufferGeometry;matrix:THREE.InstancedBufferAttribute;version:number;scale:number;level:number}>();
  private pixelsPerRadian=1;
  private readonly selectionOrigin=new THREE.Vector3();
  private selectionMargin=0;
  readonly statistics={originalBatches:0,detailBatches:0,levels:[0,0,0,0],pixelError:2,nearDistance:35};
  constructor(private readonly camera:THREE.PerspectiveCamera,readonly pixelError=2,readonly nearDistance=35){
    if(!Number.isFinite(pixelError)||pixelError<=0||!Number.isFinite(nearDistance)||nearDistance<0)throw new Error('Invalid distance detail policy');
    this.statistics.pixelError=pixelError;this.statistics.nearDistance=nearDistance;
  }
  beginFrame(height:number):void{
    this.pixelsPerRadian=height/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov)*.5));
    this.selectionOrigin.copy(this.camera.position);this.selectionMargin=0;
    this.statistics.originalBatches=0;this.statistics.detailBatches=0;this.statistics.levels.fill(0);
  }
  setSelectionView(origin:THREE.Vector3,pixelsPerRadian:number,margin:number):void{
    this.selectionOrigin.copy(origin);this.pixelsPerRadian=pixelsPerRadian;this.selectionMargin=margin;
  }
  readonly geometryForPass=(descriptor:CanonicalInstanceSource,passIndex:number):THREE.BufferGeometry|undefined=>{
    const source=descriptor.source;
    // Fixed detail per cascade keeps cached shadow geometry independent of camera
    // movement. The closest cascade retains the complete original geometry.
    if(passIndex>0){
      return shadowVariants.get(source.geometry)?.[passIndex];
    }
    const levels=distanceDetailLevels(source.geometry);
    if(!levels.length)return undefined;
    let state=this.states.get(source);
    if(!state||state.geometry!==source.geometry||state.matrix!==source.instanceMatrix||state.version!==source.instanceMatrix.version){
      const a=source.instanceMatrix.array;let scale=0;
      for(let i=0;i<source.count*16;i+=16)scale=Math.max(scale,Math.hypot(a[i],a[i+1],a[i+2]),Math.hypot(a[i+4],a[i+5],a[i+6]),Math.hypot(a[i+8],a[i+9],a[i+10]));
      state={geometry:source.geometry,matrix:source.instanceMatrix,version:source.instanceMatrix.version,scale,level:0};this.states.set(source,state);
    }
    const distance=descriptor.worldBox.distanceToPoint(this.selectionOrigin)-this.selectionMargin;
    const scale=state.scale*source.matrixWorld.getMaxScaleOnAxis();
    let selected:DistanceDetailLevel|undefined;
    if(distance>this.nearDistance){
      for(const candidate of levels){
        const margin=candidate.level<=state.level?1.12:.88;
        if(candidate.error*scale*this.pixelsPerRadian/Math.max(distance,.01)<=this.pixelError*margin)selected=candidate;
      }
    }
    state.level=selected?.level??0;
    this.statistics.levels[Math.min(3,state.level)]++;
    if(selected)this.statistics.detailBatches++;else this.statistics.originalBatches++;
    return selected?.geometry;
  };
}
