import type * as THREE from 'three';
import type { ExactShadowIndex } from './ExactShadowGeometry';
import type { MainThreadWorkBudget } from './MainThreadWorkBudget';
import type { DistanceDetailPack } from './DistanceDetailGeometry';

export type StreamBounds = [number, number, number, number, number, number];
export interface StreamAttribute { byteOffset:number;bytes:number;count:number;itemSize:number;arrayType:string;normalized:boolean;gpuType:number;sha256:string }
export interface StreamGeometry {
  id:number;name:string;url:string;bytes:number;sha256:string;attributes:Record<string,StreamAttribute>;
  index:{byteOffset:number;bytes:number;count:number;arrayType:string;sha256:string};
  bounds:StreamBounds;boundingSphere:{center:[number,number,number];radius:number};triangles:number;
  groups:{start:number;count:number;materialIndex:number}[];drawRange:{start:number;count:number|null};
}
export interface StreamChunkDefinition {
  id:string;biomeId:string;global:boolean;bounds:StreamBounds;url:string;metadataBytes:number;matrixBytes:number;
  batches:number;sourceObjects:number;triangles:number;placements:number;geometryIds:number[];materialIds:number[];
}
export interface StreamBatch {
  id:number;name:string;geometryId:number;materialId:number;count:number;isInstancedMesh:boolean;modelMatrix:number[];
  renderOrder:number;layers:number;castShadow:boolean;receiveShadow:boolean;matrixOffset:number;
  bounds:StreamBounds;localBounds:StreamBounds;boundingSphere:{center:[number,number,number];radius:number};
  userData:Record<string,any>;sourceObjects:number;triangles:number;
}
export interface StreamChunkData {
  version:1;id:string;biomeId:string;global:boolean;bounds:StreamBounds;
  matrices:{url:string;bytes:number;sha256:string};batches:StreamBatch[];
}
export interface StreamManifest {
  version:1;complete:boolean;cellSize:number;sourceManifestSha256:string;
  sourceInputs:{id:string;file:string;bytes:number;sha256:string}[];
  sourceObjects:number;placements:number;triangles:number;uniqueTriangles:number;uniqueGeometries:number;renderBatches:number;
  geometries:StreamGeometry[];chunks:StreamChunkDefinition[];
  materials:Record<string,any>[];textures:Record<string,any>[];images:Record<string,any>[];
}
export interface StreamResourceStats { geometries:number;materials:number;textures:number;images:number;geometryBytes:number;pendingGeometries:number;shadowIndexBytes?:number }
export interface StreamResourceCacheInterface {
  acquireGeometry(id:number):Promise<THREE.BufferGeometry>;releaseGeometry(id:number):void;
  acquireMaterial(id:number):Promise<THREE.Material>;releaseMaterial(id:number):void;
  readonly stats:StreamResourceStats;dispose():void;
}
export interface StreamResourceOptions {
  distanceDetail?:DistanceDetailPack;
  preparationBudget?:MainThreadWorkBudget;
  shadowIndices?:readonly ExactShadowIndex[];
  readBinary:(url:string,signal?:AbortSignal)=>Promise<ArrayBuffer>;
  loadImage?:(definition:Record<string,any>,signal?:AbortSignal)=>Promise<any>;
}
export interface WorldStreamingView {
  position:{x:number;y:number;z:number};velocity?:{x:number;y:number;z:number};forward?:{x:number;y:number;z:number};
  frustum?:THREE.Frustum;
  altitude:number;viewDistance?:number;baseDistance?:number;
}
export interface WorldResidencyChange { added:THREE.Mesh[];removed:THREE.Mesh[];materials:THREE.Material[];visibilityChanged?:boolean }
