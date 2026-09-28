import * as THREE from 'three';
import { supportsExactShadowVertices, disposeExactShadowVertices } from './reuseExactVertices';
import type { MainThreadWorkBudget } from './MainThreadWorkBudget';
import { fetchWorldAsset } from './fetchWorldAsset';

export interface ExactShadowIndex {
  geometryId:number;sourceSha256:string;sourcePositionSha256:string;sourceIndexSha256:string;
  url:string;bytes:number;arrayType:string;count:number;sha256:string;
}
export interface ExactShadowIndexPack {version:1;complete:boolean;sourceManifestSha256:string;geometries:ExactShadowIndex[]}

/** Optional acceleration must never prevent the canonical world from loading. */
export async function loadExactShadowIndexPack(url:string,sourceManifest:string,signal?:AbortSignal):Promise<ExactShadowIndexPack|undefined>{
  try{
    const response=await fetchWorldAsset(url,{signal});
    if(!response.ok)return undefined;
    const candidate=await response.json() as ExactShadowIndexPack|null;
    if(!candidate||candidate.version!==1||candidate.complete!==true||!Array.isArray(candidate.geometries))return undefined;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sourceManifest));
    const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
    return candidate.sourceManifestSha256===hash?candidate:undefined;
  }catch(error){
    if(signal?.aborted||error instanceof DOMException&&error.name==='AbortError')throw error;
    console.warn('Optional shadow acceleration is unavailable; using original shadow geometry.',error);
    return undefined;
  }
}
interface Entry {
  geometry:THREE.BufferGeometry;position:THREE.BufferAttribute;index:THREE.BufferAttribute;
  positionArray:THREE.TypedArray;indexArray:THREE.TypedArray;positionVersion:number;indexVersion:number;bytes:number;
}
const entries=new WeakMap<THREE.BufferGeometry,Entry>();

/** Indices are generated and byte-verified offline. No hashing or vertex scans
 * run during flight; the source position GPU buffer is shared with beauty. */
export function registerExactShadowGeometry(source:THREE.BufferGeometry,array:Uint8Array|Uint16Array|Uint32Array):void {
  if(entries.has(source))throw new Error('Shadow acceleration is already registered');
  const position=source.getAttribute('position'),index=source.index;
  if(!(position instanceof THREE.BufferAttribute)||!index||array.length!==index.count)
    throw new Error('Exact shadow indices must preserve every source triangle');
  for(let slot=0;slot<array.length;slot++)if(array[slot]>=position.count)throw new Error('Shadow index is outside the source positions');
  registerCheckedShadowGeometry(source,array,position,index);
}

/** Validate large optional index buffers incrementally. The acceleration is not
 * exposed until the complete buffer is checked, and cancellation owns no GPU data. */
export async function registerExactShadowGeometryCooperatively(source:THREE.BufferGeometry,array:Uint8Array|Uint16Array|Uint32Array,budget:MainThreadWorkBudget,signal:AbortSignal):Promise<void>{
  const position=source.getAttribute('position'),index=source.index;
  if(!(position instanceof THREE.BufferAttribute)||!index||array.length!==index.count)
    throw new Error('Exact shadow indices must preserve every source triangle');
  const positionArray=position.array,indexArray=index.array,positionVersion=position.version,indexVersion=index.version;
  for(let start=0;start<array.length;start+=65536){
    let waiting;while((waiting=budget.checkpoint())){
      await waiting;if(signal.aborted)throw new DOMException('Stream resource was released.','AbortError');
    }
    if(signal.aborted)throw new DOMException('Stream resource was released.','AbortError');
    const began=performance.now(),end=Math.min(start+65536,array.length);
    for(let slot=start;slot<end;slot++)if(array[slot]>=position.count)throw new Error('Shadow index is outside the source positions');
    budget.charge(performance.now()-began);
    if(end<array.length)await Promise.resolve();
  }
  if(signal.aborted)throw new DOMException('Stream resource was released.','AbortError');
  if(source.getAttribute('position')!==position||source.index!==index||position.array!==positionArray||index.array!==indexArray||position.version!==positionVersion||index.version!==indexVersion)
    throw new Error('Source geometry changed while preparing shadow indices');
  registerCheckedShadowGeometry(source,array,position,index);
}

function registerCheckedShadowGeometry(source:THREE.BufferGeometry,array:Uint8Array|Uint16Array|Uint32Array,position:THREE.BufferAttribute,index:THREE.BufferAttribute):void{
  if(entries.has(source))throw new Error('Shadow acceleration is already registered');
  const geometry=new THREE.BufferGeometry();geometry.name=`${source.name} / exact shadow indices`;
  geometry.setAttribute('position',position);geometry.setIndex(new THREE.BufferAttribute(array,1));
  geometry.groups=source.groups;geometry.drawRange=source.drawRange;
  geometry.boundingBox=source.boundingBox;geometry.boundingSphere=source.boundingSphere;
  entries.set(source,{geometry,position,index,positionArray:position.array,indexArray:index.array,
    positionVersion:position.version,indexVersion:index.version,bytes:array.byteLength});
  const release=()=>{entries.delete(source);disposeExactShadowVertices(geometry,source);source.removeEventListener('dispose',release);};
  source.addEventListener('dispose',release);
}

export function exactShadowGeometry(source:THREE.Mesh):THREE.BufferGeometry|undefined {
  const original=source.geometry,entry=entries.get(original);
  if(!entry||!supportsExactShadowVertices(source)||original.getAttribute('position')!==entry.position||original.index!==entry.index||
    entry.position.array!==entry.positionArray||entry.index.array!==entry.indexArray||
    entry.position.version!==entry.positionVersion||entry.index.version!==entry.indexVersion)return undefined;
  entry.geometry.groups=original.groups;entry.geometry.drawRange=original.drawRange;
  return entry.geometry;
}
export function exactShadowIndexBytes(geometry:THREE.BufferGeometry):number{return entries.get(geometry)?.bytes??0;}
