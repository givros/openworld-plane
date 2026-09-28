import * as THREE from 'three';
import { registerExactShadowGeometryCooperatively, exactShadowIndexBytes, type ExactShadowIndex } from './ExactShadowGeometry';
import { registerStreamGeometryBounds } from './StreamGeometryBounds';
import { MainThreadWorkBudget } from './MainThreadWorkBudget';
import { registerDistanceDetailGeometry } from './DistanceDetailGeometry';
import type {
  StreamAttribute, StreamGeometry, StreamManifest, StreamResourceCacheInterface,
  StreamResourceOptions, StreamResourceStats,
} from './WorldStreamTypes';

interface Entry<T> {
  refs:number;
  controller:AbortController;
  promise:Promise<T>;
  value?:T;
  status:'pending'|'ready'|'failed';
  retired:boolean;
  dependencies:(()=>void)[];
}
type Scope = { signal:AbortSignal; own:(release:()=>void)=>void };
type CloseableImage = { width?:number;height?:number;close?:()=>void };
const cancelled=():DOMException=>new DOMException('Stream resource was released.','AbortError');
const arrays={Float32Array,Float64Array,Uint32Array,Int32Array,Uint16Array,Int16Array,Uint8Array,Int8Array,Uint8ClampedArray};

function view(buffer:ArrayBuffer,definition:Pick<StreamAttribute,'arrayType'|'byteOffset'|'bytes'>):THREE.TypedArray {
  const Type=arrays[definition.arrayType as keyof typeof arrays];
  if(!Type)throw new Error(`Unsupported exact attribute type: ${definition.arrayType}`);
  const {byteOffset,bytes}=definition;
  if(!Number.isInteger(byteOffset)||!Number.isInteger(bytes)||byteOffset<0||bytes<0||
    byteOffset%Type.BYTES_PER_ELEMENT||bytes%Type.BYTES_PER_ELEMENT||byteOffset+bytes>buffer.byteLength)
    throw new Error('Stream attribute byte range is invalid');
  return new Type(buffer,byteOffset,bytes/Type.BYTES_PER_ELEMENT);
}

/** Each acquire owns one reference, including rejected acquires; release it exactly once. */
export class StreamResourceCache implements StreamResourceCacheInterface {
  private readonly geometries=new Map<string,Entry<THREE.BufferGeometry>>();
  private readonly materials=new Map<number,Entry<THREE.MeshStandardMaterial>>();
  private readonly textures=new Map<number,Entry<THREE.Texture>>();
  private readonly images=new Map<string,Entry<CloseableImage>>();
  private readonly geometryDefinitions=new Map<number,StreamGeometry>();
  private readonly geometryKeys=new Map<number,string>();
  private readonly sharedGeometryDefinitions=new Map<string,StreamGeometry>();
  private readonly sharedGeometryIds=new Map<string,number[]>();
  private readonly materialDefinitions=new Map<number,Record<string,any>>();
  private readonly textureDefinitions=new Map<number,Record<string,any>>();
  private readonly imageDefinitions=new Map<string,Record<string,any>>();
  private disposed=false;
  private readonly shadowIndices=new Map<number,ExactShadowIndex>();
  private readonly preparationBudget:MainThreadWorkBudget;

  constructor(manifest:StreamManifest,private readonly options:StreamResourceOptions){
    this.preparationBudget=options.preparationBudget??new MainThreadWorkBudget();
    for(const entry of options.shadowIndices??[])this.shadowIndices.set(entry.geometryId,entry);
    for(const definition of manifest.geometries){
      this.define(this.geometryDefinitions,definition.id,definition);
      // Hash equality is necessary but not sufficient: identical bytes interpreted
      // with different attributes, draw ranges or groups must never share a draw.
      const attributes=Object.entries(definition.attributes).sort(([a],[b])=>a.localeCompare(b))
        .map(([name,a])=>[name,a.byteOffset,a.bytes,a.count,a.itemSize,a.arrayType,a.normalized,a.gpuType]);
      const index=definition.index;
      const key=JSON.stringify([definition.sha256,definition.bytes,attributes,
        [index.byteOffset,index.bytes,index.count,index.arrayType],definition.groups,definition.drawRange,definition.bounds,definition.boundingSphere]);
      this.geometryKeys.set(definition.id,key);
      if(!this.sharedGeometryDefinitions.has(key)){this.sharedGeometryDefinitions.set(key,definition);this.sharedGeometryIds.set(key,[]);}
      this.sharedGeometryIds.get(key)!.push(definition.id);
    }
    for(const definition of manifest.materials)this.define(this.materialDefinitions,definition.id,definition);
    for(const definition of manifest.textures)this.define(this.textureDefinitions,definition.id,definition);
    for(const definition of manifest.images)this.define(this.imageDefinitions,String(definition.id),definition);
  }

  private define<K,T>(map:Map<K,T>,id:K,value:T):void{
    if(map.has(id))throw new Error(`Duplicate stream resource: ${id}`);
    map.set(id,value);
  }
  private definition<K,T>(map:Map<K,T>,id:K):T{
    const value=map.get(id);if(!value)throw new Error(`Unknown stream resource: ${id}`);return value;
  }

  private acquire<K,T>(map:Map<K,Entry<T>>,id:K,load:(scope:Scope)=>Promise<T>,dispose:(value:T)=>void):Promise<T>{
    if(this.disposed)return Promise.reject(new Error('Stream resource cache is disposed'));
    const existing=map.get(id);
    if(existing){existing.refs++;return existing.promise;}
    const entry:Entry<T>={refs:1,controller:new AbortController(),promise:null as unknown as Promise<T>,status:'pending',retired:false,dependencies:[]};
    map.set(id,entry);
    entry.promise=Promise.resolve().then(async()=>{
      if(entry.retired)throw cancelled();
      const value=await load({signal:entry.controller.signal,own:release=>{
        if(entry.retired)release();else entry.dependencies.push(release);
      }});
      if(this.disposed||entry.retired||entry.refs===0||map.get(id)!==entry){dispose(value);throw cancelled();}
      entry.value=value;entry.status='ready';return value;
    }).catch(error=>{
      entry.status='failed';this.releaseDependencies(entry);
      // Keep a failed lease until its original callers release it. Otherwise a
      // delayed release(id) could decrement an unrelated retry of the same ID.
      throw error;
    });
    return entry.promise;
  }

  private releaseDependencies<T>(entry:Entry<T>):void{
    const dependencies=entry.dependencies.splice(0);
    for(const release of dependencies.reverse())release();
  }
  private retire<T>(entry:Entry<T>,dispose:(value:T)=>void):void{
    if(entry.retired)return;
    entry.retired=true;entry.controller.abort();
    if(entry.value!==undefined){dispose(entry.value);entry.value=undefined;}
    this.releaseDependencies(entry);
  }
  private release<K,T>(map:Map<K,Entry<T>>,id:K,dispose:(value:T)=>void):void{
    const entry=map.get(id);if(!entry)return;
    if(--entry.refs>0)return;
    map.delete(id);this.retire(entry,dispose);
  }

  acquireGeometry(id:number):Promise<THREE.BufferGeometry>{
    if(this.disposed)return Promise.reject(new Error('Stream resource cache is disposed'));
    const key=this.geometryKeys.get(id);
    if(key===undefined)return Promise.reject(new Error(`Unknown stream resource: ${id}`));
    return this.acquire(this.geometries,key,async({signal})=>{
      const definition=this.definition(this.sharedGeometryDefinitions,key);
      const binary=await this.options.readBinary(definition.url,signal);
      if(signal.aborted)throw cancelled();
      if(binary.byteLength!==definition.bytes)throw new Error(`Geometry ${id} byte length changed`);
      if(definition.bounds.length!==6||!definition.bounds.every(Number.isFinite)||
        definition.bounds.slice(0,3).some((minimum,axis)=>minimum>definition.bounds[axis+3])||
        !definition.boundingSphere.center.every(Number.isFinite)||!Number.isFinite(definition.boundingSphere.radius)||definition.boundingSphere.radius<0)
        throw new Error(`Geometry ${id} has invalid precomputed bounds`);
      const geometry=new THREE.BufferGeometry();
      try{
        for(const [name,attribute]of Object.entries(definition.attributes)){
          const array=view(binary,attribute);
          if(!Number.isInteger(attribute.count)||attribute.count<0||!Number.isInteger(attribute.itemSize)||attribute.itemSize<1||array.length!==attribute.count*attribute.itemSize)
            throw new Error(`Geometry ${id}/${name} attribute shape changed`);
          const buffer=new THREE.BufferAttribute(array,attribute.itemSize,attribute.normalized);
          if(attribute.gpuType!==THREE.FloatType&&attribute.gpuType!==THREE.IntType)throw new Error(`Geometry ${id}/${name} GPU attribute type changed`);
          buffer.gpuType=attribute.gpuType;geometry.setAttribute(name,buffer);
        }
        const index=view(binary,definition.index);
        if(!(index instanceof Uint8Array||index instanceof Uint16Array||index instanceof Uint32Array)||index.length!==definition.index.count)
          throw new Error(`Geometry ${id} index format changed`);
        geometry.setIndex(new THREE.BufferAttribute(index,1));
        geometry.name=definition.name;
        geometry.boundingBox=new THREE.Box3(new THREE.Vector3().fromArray(definition.bounds),new THREE.Vector3().fromArray(definition.bounds,3));
        geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3().fromArray(definition.boundingSphere.center),definition.boundingSphere.radius);
        for(const group of definition.groups)geometry.addGroup(group.start,group.count,group.materialIndex);
        geometry.setDrawRange(definition.drawRange.start,definition.drawRange.count??Infinity);
        geometry.userData={streamGeometryIds:[...this.sharedGeometryIds.get(key)!],sourceSha256:definition.sha256,streamBytes:binary.byteLength};
        registerStreamGeometryBounds(geometry);
        if(this.options.distanceDetail)registerDistanceDetailGeometry(geometry,definition.id,this.options.distanceDetail);
        const shadow=this.shadowIndices.get(definition.id);
        if(shadow&&shadow.sourceSha256===definition.sha256&&shadow.sourcePositionSha256===definition.attributes.position.sha256&&shadow.sourceIndexSha256===definition.index.sha256){
          try{
            const Type=shadow.arrayType==='Uint32Array'?Uint32Array:shadow.arrayType==='Uint16Array'?Uint16Array:shadow.arrayType==='Uint8Array'?Uint8Array:null;
            if(!Type||shadow.count!==definition.index.count||shadow.bytes!==shadow.count*Type.BYTES_PER_ELEMENT)throw new Error('Invalid exact shadow index metadata');
            const indexBinary=await this.options.readBinary(shadow.url,signal);
            if(signal.aborted)throw cancelled();
            if(indexBinary.byteLength!==shadow.bytes)throw new Error('Incomplete exact shadow index buffer');
            await registerExactShadowGeometryCooperatively(geometry,new Type(indexBinary),this.preparationBudget,signal);
          }catch(error){
            if(signal.aborted)throw cancelled();
            // Optional acceleration must not make the original landscape fail to
            // load. Its exact canonical shadow triangles remain the fallback.
            console.warn(`Exact shadow acceleration unavailable for ${definition.id}; using original indices.`,error);
          }
        }
        return geometry;
      }catch(error){geometry.dispose();throw error;}
    },geometry=>geometry.dispose());
  }
  releaseGeometry(id:number):void{const key=this.geometryKeys.get(id);if(key!==undefined)this.release(this.geometries,key,geometry=>geometry.dispose());}

  private acquireImage(id:string):Promise<CloseableImage>{
    return this.acquire(this.images,id,async({signal})=>{
      const definition=this.definition(this.imageDefinitions,id);
      if(this.options.loadImage)return this.options.loadImage(definition,signal);
      const binary=await this.options.readBinary(definition.url,signal);
      if(signal.aborted)throw cancelled();
      if(definition.bytes!==undefined&&binary.byteLength!==definition.bytes)throw new Error(`Image ${id} byte length changed`);
      return createImageBitmap(new Blob([binary],{type:definition.mimeType??'image/png'}),
        {premultiplyAlpha:'none',colorSpaceConversion:'none'});
    },image=>image.close?.());
  }
  private releaseImage(id:string):void{this.release(this.images,id,image=>image.close?.());}

  private acquireTexture(id:number):Promise<THREE.Texture>{
    return this.acquire(this.textures,id,async(scope)=>{
      const definition=this.definition(this.textureDefinitions,id),imageId=String(definition.image);
      const imagePromise=this.acquireImage(imageId);scope.own(()=>this.releaseImage(imageId));
      const image=await imagePromise;if(scope.signal.aborted)throw cancelled();
      const texture=new THREE.Texture(image);
      try{
        const target=texture as unknown as Record<string,any>;
        for(const [key,value]of Object.entries(definition)){
          if(['id','name','image','source','matrix','userData'].includes(key)||!(key in texture))continue;
          if(['offset','repeat','center'].includes(key))target[key].fromArray(value);
          else target[key]=value;
        }
        texture.name=definition.name??'';
        if(definition.matrix)texture.matrix.fromArray(definition.matrix);
        texture.userData={...(definition.userData??{}),streamTextureId:id,sourceImageId:imageId};
        texture.needsUpdate=true;return texture;
      }catch(error){texture.dispose();throw error;}
    },texture=>texture.dispose());
  }
  private releaseTexture(id:number):void{this.release(this.textures,id,texture=>texture.dispose());}

  acquireMaterial(id:number):Promise<THREE.Material>{
    return this.acquire(this.materials,id,async(scope)=>{
      const definition=this.definition(this.materialDefinitions,id);
      if(definition.type!==undefined&&definition.type!=='MeshStandardMaterial')throw new Error(`Unsupported source material ${definition.type}`);
      const textureIds=new Set<number>();
      for(const value of Object.values(definition))if(value&&typeof value==='object'&&'texture'in value)textureIds.add(value.texture);
      const textures=new Map<number,THREE.Texture>();
      await Promise.all([...textureIds].map(async textureId=>{
        const pending=this.acquireTexture(textureId);scope.own(()=>this.releaseTexture(textureId));
        textures.set(textureId,await pending);
      }));
      if(scope.signal.aborted)throw cancelled();
      const material=new THREE.MeshStandardMaterial();
      try{
        const target=material as unknown as Record<string,any>;
        for(const [key,value]of Object.entries(definition)){
          if(['id','type','uuid','version','userData'].includes(key)||key.startsWith('is')||!(key in material))continue;
          if(value&&typeof value==='object'&&'texture'in value){target[key]=textures.get(value.texture);continue;}
          if(target[key]?.isColor||target[key]?.isVector2||target[key]?.isVector3){target[key].fromArray(value);continue;}
          target[key]=value&&typeof value==='object'?structuredClone(value):value;
        }
        material.userData={...structuredClone(definition.userData??{}),streamMaterialId:id};
        return material;
      }catch(error){material.dispose();throw error;}
    },material=>material.dispose());
  }
  releaseMaterial(id:number):void{this.release(this.materials,id,material=>material.dispose());}

  get stats():StreamResourceStats{
    const ready=<T>(map:Map<unknown,Entry<T>>):number=>{let count=0;for(const entry of map.values())if(entry.status==='ready'&&!entry.retired)count++;return count;};
    let geometryBytes=0,pendingGeometries=0,shadowIndexBytes=0;
    for(const [key,entry]of this.geometries){if(entry.status==='ready'){geometryBytes+=this.sharedGeometryDefinitions.get(key)!.bytes;shadowIndexBytes+=exactShadowIndexBytes(entry.value!);}else if(entry.status==='pending')pendingGeometries++;}
    return{geometries:ready(this.geometries),materials:ready(this.materials),textures:ready(this.textures),images:ready(this.images),geometryBytes:geometryBytes+shadowIndexBytes,pendingGeometries,shadowIndexBytes};
  }
  dispose():void{
    if(this.disposed)return;this.disposed=true;
    for(const entry of this.materials.values())this.retire(entry,material=>material.dispose());this.materials.clear();
    for(const entry of this.geometries.values())this.retire(entry,geometry=>geometry.dispose());this.geometries.clear();
    for(const entry of this.textures.values())this.retire(entry,texture=>texture.dispose());this.textures.clear();
    for(const entry of this.images.values())this.retire(entry,image=>image.close?.());this.images.clear();
    this.geometryDefinitions.clear();this.geometryKeys.clear();this.sharedGeometryDefinitions.clear();this.sharedGeometryIds.clear();
    this.materialDefinitions.clear();this.textureDefinitions.clear();this.imageDefinitions.clear();
  }
}
