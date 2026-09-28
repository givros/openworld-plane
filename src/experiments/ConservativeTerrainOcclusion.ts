import * as THREE from 'three';
import type { StreamBatch, StreamChunkData, StreamGeometry, StreamManifest } from '../world/WorldStreamTypes';

/** Experimental only: this module does not change any production visibility. */
export interface TerrainOccluderEvidence {
  readonly chunkId:string;
  readonly batch:StreamBatch;
  readonly geometry:StreamGeometry;
}

/** Identify authored rendered terrain, never the separate gameplay height field. */
export function findStreamTerrainOccluders(manifest:StreamManifest,chunk:StreamChunkData):TerrainOccluderEvidence[] {
  if(!manifest.complete||!chunk.global)return [];
  const geometries=new Map(manifest.geometries.map(item=>[item.id,item]));
  return chunk.batches.flatMap(batch=>{
    const geometry=geometries.get(batch.geometryId),sources=batch.userData.sourceObjects;
    if(batch.count!==1||batch.isInstancedMesh||!geometry||!/continuous-terrain$/.test(batch.name)||
      !/continuous-terrain$/.test(geometry.name)||!Array.isArray(sources)||sources.length!==1||
      typeof sources[0].semantic_id!=='string'||!sources[0].semantic_id.endsWith('/continuous-terrain'))return [];
    return [{chunkId:chunk.id,batch,geometry}];
  });
}

export interface TerrainOccluderSource {
  readonly mesh:THREE.Mesh;
  readonly evidence:TerrainOccluderEvidence;
}
export interface TerrainOcclusionOptions {
  width?:number;
  height?:number;
  /** Expand coverage tests in low-resolution cell coordinates. Never negative. */
  coverageGuardCells?:number;
  /** World/view-space separation needed in addition to the relative error margin. */
  depthMargin?:number;
  relativeDepthMargin?:number;
  /** Explicit allowlist for audited hooks that do not deform or discard terrain. */
  isMaterialCompatible?:(material:THREE.Material)=>boolean;
}
export interface TerrainOcclusionStatistics {
  sources:number;
  rejectedSources:number;
  triangles:number;
  projectedTriangles:number;
  nearOrFarRejectedTriangles:number;
  coverageTests:number;
  coveredCells:number;
  totalCells:number;
  coverageFraction:number;
  testedBounds:number;
  occludedBounds:number;
  uncoveredBounds:number;
  uncertainBounds:number;
  staleQueries:number;
}

interface SourceSnapshot {
  source:TerrainOccluderSource;
  geometry:THREE.BufferGeometry;
  position:THREE.BufferAttribute;
  index:THREE.BufferAttribute;
  positionArray:THREE.TypedArray;
  indexArray:THREE.TypedArray;
  positionVersion:number;
  indexVersion:number;
  matrix:number[];
  material:THREE.Material;
  materialVersion:number;
  compile:THREE.Material['onBeforeCompile'];
  programKey:THREE.Material['customProgramCacheKey'];
  parentChain:THREE.Object3D[];
  cameraLayers:number;
}

const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const sameArray=(a:ArrayLike<number>,b:ArrayLike<number>)=>{
  if(a.length!==b.length)return false;
  for(let index=0;index<a.length;index++)if(a[index]!==b[index])return false;
  return true;
};
const finiteMatrix=(matrix:THREE.Matrix4)=>matrix.elements.every(Number.isFinite);
const affineMatrix=(matrix:THREE.Matrix4)=>finiteMatrix(matrix)&&matrix.elements[3]===0&&matrix.elements[7]===0&&matrix.elements[11]===0&&matrix.elements[15]===1;

/**
 * Synchronous, camera-specific inner coverage rasterizer.
 *
 * A cell is occupied only when its expanded rectangle lies strictly inside ONE
 * original rendered triangle. The stored depth is that triangle's farthest
 * vertex, a conservative upper bound throughout its projected interior. Empty
 * cells, triangle seams and small distant triangles cause false visibility,
 * never permission to hide geometry. No union/sampling guess fills these holes.
 *
 * Bounds queries use their entire projected rectangle and their nearest corner
 * depth. All cells must be covered and strictly nearer, with numerical margins.
 * Queries validate camera and source snapshots synchronously, once per batch.
 * The caller must increment revision for changes to typed arrays made without
 * Three's normal needsUpdate/version contract. Do not use asynchronously.
 */
export class ConservativeTerrainOcclusion {
  readonly width:number;
  readonly height:number;
  readonly statistics:TerrainOcclusionStatistics;
  private readonly depths:Float64Array;
  private readonly options:Required<Omit<TerrainOcclusionOptions,'isMaterialCompatible'>>;
  private readonly materialCompatible:((material:THREE.Material)=>boolean)|undefined;
  private camera:THREE.PerspectiveCamera|null=null;
  private cameraWorld:number[]=[];
  private cameraView:number[]=[];
  private cameraProjection:number[]=[];
  private near=0;
  private far=0;
  private revision:unknown;
  private snapshots:SourceSnapshot[]=[];
  private valid=false;
  private readonly viewProjection=new THREE.Matrix4();
  private readonly modelView=new THREE.Matrix4();
  private readonly rasterBuffers=new WeakMap<THREE.BufferGeometry,{vertices:Float64Array;usable:Uint8Array}>();

  constructor(options:TerrainOcclusionOptions={}){
    const {width=160,height=90,coverageGuardCells=.05,depthMargin=.25,relativeDepthMargin=1e-4}=options;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>4_194_304||
      ![coverageGuardCells,depthMargin,relativeDepthMargin].every(value=>Number.isFinite(value)&&value>=0))
      throw new Error('Invalid conservative occlusion grid or margins');
    this.width=width;this.height=height;
    this.options={width,height,coverageGuardCells,depthMargin,relativeDepthMargin};
    this.materialCompatible=options.isMaterialCompatible;
    this.depths=new Float64Array(width*height);
    this.statistics={sources:0,rejectedSources:0,triangles:0,projectedTriangles:0,nearOrFarRejectedTriangles:0,
      coverageTests:0,coveredCells:0,totalCells:width*height,coverageFraction:0,testedBounds:0,occludedBounds:0,
      uncoveredBounds:0,uncertainBounds:0,staleQueries:0};
    this.depths.fill(Infinity);
  }

  private opaque(material:THREE.Material):boolean{
    if(!(material instanceof THREE.MeshStandardMaterial)||!material.visible||material.transparent||material.opacity!==1||
      material.side!==THREE.DoubleSide||material.alphaTest!==0||material.alphaHash||material.alphaToCoverage||
      material.alphaMap||material.map||material.displacementMap||material.wireframe||
      !material.depthWrite||!material.depthTest||material.depthFunc!==THREE.LessEqualDepth||
      material.polygonOffset||material.stencilWrite||material.clippingPlanes?.length||
      !material.colorWrite||(material.blending!==THREE.NormalBlending&&material.blending!==THREE.NoBlending)||
      material.onBeforeRender!==THREE.Material.prototype.onBeforeRender||
      (material instanceof THREE.MeshPhysicalMaterial&&material.transmission>0))return false;
    const ordinary=material.onBeforeCompile===THREE.Material.prototype.onBeforeCompile&&
      material.customProgramCacheKey===THREE.Material.prototype.customProgramCacheKey;
    return ordinary||this.materialCompatible?.(material)===true;
  }

  private snapshot(source:TerrainOccluderSource,camera:THREE.PerspectiveCamera):SourceSnapshot|null{
    const {mesh,evidence}=source,{geometry}=mesh,material=mesh.material;
    const {batch}=evidence,position=geometry.getAttribute('position'),index=geometry.index;
    if(mesh instanceof THREE.SkinnedMesh||Array.isArray(material)||!this.opaque(material)||
      mesh.name!==batch.name||mesh.userData.streamBatchId!==batch.id||mesh.userData.streamChunkId!==evidence.chunkId||
      !geometry.userData.streamGeometryIds?.includes(evidence.geometry.id)||geometry.userData.sourceSha256!==evidence.geometry.sha256||
      !(position instanceof THREE.BufferAttribute)||!(index instanceof THREE.BufferAttribute)||
      !(position.array instanceof Float32Array)||position.itemSize!==3||position.normalized||
      !(index.array instanceof Uint32Array||index.array instanceof Uint16Array||index.array instanceof Uint8Array)||
      index.itemSize!==1||index.normalized||index.count%3!==0||
      Object.keys(geometry.morphAttributes).length||geometry.groups.length||geometry.indirect||
      geometry.drawRange.start!==0||geometry.drawRange.count!==Infinity||
      index.count!==evidence.geometry.index.count||position.count!==evidence.geometry.attributes.position.count||
      !affineMatrix(mesh.matrixWorld)||(batch.layers&camera.layers.mask)===0||
      mesh.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender||mesh.onAfterRender!==THREE.Object3D.prototype.onAfterRender)return null;
    if(mesh instanceof THREE.InstancedMesh&&(mesh.count!==1||mesh.morphTexture||!sameArray(mesh.instanceMatrix.array,identity)))return null;
    const parentChain:THREE.Object3D[]=[];
    for(let object:THREE.Object3D|null=mesh;object;object=object.parent){if(!object.visible)return null;parentChain.push(object);}
    return {source,geometry,position,index,positionArray:position.array,indexArray:index.array,
      positionVersion:position.version,indexVersion:index.version,matrix:mesh.matrixWorld.elements.slice(),material,
      materialVersion:material.version,compile:material.onBeforeCompile,programKey:material.customProgramCacheKey,
      parentChain,cameraLayers:camera.layers.mask};
  }

  /** Camera/world matrices must already be current, exactly as for the render. */
  build(camera:THREE.PerspectiveCamera,sources:readonly TerrainOccluderSource[],revision:unknown):TerrainOcclusionStatistics{
    this.valid=false;this.depths.fill(Infinity);this.snapshots=[];
    for(const key of Object.keys(this.statistics) as (keyof TerrainOcclusionStatistics)[])this.statistics[key]=0;
    this.statistics.totalCells=this.depths.length;
    this.camera=camera;this.revision=revision;this.near=camera.near;this.far=camera.far;
    this.cameraWorld=camera.matrixWorld.elements.slice();this.cameraView=camera.matrixWorldInverse.elements.slice();
    this.cameraProjection=camera.projectionMatrix.elements.slice();
    const projection=camera.projectionMatrix.elements;
    if(!camera.isPerspectiveCamera||camera.coordinateSystem!==THREE.WebGLCoordinateSystem||camera.reversedDepth||
      !affineMatrix(camera.matrixWorld)||!affineMatrix(camera.matrixWorldInverse)||!finiteMatrix(camera.projectionMatrix)||
      projection[3]!==0||projection[7]!==0||projection[11]!==-1||projection[15]!==0||
      !(camera.near>0)||!Number.isFinite(camera.far)||camera.far<=camera.near)return this.statistics;
    this.viewProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    for(const source of sources){
      const snapshot=this.snapshot(source,camera);
      if(!snapshot){this.statistics.rejectedSources++;continue;}
      this.snapshots.push(snapshot);this.statistics.sources++;
      this.rasterize(snapshot,camera);
    }
    for(const depth of this.depths)if(Number.isFinite(depth))this.statistics.coveredCells++;
    this.statistics.coverageFraction=this.statistics.coveredCells/this.depths.length;
    this.valid=true;return this.statistics;
  }

  private rasterize(snapshot:SourceSnapshot,camera:THREE.PerspectiveCamera):void{
    const {positionArray:positions,indexArray:indices}=snapshot;
    this.modelView.multiplyMatrices(camera.matrixWorldInverse,snapshot.source.mesh.matrixWorld);
    const m=this.modelView.elements,p=camera.projectionMatrix.elements;
    let buffers=this.rasterBuffers.get(snapshot.geometry);
    if(!buffers||buffers.usable.length!==snapshot.position.count){
      buffers={vertices:new Float64Array(snapshot.position.count*3),usable:new Uint8Array(snapshot.position.count)};
      this.rasterBuffers.set(snapshot.geometry,buffers);
    }
    const {vertices,usable}=buffers;
    for(let vertex=0;vertex<usable.length;vertex++){
      const offset=vertex*3,x=positions[offset],y=positions[offset+1],z=positions[offset+2];
      const vx=m[0]*x+m[4]*y+m[8]*z+m[12],vy=m[1]*x+m[5]*y+m[9]*z+m[13],vz=m[2]*x+m[6]*y+m[10]*z+m[14];
      const depth=-vz,w=p[3]*vx+p[7]*vy+p[11]*vz+p[15];
      const sx=((p[0]*vx+p[4]*vy+p[8]*vz+p[12])/w*.5+.5)*this.width;
      const sy=((p[1]*vx+p[5]*vy+p[9]*vz+p[13])/w*.5+.5)*this.height;
      const clipDepth=(p[2]*vx+p[6]*vy+p[10]*vz+p[14])/w;
      vertices[offset]=sx;vertices[offset+1]=sy;vertices[offset+2]=depth;
      usable[vertex]=Number(w>0&&depth>this.near+this.options.depthMargin&&depth<this.far-this.options.depthMargin&&
        clipDepth> -1&&clipDepth<1&&Number.isFinite(sx)&&Number.isFinite(sy)&&Number.isFinite(depth));
    }
    for(let index=0;index<indices.length;index+=3){
      this.statistics.triangles++;
      const a=indices[index],b=indices[index+1],c=indices[index+2];
      if(!usable[a]||!usable[b]||!usable[c]){this.statistics.nearOrFarRejectedTriangles++;continue;}
      this.coverTriangle(vertices,a*3,b*3,c*3);
    }
  }

  private coverTriangle(vertices:Float64Array,a:number,b:number,c:number):void{
    const ax=vertices[a],ay=vertices[a+1],bx=vertices[b],by=vertices[b+1],cx=vertices[c],cy=vertices[c+1];
    const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    if(!Number.isFinite(area)||Math.abs(area)<1e-10)return;
    const x0=Math.max(0,Math.floor(Math.min(ax,bx,cx))),x1=Math.min(this.width-1,Math.ceil(Math.max(ax,bx,cx))-1);
    const y0=Math.max(0,Math.floor(Math.min(ay,by,cy))),y1=Math.min(this.height-1,Math.ceil(Math.max(ay,by,cy))-1);
    if(x0>x1||y0>y1)return;
    this.statistics.projectedTriangles++;
    const sign=area>0?1:-1,half=.5+this.options.coverageGuardCells;
    const maxDepth=Math.max(vertices[a+2],vertices[b+2],vertices[c+2]);
    const depth=maxDepth+this.options.depthMargin+Math.abs(maxDepth)*this.options.relativeDepthMargin;
    const a0=(ay-by)*sign,b0=(bx-ax)*sign,c0=(ax*by-ay*bx)*sign;
    const a1=(by-cy)*sign,b1=(cx-bx)*sign,c1=(bx*cy-by*cx)*sign;
    const a2=(cy-ay)*sign,b2=(ax-cx)*sign,c2=(cx*ay-cy*ax)*sign;
    const e0=half*(Math.abs(a0)+Math.abs(b0))+1e-10*(1+Math.abs(a0)+Math.abs(b0));
    const e1=half*(Math.abs(a1)+Math.abs(b1))+1e-10*(1+Math.abs(a1)+Math.abs(b1));
    const e2=half*(Math.abs(a2)+Math.abs(b2))+1e-10*(1+Math.abs(a2)+Math.abs(b2));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      this.statistics.coverageTests++;
      // Minimum signed edge equation over the entire expanded cell rectangle.
      const px=x+.5,py=y+.5;
      const covered=a0*px+b0*py+c0>e0&&a1*px+b1*py+c1>e1&&a2*px+b2*py+c2>e2;
      if(covered){const offset=y*this.width+x;this.depths[offset]=Math.min(this.depths[offset],depth);}
    }
  }

  private current(camera:THREE.PerspectiveCamera,revision:unknown):boolean{
    if(!this.valid||camera!==this.camera||!Object.is(revision,this.revision)||camera.near!==this.near||camera.far!==this.far||
      camera.coordinateSystem!==THREE.WebGLCoordinateSystem||camera.reversedDepth||
      !sameArray(camera.matrixWorld.elements,this.cameraWorld)||!sameArray(camera.matrixWorldInverse.elements,this.cameraView)||
      !sameArray(camera.projectionMatrix.elements,this.cameraProjection))return false;
    for(const prior of this.snapshots){
      const next=this.snapshot(prior.source,camera);
      if(!next||next.geometry!==prior.geometry||next.position!==prior.position||next.index!==prior.index||
        next.positionArray!==prior.positionArray||next.indexArray!==prior.indexArray||next.positionVersion!==prior.positionVersion||
        next.indexVersion!==prior.indexVersion||next.material!==prior.material||next.materialVersion!==prior.materialVersion||
        next.compile!==prior.compile||next.programKey!==prior.programKey||next.cameraLayers!==prior.cameraLayers||
        !sameArray(next.matrix,prior.matrix)||next.parentChain.length!==prior.parentChain.length||
        next.parentChain.some((object,index)=>object!==prior.parentChain[index]))return false;
    }
    return true;
  }

  /** 1 means definitely terrain-occluded; 0 means keep visible. No async work. */
  testBoxes(boxes:readonly THREE.Box3[],camera:THREE.PerspectiveCamera,revision:unknown,result=new Uint8Array(boxes.length)):Uint8Array{
    if(result.length!==boxes.length)throw new Error('Occlusion output length must match bounds count');
    result.fill(0);
    if(!this.current(camera,revision)){this.statistics.staleQueries+=boxes.length;return result;}
    for(let index=0;index<boxes.length;index++)result[index]=Number(this.occluded(boxes[index]));
    return result;
  }

  private occluded(box:THREE.Box3):boolean{
    this.statistics.testedBounds++;
    if(box.isEmpty()||!Number.isFinite(box.min.x)||!Number.isFinite(box.min.y)||!Number.isFinite(box.min.z)||
      !Number.isFinite(box.max.x)||!Number.isFinite(box.max.y)||!Number.isFinite(box.max.z)){
      this.statistics.uncertainBounds++;return false;
    }
    const v=this.cameraView,p=this.viewProjection.elements;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,minDepth=Infinity;
    for(let corner=0;corner<8;corner++){
      const x=corner&1?box.max.x:box.min.x,y=corner&2?box.max.y:box.min.y,z=corner&4?box.max.z:box.min.z;
      const depth=-(v[2]*x+v[6]*y+v[10]*z+v[14]),w=p[3]*x+p[7]*y+p[11]*z+p[15];
      const sx=((p[0]*x+p[4]*y+p[8]*z+p[12])/w*.5+.5)*this.width;
      const sy=((p[1]*x+p[5]*y+p[9]*z+p[13])/w*.5+.5)*this.height;
      const clipDepth=(p[2]*x+p[6]*y+p[10]*z+p[14])/w;
      if(!(w>0)||!Number.isFinite(sx)||!Number.isFinite(sy)||!Number.isFinite(depth)||
        !(clipDepth> -1&&clipDepth<1)||
        depth<=this.near+this.options.depthMargin||depth>=this.far-this.options.depthMargin){this.statistics.uncertainBounds++;return false;}
      minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);minDepth=Math.min(minDepth,depth);
    }
    const guard=this.options.coverageGuardCells;
    minX-=guard;minY-=guard;maxX+=guard;maxY+=guard;
    // Leave partly off-screen bounds to the established frustum selector.
    if(minX<0||minY<0||maxX>=this.width||maxY>=this.height){this.statistics.uncertainBounds++;return false;}
    const x0=Math.floor(minX),x1=Math.floor(maxX),y0=Math.floor(minY),y1=Math.floor(maxY);
    const limit=minDepth-this.options.depthMargin-Math.abs(minDepth)*this.options.relativeDepthMargin;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(!(this.depths[y*this.width+x]<limit)){
      this.statistics.uncoveredBounds++;return false;
    }
    this.statistics.occludedBounds++;return true;
  }
}
