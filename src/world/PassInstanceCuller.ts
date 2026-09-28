import * as THREE from 'three';
import { exactShadowGeometry } from './ExactShadowGeometry';
import { createOrthographicShadowDepth, supportsOrthographicShadowDepth } from '../systems/OrthographicShadowDepth';
import { copyStreamGeometryBounds } from './StreamGeometryBounds';
import type { StaticStreamSourceLease } from './ImmutableStreamSources';
import { CompactRenderChildren } from '../core/CompactRenderChildren';

/** A conservative convex volume. Coefficients are read on every prepare call. */
export interface InstanceClipVolume {
  readonly planes: readonly THREE.Plane[];
  readonly empty?: boolean;
  readonly enabled?: boolean;
}

/** User-selected visible range; complete intersecting instance bounds are retained. */
export interface InstanceViewDistance {
  readonly origin: THREE.Vector3;
  readonly distance: number;
}

export interface InstanceShadowPass {
  readonly light: THREE.DirectionalLight;
  readonly frustum: THREE.Frustum;
  /** Preserve an existing conservative whole-source gate without tightening it per instance. */
  readonly sourceFilter?: (source: THREE.InstancedMesh) => boolean;
  /** Only supply a volume proven safe for individual instances, including filter support. */
  readonly casterVolume?: InstanceClipVolume;
}

export interface CanonicalInstanceSource {
  /** Authoritative complete arrays, identities and metadata; never compacted. */
  readonly source: THREE.InstancedMesh;
  /** Captured before integration suppresses source drawing with layers.mask = 0. */
  readonly originalLayerMask: number;
  readonly count: number;
  readonly revision: number;
  readonly localBox: THREE.Box3;
  readonly localSphere: THREE.Sphere;
  readonly worldBox: THREE.Box3;
  readonly worldSphere: THREE.Sphere;
}

export interface InstancePassStatistics {
  selected: number;
  /** Nonempty selected batches, including cached selections while adapter is disabled. */
  activeBatches: number;
  batchRejected: number;
  batchAccepted: number;
  boundsTests: number;
  reusedSelections: number;
  /** Nonempty batches whose exact attribute sequence changed and needs upload. */
  uploadedSelections: number;
  /** Nonempty batches retaining the same uploaded IDs and canonical revision. */
  reusedUploads: number;
  cellTests: number;
  cellRejected: number;
}

export interface InstanceCullingOptions {
  /** Explicit allowlist for known static CSM/fog hooks; check captured function identities. */
  isMaterialCompatible?: (material: THREE.Material, source: THREE.InstancedMesh) => boolean;
  /** Explicit owner contract for fixed instance storage/count, bounds and callbacks. */
  isImmutableSource?: (source: THREE.InstancedMesh) => boolean;
  /** Strong owner lease covering source presentation and shared resource content. */
  getStaticSourceLease?: (source: THREE.InstancedMesh) => StaticStreamSourceLease | undefined;
  /** Global membership generation. Without it, lookups retain their live behavior. */
  getStaticSourceLeaseRevision?: () => number;
  /** Preserve native ordinary-mesh camera-frustum semantics for identity wrappers. */
  isFrustumOnlySource?: (source: THREE.InstancedMesh) => boolean;
}

/** Same immutable batch is consumed independently by every cached light. */
export interface ShadowContentChanges {
  readonly fromRevision:number;
  readonly revision:number;
  readonly full:boolean;
  readonly bounds:readonly THREE.Box3[];
}

interface OpaqueSortItem {
  id: number;
  object: THREE.Object3D;
  groupOrder: number;
  renderOrder: number;
  material: THREE.Material;
  materialVariant?: number;
  z: number;
}

interface GeometryState {
  attributes: unknown[];
  arrays: unknown[];
  versions: number[];
  box: THREE.Box3;
  sphere: THREE.Sphere;
  revision: number;
  validationFrame: number;
}
interface MaterialValidation {
  frame: number;
  unsupported: boolean;
  hooksReason?: string;
  customHooks: boolean;
  displacement: number;
}

/** Shared resources are checked once in each synchronous prepare, never across frames. */
class PrepareValidation {
  frame = 0;
  private readonly geometries = new WeakMap<THREE.BufferGeometry, { frame: number; reason?: string }>();
  private readonly materials = new WeakMap<THREE.Material, MaterialValidation>();

  geometry(geometry: THREE.BufferGeometry): string | undefined {
    let entry = this.geometries.get(geometry);
    if (entry?.frame === this.frame) return entry.reason;
    const reason = unsupportedGeometry(geometry);
    if (entry) { entry.frame = this.frame; entry.reason = reason; }
    else { entry = { frame: this.frame, reason }; this.geometries.set(geometry, entry); }
    return reason;
  }

  material(material: THREE.Material): MaterialValidation {
    let entry = this.materials.get(material);
    if (entry?.frame === this.frame) return entry;
    if (!entry) {
      entry = { frame: -1, unsupported: false, customHooks: false, displacement: 0 };
      this.materials.set(material, entry);
    }
    entry.frame = this.frame;
    entry.unsupported = unsupportedMaterial(material);
    entry.hooksReason = material instanceof THREE.ShaderMaterial || material.onBeforeRender !== THREE.Material.prototype.onBeforeRender
      ? 'custom material callbacks/shaders need an explicit adapter' : undefined;
    entry.customHooks = material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile || material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
    entry.displacement = materialDisplacement(material);
    return entry;
  }
}
interface TreeNode {
  /** Center and half extents; bounds only, never replacement draw geometry. */
  bounds: Float64Array;
  indices?: Uint32Array;
  left?: TreeNode;
  right?: TreeNode;
}
interface DrawState {
  proxy: THREE.InstancedMesh;
  indices: Uint32Array;
  uploadedIndices: Uint32Array;
  uploadedSelected: number;
  uploadedRevision: number;
  selected: number;
  volume?: CompiledVolume;
  revision: number;
  presentationRevision: number;
  coarseSelection?:boolean;
  /** Present only while indices contain the complete canonical identity prefix. */
  identityCount?:number;
  uploadedIdentityCount?:number;
  trustedBinding?:{revision:number;sourceRevision:number;renderRevision:number;geometry:THREE.BufferGeometry;depth:THREE.Material|undefined;distance:THREE.Material|undefined};
  region?: DrawState;
  regionOrderParent?: THREE.Object3D;
}

/** Every pass follows the same property layout, including dormant and regional
 * draws. Conditional field insertion otherwise makes the hot selection loop
 * inspect many different object shapes despite identical rendering semantics.
 */
function createDrawState(proxy:THREE.InstancedMesh,capacity:number):DrawState {
  return {proxy,indices:new Uint32Array(capacity),uploadedIndices:new Uint32Array(capacity),
    uploadedSelected:-1,uploadedRevision:-1,selected:0,volume:undefined,revision:-1,presentationRevision:-1,
    coarseSelection:undefined,identityCount:undefined,uploadedIdentityCount:undefined,trustedBinding:undefined,
    region:undefined,regionOrderParent:undefined};
}
interface ShadowContentSnapshot { frame:number; values:unknown[]; cursor:number; changed:boolean; }
interface StaticLeaseAnchorState {
  frame:number;revision:number;values:unknown[];visible:boolean;groupOrder:number;
}
interface StaticLeaseSector {
  lease:StaticStreamSourceLease;sources:Set<SourceState>;force:boolean;
  preparedAnchorRevision?:number;preparedShadowTracking?:boolean;
}
interface SourceState {
  registrationOrder:number;
  descriptor: CanonicalInstanceSource;
  capacity: number;
  count: number;
  revision: number;
  bindingRevision:number;
  geometry?: THREE.BufferGeometry;
  geometryRevision: number;
  matrixAttribute?: THREE.InstancedBufferAttribute;
  matrixArray?: ArrayLike<number>;
  matrixVersion: number;
  colorAttribute?: THREE.InstancedBufferAttribute | null;
  colorArray?: ArrayLike<number>;
  colorVersion: number;
  worldMatrix: THREE.Matrix4;
  displacement: number;
  sortCenter?: THREE.Vector3;
  matrices: Float32Array;
  bounds: Float64Array;
  tree?: TreeNode;
  draws: DrawState[];
  cell?: SpatialCell;
  shadowContent?: ShadowContentSnapshot;
  shadowVisible:boolean;
  resourceBindings?: {geometry:THREE.BufferGeometry;material:THREE.Material|THREE.Material[];depth:THREE.Material|undefined;distance:THREE.Material|undefined};
  immutableValidated?:boolean;
  drawsInactive?:boolean;
  staticLease?:StaticStreamSourceLease;
  staticSector?:StaticLeaseSector;
  staticAnchor?:StaticLeaseAnchorState;
  preparedStaticLease?:StaticStreamSourceLease;
  staticVisible?:boolean;
}
interface SpatialCell {
  key: string;
  sources: Set<SourceState>;
  bounds: THREE.Box3;
  dirty: boolean;
  volumes: (CompiledVolume | undefined)[];
  classifications: number[];
  allPreparedPassesRejected?:boolean;
  frustumOnlyVolume?:CompiledVolume;
  frustumOnlyClassification?:number;
  drawsInactive?:boolean;
  /** Nonempty ordinary draws from the last visit; beauty occupies bit zero. */
  activePassMask:number;
}
interface CompiledVolume {
  /** x, y, z, constant, absolute normal xyz, tolerance; repeated per plane. */
  planes: Float64Array;
  empty: boolean;
  key: string;
  distance?: readonly [number, number, number, number];
}
type NativeShadowRender = (lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => void;
type ShadowState = Pick<THREE.WebGLRenderer['shadowMap'], 'enabled' | 'autoUpdate' | 'needsUpdate' | 'type'>;
export type ShadowPassDispatcher=(index:number,light:THREE.DirectionalLight,group:THREE.Group,drawNative:()=>void)=>void;

const proxyTag = 'passInstanceProxy';
const boundsTolerance = 1e-6;
const treeLeafSize = 16;
const shadowMaterialFields=['version','visible','opacity','side','shadowSide','transparent','alphaTest','alphaHash','alphaToCoverage',
  'depthTest','depthWrite','depthFunc','polygonOffset','polygonOffsetFactor','polygonOffsetUnits','clipIntersection','clipShadows',
  'displacementScale','displacementBias','onBeforeCompile','customProgramCacheKey'] as const;
function shadowSnapshot():ShadowContentSnapshot {return {frame:-1,values:[],cursor:0,changed:false};}
function observeShadowValue(snapshot:ShadowContentSnapshot,value:unknown):void {
  if(!Object.is(snapshot.values[snapshot.cursor],value))snapshot.changed=true;
  snapshot.values[snapshot.cursor++]=value;
}

export function isPassInstanceProxy(object: THREE.Object3D): boolean {
  return object.userData[proxyTag] === true;
}

/** Selection policy affects work only: unselected batches remain fully rendered. */
export function isInstanceCullingCandidate(source: THREE.Object3D, minimumTriangles: number, minimumInstances = 2, options: InstanceCullingOptions = {}): source is THREE.InstancedMesh {
  if (!(source instanceof THREE.InstancedMesh) || source.count < minimumInstances || unsupportedReason(source, options)) return false;
  const triangles = (source.geometry.index?.count ?? source.geometry.getAttribute('position')?.count ?? 0) / 3;
  return triangles >= minimumTriangles;
}

function unsupportedGeometry(geometry: THREE.BufferGeometry): string | undefined {
  if (!geometry.getAttribute('position')) return 'position attribute is missing';
  if (geometry instanceof THREE.InstancedBufferGeometry) return 'geometry-owned instanced attributes require matching slot compaction';
  for (const name in geometry.attributes) {
    if (!Object.hasOwn(geometry.attributes, name)) continue;
    const attribute = geometry.attributes[name];
    if (attribute instanceof THREE.InstancedBufferAttribute || ('data' in attribute && attribute.data instanceof THREE.InstancedInterleavedBuffer)) return 'geometry-owned instanced attributes require matching slot compaction';
  }
  const morphAttributes = geometry.morphAttributes as Record<string, (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[] | undefined>;
  for (const name in morphAttributes) if (Object.hasOwn(morphAttributes, name) && morphAttributes[name]?.length) return 'morph geometry needs a separate deformation bounds contract';
  return undefined;
}

function unsupportedReason(source: THREE.InstancedMesh, options: InstanceCullingOptions, validation?: PrepareValidation): string | undefined {
  const geometryReason = validation ? validation.geometry(source.geometry) : unsupportedGeometry(source.geometry);
  if (geometryReason) return geometryReason;
  if (source.morphTexture) return 'per-instance morph targets are unsupported';
  if (!(source.instanceMatrix.array instanceof Float32Array)) return 'instance matrices must use Float32Array';
  if (source.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || source.onAfterRender !== THREE.Object3D.prototype.onAfterRender ||
      source.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow || source.onAfterShadow !== THREE.Object3D.prototype.onAfterShadow) return 'object render callbacks need an explicit proxy adapter';
  if (source.raycast !== THREE.InstancedMesh.prototype.raycast) return 'custom raycasting needs an explicit proxy adapter';
  return unsupportedSourceMaterials(source,options,validation);
}

function unsupportedSourceMaterials(source:THREE.InstancedMesh,options:InstanceCullingOptions,validation?:PrepareValidation):string|undefined {
  const materials = source.material;
  if (Array.isArray(materials)) {
    for (let index = 0; index < materials.length; index++) if (index in materials && (validation ? validation.material(materials[index]).unsupported : unsupportedMaterial(materials[index]))) return 'transparent, transmissive or shader materials need a separate ordering/deformation contract';
    for (const material of materials) { const reason = unsupportedHooks(material, source, options, validation); if (reason) return reason; }
  } else {
    if (validation ? validation.material(materials).unsupported : unsupportedMaterial(materials)) return 'transparent, transmissive or shader materials need a separate ordering/deformation contract';
    const reason = unsupportedHooks(materials, source, options, validation); if (reason) return reason;
  }
  return unsupportedHooks(source.customDepthMaterial, source, options, validation) ?? unsupportedHooks(source.customDistanceMaterial, source, options, validation);
}

function unsupportedHooks(material: THREE.Material | undefined, source: THREE.InstancedMesh, options: InstanceCullingOptions, validation?: PrepareValidation): string | undefined {
  if (!material) return undefined;
  if (validation) {
    const entry = validation.material(material);
    if (entry.hooksReason) return entry.hooksReason;
    // The allowlist can depend on the source; never share its result across batches.
    if (entry.customHooks && !options.isMaterialCompatible?.(material, source)) return 'custom material hooks need an explicit compatibility allowlist';
    return undefined;
  }
  if (material instanceof THREE.ShaderMaterial || material.onBeforeRender !== THREE.Material.prototype.onBeforeRender) return 'custom material callbacks/shaders need an explicit adapter';
  if ((material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile || material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) && !options.isMaterialCompatible?.(material, source)) return 'custom material hooks need an explicit compatibility allowlist';
  return undefined;
}

function unsupportedMaterial(material: THREE.Material): boolean {
  return material.transparent || material.blending !== THREE.NormalBlending || material instanceof THREE.ShaderMaterial ||
    (material as THREE.MeshPhysicalMaterial).transmission > 0;
}

function materialDisplacement(material: THREE.Material): number {
  const surface = material as THREE.MeshStandardMaterial;
  return surface.displacementMap ? Math.abs(surface.displacementScale) + Math.abs(surface.displacementBias) : 0;
}

function displacementPadding(source: THREE.InstancedMesh, validation?: PrepareValidation): number {
  const materials = source.material;
  if (!Array.isArray(materials)) return validation ? validation.material(materials).displacement : materialDisplacement(materials);
  let padding = 0;
  for (const material of materials) padding = Math.max(padding, validation ? validation.material(material).displacement : materialDisplacement(material));
  return padding;
}

/** Safe spectral-norm upper bound, including shear from nested nonuniform scales. */
function maximumStretch(matrix: THREE.Matrix4): number {
  const e = matrix.elements;
  const aa = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  const bb = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
  const cc = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
  const ab = Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]);
  const ac = Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]);
  const bc = Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]);
  return Math.sqrt(Math.max(aa + ab + ac, bb + ab + bc, cc + ac + bc));
}

function renderScene(object: THREE.Object3D): THREE.Scene | undefined {
  while (object.parent) object = object.parent;
  return object instanceof THREE.Scene ? object : undefined;
}

function visibleInSourceGraph(source: THREE.Object3D, scene: THREE.Scene): boolean {
  for (let object: THREE.Object3D | null = source; object; object = object.parent) {
    if (!object.visible) return false;
    if (object === scene) return true;
  }
  return false;
}

function inheritedGroupOrder(source: THREE.Object3D, cameraLayerMask: number): number {
  for (let object = source.parent; object; object = object.parent) if (object instanceof THREE.Group && (object.layers.mask & cameraLayerMask) !== 0) return object.renderOrder;
  return 0;
}

function compileVolume(frustum: THREE.Frustum, extra?: InstanceClipVolume, view?: InstanceViewDistance): CompiledVolume {
  const planes: number[] = [];
  const enabled = extra?.enabled !== false;
  for (const plane of [...frustum.planes, ...(enabled ? extra?.planes ?? [] : [])]) {
    const { x, y, z } = plane.normal;
    if (![x, y, z, plane.constant].every(Number.isFinite)) throw new Error('Culling planes must be finite');
    // These exact factors are shared by every AABB test in this pass.
    planes.push(x, y, z, plane.constant, Math.abs(x), Math.abs(y), Math.abs(z), boundsTolerance * Math.hypot(x, y, z));
  }
  const empty = enabled && extra?.empty === true;
  let distance: CompiledVolume['distance'];
  if (view && view.distance !== Infinity) {
    if (!Number.isFinite(view.distance) || view.distance <= 0 || !view.origin.toArray().every(Number.isFinite)) throw new Error('Visible range and origin must be finite and positive');
    distance = [view.origin.x, view.origin.y, view.origin.z, view.distance];
  }
  return { planes: new Float64Array(planes), empty, distance, key: `${empty ? 1 : 0}:${planes.join(',')}|${distance?.join(',') ?? ''}` };
}

/** -1 outside, 0 crossing, 1 wholly inside. Exact plane support of a world AABB. */
function classify(volume: CompiledVolume, x: number, y: number, z: number, hx: number, hy: number, hz: number): number {
  if (volume.empty) return -1;
  let inside = true;
  if (volume.distance) {
    const [ox, oy, oz, radius] = volume.distance;
    const dx = Math.abs(x - ox), dy = Math.abs(y - oy), dz = Math.abs(z - oz);
    const nx = Math.max(0, dx - hx), ny = Math.max(0, dy - hy), nz = Math.max(0, dz - hz);
    const padded = radius + boundsTolerance;
    if (nx * nx + ny * ny + nz * nz > padded * padded) return -1;
    // Testing the furthest AABB corner makes the whole-node shortcut safe.
    if ((dx + hx) ** 2 + (dy + hy) ** 2 + (dz + hz) ** 2 > radius * radius) inside = false;
  }
  for (let i = 0; i < volume.planes.length; i += 8) {
    const p = volume.planes;
    const distance = p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3];
    const extent = p[i + 4] * hx + p[i + 5] * hy + p[i + 6] * hz + p[i + 7];
    if (distance < -extent) return -1;
    if (distance < extent) inside = false;
  }
  return inside ? 1 : 0;
}

function makeTree(indices: number[], instances: Float64Array): TreeNode {
  const bounds = new THREE.Box3(), point = new THREE.Vector3();
  for (const index of indices) {
    const o = index * 6;
    bounds.expandByPoint(point.set(instances[o] - instances[o + 3], instances[o + 1] - instances[o + 4], instances[o + 2] - instances[o + 5]));
    bounds.expandByPoint(point.set(instances[o] + instances[o + 3], instances[o + 1] + instances[o + 4], instances[o + 2] + instances[o + 5]));
  }
  const center = bounds.getCenter(new THREE.Vector3()), half = bounds.getSize(point).multiplyScalar(.5);
  const node: TreeNode = { bounds: new Float64Array([center.x, center.y, center.z, half.x, half.y, half.z]) };
  if (indices.length <= treeLeafSize) node.indices = new Uint32Array(indices);
  else {
    const size = bounds.getSize(point);
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    indices.sort((a, b) => instances[a * 6 + axis] - instances[b * 6 + axis] || a - b);
    const middle = Math.floor(indices.length / 2);
    node.left = makeTree(indices.slice(0, middle), instances);
    node.right = makeTree(indices.slice(middle), instances);
  }
  return node;
}

/**
 * Isolated, opt-in renderer adapter for static opaque InstancedMesh batches.
 *
 * Add beautyGroup and shadowGroups as identity children of the render scene.
 * Keep source meshes in their logical graph and exclude tagged proxies from
 * canonical receiver/source inventories. enable/disable suppress and restore
 * only their layer masks; no canonical matrix/count data is ever compacted.
 * prepare must run after source/camera/light world matrices have been updated.
 * Install renderShadowPasses INSIDE the existing aggregate statistics wrapper.
 * Install opaqueSort with renderer.setOpaqueSort, restoring the previous sorter
 * on detach. This preserves canonical object IDs in exact-depth tie breaking.
 * Each pass has its own GPU attribute, avoiding Three r184's once/frame upload
 * cache. Source attributes, metadata and visibility stay unchanged; enable and
 * disable change only layer masks and restore every captured mask exactly.
 */
export class PassInstanceCuller {
  /** Review benchmarks can compare the exact canonical depth path. */
  orthographicDepthEnabled = true;
  /** Optional cache integration. Leaving these unset preserves ordinary dispatch. */
  shadowPassDispatcher:ShadowPassDispatcher|undefined;
  /** Zero-based shadow passes selected only when a cache requests an exposed region. */
  deferredShadowPasses:ReadonlySet<number>=new Set();
  trackShadowContent=false;
  /** Runtime A/B switch; disabling restores complete legacy dependency auditing. */
  staticStreamLeasesEnabled=true;
  readonly staticLeaseStatistics={auditedSources:0,reusedSources:0,anchors:0,leaseLookupSources:0,selectionSourceVisits:0,skippedCellSources:0};
  private readonly staticLeaseAnchors=new WeakMap<StaticStreamSourceLease,StaticLeaseAnchorState>();
  private readonly staticLeaseSectors=new Map<StaticStreamSourceLease,StaticLeaseSector>();
  private readonly dynamicSourceStates=new Set<SourceState>();
  private staticOwnershipRevision:number|undefined;
  private staticSectorAuditsEnabled=false;
  private shadowContentRevision=0;
  get contentRevision():number {return this.shadowContentRevision;}
  private publishedShadowChanges:ShadowContentChanges={fromRevision:0,revision:0,full:true,bounds:[]};
  get shadowChanges():ShadowContentChanges {return this.publishedShadowChanges;}
  private readonly pendingShadowBounds=new Map<string,THREE.Box3>();
  private pendingShadowFull=false;
  shadowGeometryForSource: ((source: THREE.InstancedMesh) => THREE.BufferGeometry | undefined) | undefined = exactShadowGeometry;
  /** Render-only representations. Pass 0 is beauty; positive passes identify
   * shadowGroups[pass - 1]. Canonical resources, bounds and instance IDs remain
   * authoritative. Returned geometry is owned by the caller and must fit inside
   * the canonical bounds. Shadow results must remain stable until this callback
   * is replaced or invalidateRenderGeometry() is called before the next prepare.
   */
  geometryForPass: ((descriptor:CanonicalInstanceSource,passIndex:number,light?:THREE.DirectionalLight)=>THREE.BufferGeometry|undefined)|undefined;
  private renderGeometryRevision=0;
  private proxyBindingRevision=0;
  private readonly orthographicDepth = createOrthographicShadowDepth();
  readonly beautyGroup = new THREE.Group();
  readonly shadowGroups: readonly THREE.Group[];
  /** Runtime A/B switch: changes traversal only, never selected geometry. */
  compactRenderLists=true;
  /** Test complete source bounds for distance-detail draws, then let the GPU
   * clip their instances. This retains a conservative superset of exact draws;
   * original geometry and cached shadow strips keep per-instance selection.
   */
  coarseDetailSelection=false;
  /** Keep coarse shadows independent from beauty. Disabling this performs
   * exact per-instance beauty selection only when its retained volume refreshes.
   */
  coarseBeautySelection=true;
  /** Opt-in contract for static worlds: beauty policy callbacks and their
   * captured state must remain unchanged while the complete beauty volume is
   * unchanged, or call invalidateRenderGeometry(). A caller may retain a
   * conservative guard frustum across frames; shadow volumes remain live.
   */
  reuseStaticBeautySelection=false;
  /** Caller-owned beauty policy generation; does not invalidate shadow caches. */
  beautySelectionRevision=0;
  private beautyRenderPassRevision=0;
  private sourceMembershipRevision=0;
  private beautySelectionCache?:{
    volume:CompiledVolume;frustumOnlyVolume:CompiledVolume;membershipRevision:number;
    geometryForPass:PassInstanceCuller['geometryForPass'];frustumOnlyPolicy:InstanceCullingOptions['isFrustumOnlySource'];
    renderRevision:number;policyRevision:number;coarse:boolean;coarseBeauty:boolean;cameraLayerMask:number;
  };
  private beautySelectionRevisionValid=false;
  /** Optional synchronous draw wrapper. It receives the already selected pass
   * (including a requested shadow region) and owns restoration of any temporary
   * render graph changes, including when draw throws. Pass 0 denotes beauty.
   */
  renderSelectedPass?:<T>(root:THREE.Group,selected:readonly THREE.InstancedMesh[],passIndex:number,draw:()=>T)=>T;
  private readonly compactPassChildren:CompactRenderChildren[]=[];
  private readonly selectedPassProxies:THREE.InstancedMesh[][]=[];
  private readonly selectedRegionProxies:THREE.InstancedMesh[]=[];
  private regionPassIndex=-1;
  readonly canonicalSources: readonly CanonicalInstanceSource[] = [];
  readonly statistics: InstancePassStatistics[];
  private readonly states: SourceState[] = [];
  private readonly selectionCandidates:SourceState[]=[];
  private nextRegistrationOrder=0;
  private readonly sourceStates = new WeakMap<THREE.Object3D,SourceState>();
  private readonly geometryStates = new WeakMap<THREE.BufferGeometry, GeometryState>();
  private readonly validation = new PrepareValidation();
  private readonly proxyStates = new WeakMap<THREE.InstancedMesh, { source: SourceState; draw: DrawState }>();
  private readonly orderGroups: Map<number, THREE.Group>[] = [];
  private readonly spatialCells = new Map<string, SpatialCell>();
  private preparedLights: THREE.DirectionalLight[] = [];
  private preparedShadowPasses:readonly InstanceShadowPass[]=[];
  private readonly preparedDeferredShadowPasses:boolean[]=[];
  private readonly ordinaryPassIndices:number[]=[];
  private preparedCameraLayerMask=1;
  private frustumOnlyBeautyVolume?:CompiledVolume;
  private scene?: THREE.Scene;
  private volumes: CompiledVolume[] = [];
  private prepared = false;
  private active = false;
  private disposed = false;
  private dispatching = false;
  private regionActive = false;
  private readonly regionRestoreDraws:DrawState[]=[];
  private readonly shadowMaterialContent=new WeakMap<THREE.Material,ShadowContentSnapshot>();
  private readonly shadowGeometryContent=new WeakMap<THREE.BufferGeometry,ShadowContentSnapshot>();
  private readonly shadowPolicyContent=shadowSnapshot();

  constructor(sources: readonly THREE.InstancedMesh[], shadowPassCount = 4, private readonly options: InstanceCullingOptions = {}) {
    if (!Number.isInteger(shadowPassCount) || shadowPassCount < 0) throw new Error('Invalid shadow pass count');
    if (new Set(sources).size !== sources.length) throw new Error('Canonical sources must be unique');
    // Validate everything before allocating any proxies.
    for (const source of sources) {
      const reason = unsupportedReason(source, options);
      if (reason) throw new Error(`${source.name || source.uuid}: ${reason}`);
      if (!Number.isInteger(source.count) || source.count > source.instanceMatrix.count || source.count < 0) throw new Error('Invalid canonical instance count');
    }
    this.beautyGroup.name = 'Pass instance culling / beauty';
    this.beautyGroup.userData[proxyTag] = true;
    this.beautyGroup.visible = false;
    this.beautyGroup.layers.enableAll();
    this.shadowGroups = Array.from({ length: shadowPassCount }, (_, index) => {
      const group = new THREE.Group();
      group.name = `Pass instance culling / shadow ${index}`;
      group.userData[proxyTag] = true;
      group.visible = false;
      group.layers.enableAll();
      return group;
    });
    for (const group of [this.beautyGroup, ...this.shadowGroups]) {
      this.orderGroups.push(new Map([[0, group]]));
      this.compactPassChildren.push(new CompactRenderChildren(group));
      this.selectedPassProxies.push([]);
    }
    this.statistics = Array.from({ length: shadowPassCount + 1 }, () => ({ selected: 0, activeBatches: 0, batchRejected: 0, batchAccepted: 0, boundsTests: 0, reusedSelections: 0, uploadedSelections: 0, reusedUploads: 0, cellTests: 0, cellRejected: 0 }));
    this.addSources(sources);
  }

  /** Register loaded canonical batches before their parent chunk becomes visible. */
  addSources(sources: readonly THREE.InstancedMesh[]): void {
    this.assertUsable();
    if (this.dispatching||this.regionActive) throw new Error('Cannot change residency during shadow dispatch');
    const existing = new Set<THREE.Object3D>();
    for (const source of sources) {
      if (this.sourceStates.has(source)||existing.has(source)) throw new Error('Canonical source is already registered');
      existing.add(source);
      const reason = unsupportedReason(source, this.options);
      if (reason) throw new Error(`${source.name || source.uuid}: ${reason}`);
      if (!Number.isInteger(source.count) || source.count > source.instanceMatrix.count || source.count < 0) throw new Error('Invalid canonical instance count');
    }
    for (const source of sources) {
      const capacity = source.instanceMatrix.count;
      this.sourceMembershipRevision++;this.beautySelectionRevisionValid=false;
      const state:SourceState={
        registrationOrder:this.nextRegistrationOrder++,descriptor:undefined as unknown as CanonicalInstanceSource,
        capacity,count:-1,revision:0,bindingRevision:0,geometry:undefined,geometryRevision:-1,
        matrixAttribute:undefined,matrixArray:undefined,matrixVersion:-1,
        colorAttribute:undefined,colorArray:undefined,colorVersion:-1,
        worldMatrix:new THREE.Matrix4(),displacement:-1,sortCenter:undefined,
        matrices:new Float32Array(capacity*16),bounds:new Float64Array(capacity*6),tree:undefined,draws:[],
        cell:undefined,shadowContent:undefined,shadowVisible:false,resourceBindings:undefined,
        immutableValidated:undefined,drawsInactive:undefined,staticLease:undefined,staticSector:undefined,
        staticAnchor:undefined,preparedStaticLease:undefined,staticVisible:undefined,
      };
      state.descriptor = {
        source, originalLayerMask: source.layers.mask,
        get count() { return state.count; }, get revision() { return state.revision; },
        localBox: new THREE.Box3(), localSphere: new THREE.Sphere(), worldBox: new THREE.Box3(), worldSphere: new THREE.Sphere(),
      };
      for (let pass = 0; pass <= this.shadowGroups.length; pass++) {
        const proxy = new THREE.InstancedMesh(source.geometry, source.material, capacity);
        proxy.name = `${source.name || source.uuid} / ${pass ? `shadow ${pass - 1}` : 'beauty'} proxy`;
        proxy.userData = { [proxyTag]: true, canonicalSourceUUID: source.uuid, canonicalSourceId: source.id, passIndex: pass };
        proxy.layers.mask = state.descriptor.originalLayerMask;
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        // Selection is already conservative. Avoid a second, potentially unsafe
        // max-column-scale sphere test for sheared parent transforms.
        proxy.frustumCulled = false;
        proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        proxy.count = 0;
        if(pass>0&&this.preparedDeferredShadowPasses[pass-1])proxy.visible=false;
        const draw=createDrawState(proxy,capacity);
        state.draws.push(draw);
        this.proxyStates.set(proxy, { source: state, draw });
        const nativeRaycast = THREE.InstancedMesh.prototype.raycast;
        proxy.raycast = (raycaster, intersections) => {
          if (pass || !this.active || !proxy.visible || !this.scene || !visibleInSourceGraph(source, this.scene)) return;
          const found: THREE.Intersection[] = [];
          nativeRaycast.call(proxy, raycaster, found);
          for (const hit of found) {
            if (hit.instanceId !== undefined) hit.instanceId = draw.indices[hit.instanceId];
            hit.object = source;
            intersections.push(hit);
          }
        };
        const group=pass ? this.shadowGroups[pass - 1] : this.beautyGroup;
        group.add(proxy);this.compactPassChildren[pass].append(group,proxy);
      }
      this.states.push(state);
      if(this.staticStreamLeasesEnabled&&this.options.getStaticSourceLease)this.assignSourceOwnership(state,this.options.getStaticSourceLease(source));
      this.sourceStates.set(source,state);
      this.shadowContentRevision++;
      this.refresh(state);
      (this.canonicalSources as CanonicalInstanceSource[]).push(state.descriptor);
      if (this.active) source.layers.mask = 0;
    }
  }

  /** Unregister before the chunk owner releases canonical geometry or materials. */
  removeSources(sources: readonly THREE.Object3D[]): void {
    this.assertUsable();
    if (this.dispatching||this.regionActive) throw new Error('Cannot change residency during shadow dispatch');
    const removed = new Set(sources);
    let kept = 0;
    for (const state of this.states) {
      if (removed.has(state.descriptor.source)) {
        this.sourceMembershipRevision++;this.beautySelectionRevisionValid=false;
        this.queueSourceShadowBounds(state,this.sourceShadowVisibility(state));
        if (this.active) state.descriptor.source.layers.mask = state.descriptor.originalLayerMask;
        this.releaseState(state);
        this.shadowContentRevision++;
      } else this.states[kept++] = state;
    }
    this.states.length = kept;
    const descriptors = this.canonicalSources as CanonicalInstanceSource[];
    descriptors.length = 0;
    for (const state of this.states) descriptors.push(state.descriptor);
    for(const proxies of this.selectedPassProxies){
      let count=0;for(const proxy of proxies)if(this.proxyStates.has(proxy))proxies[count++]=proxy;
      proxies.length=count;
    }
  }

  private releaseState(state: SourceState): void {
    this.sourceStates.delete(state.descriptor.source);
    this.dynamicSourceStates.delete(state);
    if(state.staticSector){
      state.staticSector.sources.delete(state);
      if(!state.staticSector.sources.size)this.staticLeaseSectors.delete(state.staticSector.lease);
      state.staticSector=undefined;
    }
    if(state.cell){
      state.cell.sources.delete(state);state.cell.dirty=true;
      if(!state.cell.sources.size)this.spatialCells.delete(state.cell.key);
      state.cell=undefined;
    }
    for (let pass=0;pass<state.draws.length;pass++) {
      const draw=state.draws[pass],list=this.compactPassChildren[pass];
      if(draw.region){
        const parent=draw.region.proxy.parent;draw.region.proxy.removeFromParent();if(parent)list.remove(parent,draw.region.proxy);
        draw.region.proxy.dispose();this.proxyStates.delete(draw.region.proxy);draw.region=undefined;
      }
      const parent=draw.proxy.parent;draw.proxy.removeFromParent();if(parent)list.remove(parent,draw.proxy);
      draw.proxy.dispose(); this.proxyStates.delete(draw.proxy);
    }
    state.draws.length = 0; state.tree = undefined;
    state.matrices = new Float32Array(0); state.bounds = new Float64Array(0);
  }

  get enabled(): boolean { return this.active; }
  hasSource(source:THREE.Object3D):boolean {return this.sourceStates.has(source);}
  /** Prepared renderer-owned proxies backed by a strong source lease can skip
   * repeated binding validation. Valid only during synchronous rendering after
   * prepare; callers must not mutate these proxies. Selection count and instance
   * buffer versions remain independent and must still be checked by consumers.
   * Variant resource edits require invalidateRenderGeometry(), even for beauty.
   */
  readonly getRenderProxyRevision=(proxy:THREE.InstancedMesh):number|undefined=>{
    const entry=this.proxyStates.get(proxy);
    if(!entry||!this.staticStreamLeasesEnabled||!entry.source.staticLease||entry.source.preparedStaticLease!==entry.source.staticLease)return undefined;
    const {source,draw}=entry,previous=draw.trustedBinding;
    if(previous&&previous.sourceRevision===source.bindingRevision&&previous.renderRevision===this.renderGeometryRevision&&
      previous.geometry===proxy.geometry&&previous.depth===proxy.customDepthMaterial&&previous.distance===proxy.customDistanceMaterial)return previous.revision;
    const next=previous??{} as NonNullable<DrawState['trustedBinding']>;
    next.revision=++this.proxyBindingRevision;next.sourceRevision=source.bindingRevision;next.renderRevision=this.renderGeometryRevision;
    next.geometry=proxy.geometry;next.depth=proxy.customDepthMaterial;next.distance=proxy.customDistanceMaterial;
    draw.trustedBinding=next;return next.revision;
  };
  /** A stable stamp also covers selected order, counts, buffers and bindings.
   * Only valid for synchronous beauty rendering after a successful prepare.
   * Generic sources and shadow regions retain ordinary live validation.
   */
  readonly getRenderPassRevision=(passIndex:number):number|undefined=>
    passIndex===0&&this.active&&!this.regionActive&&this.reuseStaticBeautySelection&&this.staticStreamLeasesEnabled&&
    this.beautySelectionRevisionValid&&this.beautySelectionCache?.policyRevision===this.beautySelectionRevision?this.beautyRenderPassRevision:undefined;
  get compactRenderStatistics(){return {enabled:this.compactRenderLists,passes:this.compactPassChildren.map(list=>({...list.statistics}))};}

  /** Native beauty traversal visits the selected list computed by prepare. */
  withCompactBeauty<T>(draw:()=>T):T {
    this.assertUsable();
    if(!this.compactRenderLists||!this.active)return draw();
    return this.renderSelectedPass?this.renderSelectedPass(this.beautyGroup,this.selectedPassProxies[0],0,draw):this.compactPassChildren[0].render(this.selectedPassProxies[0],draw);
  }

  private withCompactShadow<T>(passIndex:number,draw:()=>T):T {
    if(!this.compactRenderLists)return draw();
    const selected=this.regionActive&&this.regionPassIndex===passIndex?this.selectedRegionProxies:this.selectedPassProxies[passIndex+1];
    return this.renderSelectedPass?this.renderSelectedPass(this.shadowGroups[passIndex],selected,passIndex+1,draw):this.compactPassChildren[passIndex+1].render(selected,draw);
  }

  /** Three r184's default opaque sort with the authoritative object ID tie break. */
  readonly opaqueSort = (a: OpaqueSortItem, b: OpaqueSortItem): number => {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    // Material.id exists in r184 at runtime but is absent from its typings.
    const materialA = a.material.userData.streamMaterialId ?? (a.material as THREE.Material & { id: number }).id;
    const materialB = b.material.userData.streamMaterialId ?? (b.material as THREE.Material & { id: number }).id;
    if (materialA !== materialB) return materialA - materialB;
    if (a.materialVariant !== b.materialVariant) return (a.materialVariant ?? 0) - (b.materialVariant ?? 0);
    if (a.z !== b.z) return a.z - b.z;
    const sourceA = this.proxyStates.get(a.object as THREE.InstancedMesh)?.source.descriptor.source ?? a.object;
    const sourceB = this.proxyStates.get(b.object as THREE.InstancedMesh)?.source.descriptor.source ?? b.object;
    const originalA = sourceA.userData.streamBatchId ?? sourceA.id ?? a.id;
    const originalB = sourceB.userData.streamBatchId ?? sourceB.id ?? b.id;
    return originalA - originalB;
  };

  /** Call after prepare and attaching proxy groups; disables canonical draws only. */
  enable(): void {
    this.assertUsable();
    if (this.dispatching||this.regionActive) throw new Error('Cannot enable during shadow dispatch');
    if (this.active) return;
    if (!this.prepared) throw new Error('Prepare exact pass volumes before enabling');
    for (const state of this.states) if (state.descriptor.source.layers.mask !== state.descriptor.originalLayerMask) throw new Error('Canonical layers changed; recapture the adapter before enabling');
    for (const state of this.states) state.descriptor.source.layers.mask = 0;
    this.active = true;
    this.beautyGroup.visible = true;
  }

  /** Exact same-state canonical reference rendering for visual A/B validation. */
  disable(): void {
    if (this.dispatching||this.regionActive) throw new Error('Cannot disable during shadow dispatch');
    if (this.active) for (const state of this.states) state.descriptor.source.layers.mask = state.descriptor.originalLayerMask;
    this.active = false;
    this.beautyGroup.visible = false;
    for (const group of this.shadowGroups) group.visible = false;
  }

  /** Buffers remain allocated at canonical capacity; only submitted count changes. */
  prepare(beautyFrustum: THREE.Frustum, shadowPasses: readonly InstanceShadowPass[], cameraLayerMask = 1, viewDistance?: InstanceViewDistance): void {
    this.assertUsable();
    if (this.dispatching||this.regionActive) throw new Error('Cannot prepare while dispatching shadows');
    const scene = renderScene(this.beautyGroup);
    if (!scene || this.shadowGroups.some(group => renderScene(group) !== scene)) throw new Error('Attach every proxy group to the same render Scene before prepare');
    this.scene = scene;
    if (shadowPasses.length !== this.shadowGroups.length) throw new Error('Every configured shadow pass needs an exact volume');
    if (new Set(shadowPasses.map(pass => pass.light)).size !== shadowPasses.length) throw new Error('Shadow lights must be unique');
    for(const index of this.deferredShadowPasses)if(!Number.isInteger(index)||index<0||index>=shadowPasses.length)throw new Error('Invalid deferred shadow pass');
    // A failed partial prepare cannot authorize reuse on the next attempt.
    const previousBeauty=this.beautySelectionCache;
    this.beautySelectionCache=undefined;this.beautySelectionRevisionValid=false;
    this.preparedLights = shadowPasses.map(pass => pass.light);
    this.preparedShadowPasses=shadowPasses.slice();
    this.preparedCameraLayerMask=cameraLayerMask;
    this.ordinaryPassIndices.length=0;this.ordinaryPassIndices.push(0);
    for(let index=0;index<shadowPasses.length;index++){
      const deferred=this.deferredShadowPasses.has(index);
      if(deferred&&!this.preparedDeferredShadowPasses[index])for(const state of this.states){
        const draw=state.draws[index+1];
        draw.selected=0;draw.volume=undefined;draw.revision=-1;
        draw.proxy.count=0;draw.proxy.visible=false;
      }
      if(!deferred)this.ordinaryPassIndices.push(index+1);
      this.preparedDeferredShadowPasses[index]=deferred;
    }
    // Compare complete plane coefficients only once per pass. Sources compare
    // shared volume identity, without thousands of long string allocations.
    const volumes = [compileVolume(beautyFrustum, undefined, viewDistance), ...shadowPasses.map(pass => compileVolume(pass.frustum, pass.casterVolume))]
      .map((volume, index) => this.volumes[index]?.key === volume.key ? this.volumes[index] : volume);
    this.volumes = volumes;
    const frustumOnlyVolume=this.options.isFrustumOnlySource&&volumes[0].distance?compileVolume(beautyFrustum):volumes[0];
    this.frustumOnlyBeautyVolume=this.frustumOnlyBeautyVolume?.key===frustumOnlyVolume.key?this.frustumOnlyBeautyVolume:frustumOnlyVolume;
    for (const group of this.shadowGroups) group.visible = false;
    // Generic dependencies remain live. Stream-owned static sectors explicitly
    // invalidate resource edits; stable leases avoid repeating source/resource
    // audits even when their complete buffers remain resident outside the view.
    this.validation.frame++;
    Object.assign(this.staticLeaseStatistics,{auditedSources:0,reusedSources:0,anchors:0,leaseLookupSources:0,selectionSourceVisits:0,skippedCellSources:0});
    if(this.trackShadowContent){
      this.beginShadowSnapshot(this.shadowPolicyContent);
      observeShadowValue(this.shadowPolicyContent,this.orthographicDepthEnabled);
      observeShadowValue(this.shadowPolicyContent,this.shadowGeometryForSource);
      observeShadowValue(this.shadowPolicyContent,this.geometryForPass);
      observeShadowValue(this.shadowPolicyContent,this.renderGeometryRevision);
      if(this.finishShadowSnapshot(this.shadowPolicyContent))this.pendingShadowFull=true;
    }
    this.auditSources(scene,cameraLayerMask);
    const staticBeauty=this.reuseStaticBeautySelection&&this.staticStreamLeasesEnabled&&this.staticSectorAuditsEnabled&&this.dynamicSourceStates.size===0;
    const reuseBeauty=staticBeauty&&this.staticLeaseStatistics.auditedSources===0&&!!previousBeauty&&
      previousBeauty.volume===volumes[0]&&previousBeauty.frustumOnlyVolume===this.frustumOnlyBeautyVolume&&
      previousBeauty.membershipRevision===this.sourceMembershipRevision&&previousBeauty.geometryForPass===this.geometryForPass&&
      previousBeauty.frustumOnlyPolicy===this.options.isFrustumOnlySource&&previousBeauty.renderRevision===this.renderGeometryRevision&&
      previousBeauty.policyRevision===this.beautySelectionRevision&&previousBeauty.coarse===this.coarseDetailSelection&&
      previousBeauty.coarseBeauty===this.coarseBeautySelection&&previousBeauty.cameraLayerMask===cameraLayerMask;
    for(let pass=0;pass<this.statistics.length;pass++){
      const statistics=this.statistics[pass];
      if(pass===0&&reuseBeauty){
        Object.assign(statistics,{batchRejected:0,batchAccepted:0,boundsTests:0,reusedSelections:statistics.activeBatches,
          uploadedSelections:0,reusedUploads:statistics.activeBatches,cellTests:0,cellRejected:0});
      }else{
        Object.assign(statistics,{selected:0,activeBatches:0,batchRejected:0,batchAccepted:0,boundsTests:0,
          reusedSelections:0,uploadedSelections:0,reusedUploads:0,cellTests:0,cellRejected:0});
        this.selectedPassProxies[pass].length=0;
      }
    }
    if(reuseBeauty)this.ordinaryPassIndices.shift();
    for(const cell of this.spatialCells.values()){
      if(cell.dirty){
        cell.bounds.makeEmpty();for(const source of cell.sources)cell.bounds.union(source.descriptor.worldBox);
        cell.volumes.length=0;cell.frustumOnlyVolume=undefined;cell.dirty=false;
      }
      for(let pass=0;pass<volumes.length;pass++)if(!(pass>0&&this.preparedDeferredShadowPasses[pass-1])&&cell.volumes[pass]!==volumes[pass]){
        const box=cell.bounds;
        cell.classifications[pass]=box.isEmpty()?-1:classify(volumes[pass],
          (box.min.x+box.max.x)*.5,(box.min.y+box.max.y)*.5,(box.min.z+box.max.z)*.5,
          (box.max.x-box.min.x)*.5,(box.max.y-box.min.y)*.5,(box.max.z-box.min.z)*.5);
        cell.volumes[pass]=volumes[pass];this.statistics[pass].cellTests++;
      }
      cell.allPreparedPassesRejected=true;
      for(let pass=0;pass<volumes.length;pass++)if(!(pass>0&&this.preparedDeferredShadowPasses[pass-1])&&cell.classifications[pass]>=0){cell.allPreparedPassesRejected=false;break;}
      if(cell.frustumOnlyVolume!==this.frustumOnlyBeautyVolume){
        const box=cell.bounds;
        cell.frustumOnlyClassification=this.frustumOnlyBeautyVolume.key===volumes[0].key?cell.classifications[0]:box.isEmpty()?-1:classify(this.frustumOnlyBeautyVolume,
          (box.min.x+box.max.x)*.5,(box.min.y+box.max.y)*.5,(box.min.z+box.max.z)*.5,
          (box.max.x-box.min.x)*.5,(box.max.y-box.min.y)*.5,(box.max.z-box.min.z)*.5);
        cell.frustumOnlyVolume=this.frustumOnlyBeautyVolume;
      }
    }
    this.selectionCandidates.length=0;
    // Beauty retains its entire selection. Only live ordinary shadow cells and
    // cells whose previous shadows need hiding can require source-level work.
    // Unusually large pass counts keep the generic path instead of bit wrapping.
    const pruneRetainedBeauty=reuseBeauty&&this.shadowGroups.length<31;
    let ordinaryPassMask=0;
    for(const pass of this.ordinaryPassIndices)ordinaryPassMask|=1<<pass;
    for(const cell of this.spatialCells.values()){
      // Every edit/visibility journal was processed above. Already-empty cells
      // rejected by both beauty policies and ordinary shadow passes need no
      // batch visits. Deferred shadow regions select these cells independently.
      if(cell.drawsInactive&&cell.allPreparedPassesRejected&&(cell.frustumOnlyClassification??0)<0){
        this.staticLeaseStatistics.skippedCellSources+=cell.sources.size;continue;
      }
      if(pruneRetainedBeauty&&!(cell.activePassMask&ordinaryPassMask)){
        let intersects=false;
        for(const pass of this.ordinaryPassIndices)if(cell.classifications[pass]>=0){intersects=true;break;}
        if(!intersects){this.staticLeaseStatistics.skippedCellSources+=cell.sources.size;continue;}
      }
      cell.drawsInactive=true;
      cell.activePassMask=reuseBeauty?cell.activePassMask&1:0;
      for(const state of cell.sources)this.selectionCandidates.push(state);
    }
    // Preserve the canonical registration sequence when proxies first enter
    // inherited-order groups. Spatial grouping must not reorder tied draws.
    this.selectionCandidates.sort((a,b)=>a.registrationOrder-b.registrationOrder);
    for (const state of this.selectionCandidates) {
      this.staticLeaseStatistics.selectionSourceVisits++;
      const cell=state.cell!;
      const source = state.descriptor.source;
      const visible=state.staticVisible!;
      const frustumOnlyBeauty=!reuseBeauty&&this.options.isFrustumOnlySource?.(source)===true;
      // Complete cell rejection is shared across all its sources. Once every
      // ordinary draw is hidden, immutable sources need no per-proxy processing;
      // shared asset audits, visibility and shadow journals above still ran.
      if((state.immutableValidated||state.staticLease)&&state.drawsInactive&&(!visible||state.cell?.allPreparedPassesRejected&&(!frustumOnlyBeauty||(state.cell.frustumOnlyClassification??0)<0)))continue;
      state.drawsInactive=!(reuseBeauty&&state.draws[0].selected>0);
      if(!state.drawsInactive)cell.drawsInactive=false;
      let nativeDepth: boolean | undefined;
      let groupOrder: number | undefined;
      for (const pass of this.ordinaryPassIndices) {
        const draw = state.draws[pass], proxy = draw.proxy;
        // Reevaluate caller-owned batch gates every prepare, even if plane and
        // source-buffer coefficients are unchanged. A changed result switches
        // the cached volume identity to/from undefined and refreshes selection.
        const frustumOnly=pass===0&&frustumOnlyBeauty;
        const cellClassification=(frustumOnly?state.cell?.frustumOnlyClassification:state.cell?.classifications[pass])??0;
        if(cellClassification<0){
          this.statistics[pass].cellRejected++;
          // Other passes may keep this cell in the candidate union. A draw
          // already hidden here needs no gate, selection, binding or GPU writes.
          if(draw.selected===0&&!proxy.visible)continue;
        }
        const active = visible && cellClassification>=0 && (pass === 0 || (source.castShadow && shadowPasses[pass - 1].sourceFilter?.(source) !== false));
        const passVolume=frustumOnly?this.frustumOnlyBeautyVolume:volumes[pass];
        const volume = active ? passVolume : undefined;
        const allowCoarse=this.coarseDetailSelection&&(pass!==0||this.coarseBeautySelection);
        const selectionGeometry=allowCoarse&&active?this.renderGeometry(state.descriptor,pass):undefined;
        const coarse=allowCoarse&&Number(selectionGeometry?.userData.distanceDetailLevel)>0;
        if (draw.volume === volume && draw.revision === state.revision&&draw.coarseSelection===coarse) {
          this.statistics[pass].reusedSelections++;
          if (draw.selected) this.statistics[pass].reusedUploads++;
        }
        else {
          draw.selected = 0;
          if (active && state.count) this.select(state, draw, passVolume!, this.statistics[pass],cellClassification,coarse);
          if (this.uploadSelection(state, draw)) this.statistics[pass].uploadedSelections++;
          else if (draw.selected) this.statistics[pass].reusedUploads++;
          draw.volume = volume; draw.revision = state.revision;draw.coarseSelection=coarse;
        }
        proxy.count = draw.selected; proxy.visible = draw.selected > 0;
        this.statistics[pass].selected += draw.selected;
        if (!draw.selected) continue;
        this.selectedPassProxies[pass].push(proxy);
        state.drawsInactive=false;cell.drawsInactive=false;
        cell.activePassMask|=1<<pass;
        const geometry=selectionGeometry??this.renderGeometry(state.descriptor,pass);
        if(proxy.geometry!==geometry)proxy.geometry=geometry;
        if (pass > 0) {
          nativeDepth ??= this.orthographicDepthEnabled && supportsOrthographicShadowDepth(source);
          const depth=nativeDepth&&shadowPasses[pass-1].light.shadow.camera instanceof THREE.OrthographicCamera?this.orthographicDepth:source.customDepthMaterial;
          if(proxy.customDepthMaterial!==depth)proxy.customDepthMaterial=depth;
        }
        this.statistics[pass].activeBatches++;
        // Hidden proxies are not drawn or raycast. Bind current presentation
        // only after selection, including every property on reactivation.
        groupOrder ??= state.staticAnchor?.groupOrder??inheritedGroupOrder(source, cameraLayerMask);
        const group = this.groupForOrder(pass, groupOrder);
        if (proxy.parent !== group) {
          const previous=proxy.parent;group.add(proxy);if(previous)this.compactPassChildren[pass].remove(previous,proxy);
          this.compactPassChildren[pass].append(group,proxy);draw.regionOrderParent=undefined;
        }
        // Proxies are adapter-owned and never update their own matrices. Source
        // validation above still runs every frame, including while rejected.
        if (draw.presentationRevision !== state.revision) {
          proxy.matrix.copy(source.matrixWorld); proxy.matrixWorld.copy(source.matrixWorld);
          proxy.boundingBox!.copy(state.descriptor.localBox);
          proxy.boundingSphere!.copy(state.descriptor.localSphere);
          draw.presentationRevision = state.revision;
        }
        proxy.renderOrder = source.renderOrder;
        proxy.castShadow = pass > 0 && source.castShadow;
        proxy.receiveShadow = pass === 0 && source.receiveShadow;
      }
    }
    this.prepared = true;
    if(!reuseBeauty)this.beautyRenderPassRevision++;
    this.beautySelectionCache=staticBeauty?{
      volume:volumes[0],frustumOnlyVolume:this.frustumOnlyBeautyVolume,membershipRevision:this.sourceMembershipRevision,
      geometryForPass:this.geometryForPass,frustumOnlyPolicy:this.options.isFrustumOnlySource,
      renderRevision:this.renderGeometryRevision,policyRevision:this.beautySelectionRevision,
      coarse:this.coarseDetailSelection,coarseBeauty:this.coarseBeautySelection,cameraLayerMask,
    }:undefined;
    this.beautySelectionRevisionValid=staticBeauty;
    // Commit only after a complete prepare. Async residency changes accumulated
    // since the last successful prepare are retained, including old removed bounds.
    this.publishedShadowChanges={fromRevision:this.publishedShadowChanges.revision,revision:this.shadowContentRevision,
      full:this.pendingShadowFull,bounds:Array.from(this.pendingShadowBounds.values())};
    this.pendingShadowBounds.clear();this.pendingShadowFull=false;
  }

  /** Call before changing shadow representation content behind a stable callback.
   * Geometry/attribute upload notifications remain the caller's responsibility.
   */
  invalidateRenderGeometry():void {
    this.assertUsable();
    if(this.dispatching||this.regionActive)throw new Error('Cannot change render geometry during shadow dispatch');
    this.renderGeometryRevision++;
    this.beautySelectionRevisionValid=false;
  }

  private renderGeometry(descriptor:CanonicalInstanceSource,passIndex:number):THREE.BufferGeometry {
    const override=this.geometryForPass?.(descriptor,passIndex,passIndex>0?this.preparedShadowPasses[passIndex-1]?.light:undefined);
    return override??(passIndex>0?this.shadowGeometryForSource?.(descriptor.source):undefined)??descriptor.source.geometry;
  }

  /** Pointer changes must reach hidden helpers too, but stable assets need no writes. */
  private bindSourceResources(state:SourceState):void {
    const source=state.descriptor.source,previous=state.resourceBindings;
    if(previous&&previous.geometry===source.geometry&&previous.material===source.material&&
      previous.depth===source.customDepthMaterial&&previous.distance===source.customDistanceMaterial)return;
    for(const draw of state.draws){
      const proxy=draw.proxy;
      proxy.geometry=source.geometry;proxy.material=source.material;
      proxy.customDepthMaterial=source.customDepthMaterial;proxy.customDistanceMaterial=source.customDistanceMaterial;
      if(draw.region){
        const region=draw.region.proxy;region.geometry=source.geometry;region.material=source.material;
        region.customDepthMaterial=source.customDepthMaterial;region.customDistanceMaterial=source.customDistanceMaterial;
      }
    }
    state.resourceBindings={geometry:source.geometry,material:source.material,depth:source.customDepthMaterial,distance:source.customDistanceMaterial};
  }

  /** Ownership generation makes the stable cost proportional to sectors, not
   * resident batches. Custom owners without a generation keep live lookups.
   */
  private auditSources(scene:THREE.Scene,cameraLayerMask:number):void {
    if(!this.staticStreamLeasesEnabled||!this.options.getStaticSourceLease){
      this.staticLeaseSectors.clear();this.dynamicSourceStates.clear();this.staticSectorAuditsEnabled=false;
      for(const state of this.states){
        state.staticLease=undefined;state.staticSector=undefined;state.staticAnchor=undefined;
        this.auditSourceDependencies(state,scene);
      }
      return;
    }
    const ownershipRevision=this.options.getStaticSourceLeaseRevision?.();
    if(!this.staticSectorAuditsEnabled||ownershipRevision===undefined||ownershipRevision!==this.staticOwnershipRevision){
      for(const state of this.states){
        const source=state.descriptor.source,owned=this.options.getStaticSourceLease(source);
        this.staticLeaseStatistics.leaseLookupSources++;
        this.assignSourceOwnership(state,owned);
      }
      this.staticOwnershipRevision=ownershipRevision;this.staticSectorAuditsEnabled=true;
    }
    for(const sector of this.staticLeaseSectors.values()){
      const anchor=this.auditStaticAnchor(sector.lease,scene,cameraLayerMask);
      if(!sector.force&&sector.preparedAnchorRevision===anchor.revision&&sector.preparedShadowTracking===this.trackShadowContent){
        this.staticLeaseStatistics.reusedSources+=sector.sources.size;continue;
      }
      for(const state of sector.sources){state.staticAnchor=anchor;this.auditSourceDependencies(state,scene);}
      sector.preparedAnchorRevision=anchor.revision;sector.preparedShadowTracking=this.trackShadowContent;sector.force=false;
    }
    for(const state of this.dynamicSourceStates)this.auditSourceDependencies(state,scene);
  }

  private assignSourceOwnership(state:SourceState,owned:StaticStreamSourceLease|undefined):void {
    const lease=owned&&state.descriptor.source.parent===owned.anchor?owned:undefined;
    if(state.staticSector?.lease!==lease){
      if(state.staticSector){
        state.staticSector.sources.delete(state);
        if(!state.staticSector.sources.size)this.staticLeaseSectors.delete(state.staticSector.lease);
      }
      state.staticSector=undefined;state.staticAnchor=undefined;
    }
    state.staticLease=lease;
    if(lease){
      let sector=state.staticSector??this.staticLeaseSectors.get(lease);
      if(!sector){sector={lease,sources:new Set(),force:true};this.staticLeaseSectors.set(lease,sector);}
      if(!sector.sources.has(state)){sector.sources.add(state);sector.force=true;}
      state.staticSector=sector;this.dynamicSourceStates.delete(state);
    }else this.dynamicSourceStates.add(state);
  }

  private auditSourceDependencies(state:SourceState,scene:THREE.Scene):void {
    const source=state.descriptor.source;
    if(this.active&&source.layers.mask!==0){
      this.disable();throw new Error('Canonical layers changed while enabled; adapter disabled and original masks restored');
    }
    this.staticLeaseStatistics.auditedSources++;
    state.bindingRevision++;
    this.refresh(state,this.validation,!!state.staticLease||!!state.preparedStaticLease);
    const visible=state.staticAnchor?source.visible&&state.staticAnchor.visible:visibleInSourceGraph(source,scene);
    const shadowVisible=visible&&source.castShadow;
    if(state.shadowVisible!==shadowVisible){this.queueSourceShadowBounds(state,shadowVisible);this.shadowContentRevision++;}
    if(this.trackShadowContent&&this.observeShadowContent(state,visible))this.queueSourceShadowBounds(state,shadowVisible);
    state.shadowVisible=shadowVisible;this.bindSourceResources(state);
    state.staticVisible=visible;state.preparedStaticLease=state.staticLease;
  }

  /** One small anchor/ancestor audit replaces thousands of source/resource scans.
   * Source transforms have already been prepared by the caller. We retain every
   * ancestor identity to detect reparenting even when world transforms match.
   */
  private auditStaticAnchor(lease:StaticStreamSourceLease,scene:THREE.Scene,cameraLayerMask:number):StaticLeaseAnchorState {
    let state=this.staticLeaseAnchors.get(lease);
    if(state?.frame===this.validation.frame)return state;
    if(!state){state={frame:-1,revision:0,values:[],visible:false,groupOrder:0};this.staticLeaseAnchors.set(lease,state);}
    this.staticLeaseStatistics.anchors++;
    let cursor=0,changed=false;
    const observe=(value:unknown):void=>{if(!Object.is(state!.values[cursor],value))changed=true;state!.values[cursor++]=value;};
    observe(lease.revision);observe(lease.resourcesRevision);observe(scene);observe(cameraLayerMask);
    for(const value of lease.anchor.matrixWorld.elements){
      if(!Number.isFinite(value))throw new Error('Static sector world transforms must be finite');
      observe(value);
    }
    let visible=true,connected=false,groupOrder:number|undefined;
    for(let object:THREE.Object3D|null=lease.anchor;object;object=object.parent){
      observe(object);observe(object.visible);observe(object.layers.mask);observe(object.renderOrder);
      visible&&=object.visible;
      if(groupOrder===undefined&&object instanceof THREE.Group&&(object.layers.mask&cameraLayerMask)!==0)groupOrder=object.renderOrder;
      if(object===scene){connected=true;break;}
    }
    changed ||= state.values.length!==cursor;
    state.values.length=cursor;state.frame=this.validation.frame;
    state.visible=visible&&connected;state.groupOrder=groupOrder??0;
    if(changed)state.revision++;
    return state;
  }

  /** Call with the uninstrumented, correctly bound native shadowMap.render. */
  renderShadowPasses(nativeRender: NativeShadowRender, shadowState: ShadowState, lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera): void {
    this.assertUsable();
    if (this.dispatching) throw new Error('Recursive shadow dispatch is unsupported');
    if (!this.active || !shadowState.enabled || (!shadowState.autoUpdate && !shadowState.needsUpdate) || !lights.length) {
      nativeRender(lights, scene, camera); return;
    }
    if (shadowState.type !== THREE.PCFShadowMap && shadowState.type !== THREE.BasicShadowMap) throw new Error('Per-pass proxies currently support PCF and Basic shadows only');
    const indices = lights.map(light => this.preparedLights.indexOf(light as THREE.DirectionalLight));
    if (indices.some(index => index < 0)) throw new Error('Unprepared shadow light: keep canonical rendering enabled until every light is supported');
    const visibility = this.shadowGroups.map(group => group.visible);
    const requested = shadowState.needsUpdate;
    let completed = false;
    this.dispatching = true;
    try {
      for (const group of this.shadowGroups) group.visible = false;
      for (let i = 0; i < lights.length; i++) {
        const group = this.shadowGroups[indices[i]];
        group.visible = true;
        // Native render consumes this flag after each invocation. Rearm the
        // same requested update for the remaining lights, never force a new one.
        shadowState.needsUpdate = requested;
        if(this.shadowPassDispatcher){
          const index=indices[i],light=lights[i] as THREE.DirectionalLight;
          this.shadowPassDispatcher(index,light,group,()=>{
            if(!this.dispatching)throw new Error('A native shadow callback cannot outlive its synchronous dispatch');
            shadowState.needsUpdate=requested;
            this.withCompactShadow(index,()=>nativeRender([light],scene,camera));
          });
        }else if(this.preparedDeferredShadowPasses[indices[i]]){
          // Removing a cache dispatcher cannot silently remove its shadows.
          this.withShadowRegion(indices[i],this.preparedShadowPasses[indices[i]].frustum,
            ()=>this.withCompactShadow(indices[i],()=>nativeRender([lights[i]],scene,camera)));
        }else this.withCompactShadow(indices[i],()=>nativeRender([lights[i]], scene, camera));
        group.visible = false;
      }
      completed = true;
    } finally {
      this.shadowGroups.forEach((group, index) => { group.visible = visibility[index]; });
      if (!completed) shadowState.needsUpdate = requested;
      this.dispatching = false;
    }
  }

  /** Existing full-detail buffers plus future deferred-strip buffers for startup upload.
   * Only adapter-owned resource bindings are prepared. Selected IDs, transforms,
   * visibility and live draw counts remain untouched, including hidden sources.
   */
  *preparationMeshes(regionPassIndices:ReadonlySet<number>=this.deferredShadowPasses):IterableIterator<THREE.InstancedMesh> {
    this.assertUsable();
    if(!this.prepared)throw new Error('Prepare the culler before preparing resident buffers');
    if(this.dispatching||this.regionActive)throw new Error('Cannot prepare resident buffers during shadow dispatch');
    for(const index of regionPassIndices)if(!Number.isInteger(index)||index<0||index>=this.shadowGroups.length)throw new Error('Invalid prepared shadow region pass');
    this.beautySelectionCache=undefined;this.beautySelectionRevisionValid=false;
    const regionsToPlace:DrawState[]=[];
    for(const state of this.states){
      const source=state.descriptor.source;
      for(let index=0;index<state.draws.length;index++){
        const draw=state.draws[index],proxy=draw.proxy;
        const geometry=this.renderGeometry(state.descriptor,index);
        proxy.geometry=geometry;
        if(index>0){
          const pass=this.preparedShadowPasses[index-1];
          proxy.customDepthMaterial=this.orthographicDepthEnabled&&supportsOrthographicShadowDepth(source)&&pass.light.shadow.camera instanceof THREE.OrthographicCamera
            ?this.orthographicDepth:source.customDepthMaterial;
        }
        yield proxy;
        if(index===0)continue;
        if((this.deferredShadowPasses.has(index-1)||regionPassIndices.has(index-1))&&!draw.region)draw.region=this.createShadowRegion(state,draw);
        const region=draw.region;
        if(!region)continue;
        if(draw.proxy.parent&&draw.regionOrderParent!==draw.proxy.parent)regionsToPlace.push(draw);
        region.proxy.geometry=geometry;
        region.proxy.customDepthMaterial=proxy.customDepthMaterial;
        if(source.instanceColor&&!region.proxy.instanceColor){
          region.proxy.instanceColor=source.instanceColor.clone() as THREE.InstancedBufferAttribute;
          region.proxy.instanceColor.setUsage(THREE.DynamicDrawUsage);region.uploadedRevision=-1;
        }
        yield region.proxy;
      }
    }
    this.prepareRegionParents(regionsToPlace);
  }

  /** Prepare future strip membership in linear passes while startup owns the scene.
   * Full proxies retain their current parents and relative native order. Later
   * order changes/reparenting still use the ordinary live placement fallback.
   */
  private prepareRegionParents(draws:readonly DrawState[]):void {
    const groups=new Map<THREE.Object3D,{pass:number;pairs:Map<THREE.Object3D,DrawState>;regions:Set<THREE.Object3D>}>();
    for(const draw of draws){
      const parent=draw.proxy.parent,region=draw.region!.proxy;
      // A previously used helper can belong to an older inherited-order group.
      // Leave its native reparent events to the established live path.
      if(!parent||region.parent&&region.parent!==parent)continue;
      let group=groups.get(parent);
      if(!group){group={pass:draw.proxy.userData.passIndex as number,pairs:new Map(),regions:new Set()};groups.set(parent,group);}
      group.pairs.set(draw.proxy,draw);group.regions.add(region);
    }
    for(const [parent,group] of groups){
      const list=this.compactPassChildren[group.pass];
      for(const draw of group.pairs.values()){
        const region=draw.region!.proxy;
        if(!region.parent){parent.add(region);list.append(parent,region);}
      }
      const children=parent.children,ordered:THREE.Object3D[]=[];
      for(const child of children){
        if(group.regions.has(child))continue;
        ordered.push(child);
        const draw=group.pairs.get(child);
        if(draw)ordered.push(draw.region!.proxy);
      }
      // Preserve the authoritative array reference as well as every full-proxy
      // sibling. Incremental rank updates avoid deferring a full index rebuild.
      for(let index=0;index<ordered.length;index++)children[index]=ordered[index];
      children.length=ordered.length;
      for(const draw of group.pairs.values()){
        list.placeAfter(parent,draw.region!.proxy,draw.proxy);draw.regionOrderParent=parent;
      }
    }
  }

  /**
   * Filter a prepared shadow selection for one synchronous exposed-region draw.
   * Deferred passes select canonical BVHs directly, intersecting the original
   * complete pass volume rather than constructing a full-map ID list first.
   * Helpers own separate attributes: neither the full-pass GPU upload nor its
   * canonical identity sequence is changed. Native rendering must advance its
   * frame upload token between repeated strip draws using the same helper.
   */
  withShadowRegion<T>(passIndex:number,frustum:THREE.Frustum,callback:()=>T):T {
    this.assertUsable();
    if(!this.active||!this.prepared)throw new Error('Prepare and enable the culler before drawing a shadow region');
    if(!Number.isInteger(passIndex)||passIndex<0||passIndex>=this.shadowGroups.length)throw new Error('Invalid shadow region pass');
    if(this.regionActive)throw new Error('Nested shadow regions are unsupported');
    const deferred=this.preparedDeferredShadowPasses[passIndex],volume=compileVolume(frustum),restore=this.regionRestoreDraws;
    this.regionActive=true;this.regionPassIndex=passIndex;this.selectedRegionProxies.length=0;
    try{
      if(deferred)this.prepareDeferredShadowRegion(passIndex,volume,restore);
      else for(const state of this.states){
        const draw=state.draws[passIndex+1],full=draw.proxy;
        if(!full.visible||!draw.selected)continue;
        restore.push(draw);full.visible=false;
        let region=draw.region;
        if(region){region.selected=0;region.identityCount=undefined;}
        for(let slot=0;slot<draw.selected;slot++){
          const original=draw.indices[slot],offset=original*6,bounds=state.bounds;
          if(classify(volume,bounds[offset],bounds[offset+1],bounds[offset+2],bounds[offset+3],bounds[offset+4],bounds[offset+5])<0)continue;
          region??=this.createShadowRegion(state,draw);
          region.indices[region.selected++]=original;
        }
        if(!region||!region.selected)continue;
        const proxy=region.proxy,color=state.descriptor.source.instanceColor;
        proxy.geometry=full.geometry;proxy.material=full.material;
        proxy.customDepthMaterial=full.customDepthMaterial;proxy.customDistanceMaterial=full.customDistanceMaterial;
        proxy.matrix.copy(full.matrix);proxy.matrixWorld.copy(full.matrixWorld);
        proxy.boundingBox??=new THREE.Box3();proxy.boundingSphere??=new THREE.Sphere();
        if(full.boundingBox)proxy.boundingBox.copy(full.boundingBox);
        if(full.boundingSphere)proxy.boundingSphere.copy(full.boundingSphere);
        proxy.layers.mask=full.layers.mask;proxy.renderOrder=full.renderOrder;
        proxy.castShadow=full.castShadow;proxy.receiveShadow=full.receiveShadow;
        if(color&&(!proxy.instanceColor||proxy.instanceColor.itemSize!==color.itemSize||
          proxy.instanceColor.array.constructor!==color.array.constructor||proxy.instanceColor.normalized!==color.normalized)){
          proxy.instanceColor=color.clone() as THREE.InstancedBufferAttribute;proxy.instanceColor.setUsage(THREE.DynamicDrawUsage);
          region.uploadedRevision=-1;
        }else if(!color)proxy.instanceColor=null;
        this.placeShadowRegion(draw,full.parent!);
        this.uploadSelection(state,region);proxy.count=region.selected;proxy.visible=true;
      }
      for(const draw of restore)if(draw.region?.proxy.visible)this.selectedRegionProxies.push(draw.region.proxy);
      const result=callback();
      if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('Shadow region callbacks must be synchronous');
      return result;
    }finally{
      for(const draw of restore){draw.proxy.visible=!deferred;if(draw.region)draw.region.proxy.visible=false;}
      restore.length=0;
      this.selectedRegionProxies.length=0;this.regionPassIndex=-1;this.regionActive=false;
    }
  }

  /** Select only requested cells and tree branches, keeping every retained triangle. */
  private prepareDeferredShadowRegion(passIndex:number,regionVolume:CompiledVolume,restore:DrawState[]):void {
    const fullVolume=this.volumes[passIndex+1],planes=new Float64Array(fullVolume.planes.length+regionVolume.planes.length);
    planes.set(fullVolume.planes);planes.set(regionVolume.planes,fullVolume.planes.length);
    const volume:CompiledVolume={planes,empty:fullVolume.empty||regionVolume.empty,key:`${fullVolume.key}&${regionVolume.key}`,distance:fullVolume.distance};
    const pass=this.preparedShadowPasses[passIndex],statistics=this.statistics[passIndex+1];
    for(const cell of this.spatialCells.values()){
      const box=cell.bounds;
      const cellClassification=box.isEmpty()?-1:classify(volume,
        (box.min.x+box.max.x)*.5,(box.min.y+box.max.y)*.5,(box.min.z+box.max.z)*.5,
        (box.max.x-box.min.x)*.5,(box.max.y-box.min.y)*.5,(box.max.z-box.min.z)*.5);
      statistics.cellTests++;
      if(cellClassification<0){statistics.cellRejected+=cell.sources.size;continue;}
      for(const state of cell.sources){
        const source=state.descriptor.source;
        if(!state.count||!source.castShadow)continue;
        const box=state.descriptor.worldBox;
        const batchClassification=cellClassification>0?1:classify(volume,
          (box.min.x+box.max.x)*.5,(box.min.y+box.max.y)*.5,(box.min.z+box.max.z)*.5,
          (box.max.x-box.min.x)*.5,(box.max.y-box.min.y)*.5,(box.max.z-box.min.z)*.5);
        if(batchClassification<0){statistics.batchRejected++;continue;}
        // Most batches in a strip-crossing cell never touch the exposed strip.
        // Reject their complete bounds before walking ancestors or evaluating
        // the caller's more expensive native sphere/receiver visibility gate.
        if(!visibleInSourceGraph(source,this.scene!)||pass.sourceFilter?.(source)===false)continue;
        const draw=state.draws[passIndex+1],region=draw.region??this.createShadowRegion(state,draw);
        region.selected=0;
        this.select(state,region,volume,statistics,batchClassification);
        if(!region.selected)continue;
        // Record before binding: an exception must hide even a partially
        // rebound helper, without making the deferred full proxy visible.
        restore.push(draw);
        const proxy=region.proxy,color=source.instanceColor;
        proxy.geometry=this.renderGeometry(state.descriptor,passIndex+1);
        proxy.material=source.material;
        proxy.customDepthMaterial=this.orthographicDepthEnabled&&supportsOrthographicShadowDepth(source)&&pass.light.shadow.camera instanceof THREE.OrthographicCamera
          ?this.orthographicDepth:source.customDepthMaterial;
        proxy.customDistanceMaterial=source.customDistanceMaterial;
        proxy.matrix.copy(source.matrixWorld);proxy.matrixWorld.copy(source.matrixWorld);
        proxy.boundingBox??=new THREE.Box3();proxy.boundingSphere??=new THREE.Sphere();
        proxy.boundingBox.copy(state.descriptor.localBox);proxy.boundingSphere.copy(state.descriptor.localSphere);
        proxy.layers.mask=state.descriptor.originalLayerMask;proxy.renderOrder=source.renderOrder;
        proxy.castShadow=source.castShadow;proxy.receiveShadow=false;
        if(color&&(!proxy.instanceColor||proxy.instanceColor.itemSize!==color.itemSize||proxy.instanceColor.array.constructor!==color.array.constructor||proxy.instanceColor.normalized!==color.normalized)){
          proxy.instanceColor=color.clone() as THREE.InstancedBufferAttribute;proxy.instanceColor.setUsage(THREE.DynamicDrawUsage);region.uploadedRevision=-1;
        }else if(!color)proxy.instanceColor=null;
        const group=this.groupForOrder(passIndex+1,inheritedGroupOrder(source,this.preparedCameraLayerMask));
        this.placeShadowRegion(draw,group);
        if(this.uploadSelection(state,region))statistics.uploadedSelections++;else statistics.reusedUploads++;
        proxy.count=region.selected;proxy.visible=true;
        statistics.selected+=region.selected;statistics.activeBatches++;
      }
    }
  }

  /** Adapter-owned pairs stay adjacent until a full proxy changes order group. */
  private placeShadowRegion(draw:DrawState,group:THREE.Object3D):void {
    const full=draw.proxy,proxy=draw.region!.proxy;
    const list=this.compactPassChildren[full.userData.passIndex as number];
    if(full.parent!==group){const previous=full.parent;group.add(full);if(previous)list.remove(previous,full);list.append(group,full);draw.regionOrderParent=undefined;}
    if(proxy.parent!==group){const previous=proxy.parent;group.add(proxy);if(previous)list.remove(previous,proxy);list.append(group,proxy);draw.regionOrderParent=undefined;}
    if(draw.regionOrderParent===group)return;
    // Searching the whole child list for each selected helper is quadratic in
    // batch count. Only source order changes/new helpers need this placement.
    const siblings=group.children,fullIndex=siblings.indexOf(full),regionIndex=siblings.indexOf(proxy);
    if(regionIndex!==fullIndex+1){siblings.splice(regionIndex,1);siblings.splice(siblings.indexOf(full)+1,0,proxy);list.placeAfter(group,proxy,full);}
    draw.regionOrderParent=group;
  }

  private createShadowRegion(state:SourceState,draw:DrawState):DrawState {
    const full=draw.proxy,proxy=new THREE.InstancedMesh(full.geometry,full.material,state.capacity);
    proxy.name=`${full.name} / region`;proxy.userData={...full.userData,shadowRegionProxy:true};
    proxy.matrixAutoUpdate=false;proxy.matrixWorldAutoUpdate=false;proxy.frustumCulled=false;proxy.visible=false;
    proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);proxy.count=0;proxy.raycast=()=>{};
    const region=createDrawState(proxy,state.capacity);
    draw.region=region;this.proxyStates.set(proxy,{source:state,draw:region});
    return region;
  }

  /** Mapping also preserves co-instanced component ranges on the canonical mesh. */
  resolveProxyInstance(proxy: THREE.InstancedMesh, instanceId: number): { source: THREE.InstancedMesh; instanceId: number } | undefined {
    const entry = this.proxyStates.get(proxy);
    if (!entry || instanceId < 0 || instanceId >= entry.draw.selected || !Number.isInteger(instanceId)) return undefined;
    return { source: entry.source.descriptor.source, instanceId: entry.draw.indices[instanceId] };
  }

  /** Full canonical picking, including instances outside the beauty selection. */
  raycastCanonical(raycaster: THREE.Raycaster, intersections: THREE.Intersection[]): void {
    this.assertUsable();
    if (!this.scene) throw new Error('Prepare the adapter before querying canonical instances');
    for (const { descriptor } of this.states) if ((descriptor.originalLayerMask & raycaster.layers.mask) !== 0 && visibleInSourceGraph(descriptor.source, this.scene)) descriptor.source.raycast(raycaster, intersections);
  }

  /** Canonical geometry/materials and source objects remain owned by the world. */
  dispose(): void {
    if (this.disposed) return;
    if (this.dispatching||this.regionActive) throw new Error('Cannot dispose during shadow dispatch');
    this.disable();
    for (const state of this.states) this.releaseState(state);
    this.beautyGroup.removeFromParent();
    for (const group of this.shadowGroups) group.removeFromParent();
    this.states.length = 0;
    this.selectionCandidates.length=0;
    (this.canonicalSources as CanonicalInstanceSource[]).length = 0;
    this.preparedLights = [];
    this.preparedShadowPasses=[];this.preparedDeferredShadowPasses.length=0;
    this.shadowPassDispatcher=undefined;
    this.scene = undefined;
    this.volumes = [];
    this.frustumOnlyBeautyVolume=undefined;
    this.orderGroups.forEach(groups => groups.clear());
    this.compactPassChildren.length=0;this.selectedPassProxies.length=0;this.selectedRegionProxies.length=0;
    this.spatialCells.clear();
    this.staticLeaseSectors.clear();this.dynamicSourceStates.clear();
    this.pendingShadowBounds.clear();
    this.orthographicDepth.dispose();
    this.disposed = true;
  }

  private assertUsable(): void { if (this.disposed) throw new Error('PassInstanceCuller has been disposed'); }

  private groupForOrder(pass: number, order: number): THREE.Group {
    const groups = this.orderGroups[pass];
    let group = groups.get(order);
    if (!group) {
      group = new THREE.Group(); group.renderOrder = order; group.layers.enableAll(); group.userData[proxyTag] = true;
      group.name = `Canonical group order ${order}`;
      const root=pass ? this.shadowGroups[pass - 1] : this.beautyGroup;
      root.add(group);this.compactPassChildren[pass].append(root,group);this.compactPassChildren[pass].register(group);
      groups.set(order, group);
    }
    return group;
  }

  private beginShadowSnapshot(snapshot:ShadowContentSnapshot):void {
    snapshot.frame=this.validation.frame;snapshot.cursor=0;snapshot.changed=false;
  }
  private finishShadowSnapshot(snapshot:ShadowContentSnapshot):boolean {
    snapshot.changed ||= snapshot.values.length!==snapshot.cursor;
    if(snapshot.changed)this.shadowContentRevision++;
    snapshot.values.length=snapshot.cursor;
    return snapshot.changed;
  }
  private observeShadowContent(state:SourceState,visible:boolean):boolean {
    const source=state.descriptor.source,snapshot=state.shadowContent??=shadowSnapshot();
    let changed=false;
    this.beginShadowSnapshot(snapshot);
    observeShadowValue(snapshot,visible);observeShadowValue(snapshot,source.castShadow);
    observeShadowValue(snapshot,source.renderOrder);observeShadowValue(snapshot,source.customDepthMaterial);
    observeShadowValue(snapshot,source.customDistanceMaterial);
    if(Array.isArray(source.material)){
      observeShadowValue(snapshot,source.material.length);
      for(const material of source.material){observeShadowValue(snapshot,material);if(material)changed=this.observeShadowMaterial(material)||changed;}
    }else{observeShadowValue(snapshot,1);observeShadowValue(snapshot,source.material);changed=this.observeShadowMaterial(source.material);}
    changed=this.finishShadowSnapshot(snapshot)||changed;
    if(source.customDepthMaterial)changed=this.observeShadowMaterial(source.customDepthMaterial)||changed;
    if(source.customDistanceMaterial)changed=this.observeShadowMaterial(source.customDistanceMaterial)||changed;
    const geometry=source.geometry;
    let content=this.shadowGeometryContent.get(geometry);
    if(content?.frame===this.validation.frame)return content.changed||changed;
    if(!content){content=shadowSnapshot();this.shadowGeometryContent.set(geometry,content);}
    this.beginShadowSnapshot(content);
    observeShadowValue(content,geometry.index);observeShadowValue(content,geometry.index?.array);
    observeShadowValue(content,geometry.index?.version);observeShadowValue(content,geometry.index?.count);
    observeShadowValue(content,geometry.drawRange.start);observeShadowValue(content,geometry.drawRange.count);
    for(const group of geometry.groups){observeShadowValue(content,group.start);observeShadowValue(content,group.count);observeShadowValue(content,group.materialIndex);}
    observeShadowValue(content,'attributes');
    for(const name in geometry.attributes){
      if(!Object.hasOwn(geometry.attributes,name))continue;
      const attribute=geometry.attributes[name],buffer='data' in attribute?attribute.data:attribute;
      observeShadowValue(content,name);observeShadowValue(content,attribute);observeShadowValue(content,buffer.array);
      observeShadowValue(content,buffer.version);observeShadowValue(content,attribute.count);
      observeShadowValue(content,attribute.itemSize);observeShadowValue(content,attribute.normalized);
    }
    return this.finishShadowSnapshot(content)||changed;
  }
  private observeShadowMaterial(material:THREE.Material):boolean {
    let snapshot=this.shadowMaterialContent.get(material);
    if(snapshot?.frame===this.validation.frame)return snapshot.changed;
    if(!snapshot){snapshot=shadowSnapshot();this.shadowMaterialContent.set(material,snapshot);}
    this.beginShadowSnapshot(snapshot);
    const fields=material as unknown as Record<string,unknown>;
    for(const key of shadowMaterialFields)observeShadowValue(snapshot,fields[key]);
    for(const key of ['map','alphaMap','displacementMap']){
      const texture=fields[key] as THREE.Texture|undefined;
      observeShadowValue(snapshot,texture);observeShadowValue(snapshot,texture?.version);
      if(texture){
        observeShadowValue(snapshot,texture.matrixAutoUpdate);
        for(const value of texture.matrix.elements)observeShadowValue(snapshot,value);
        observeShadowValue(snapshot,texture.offset.x);observeShadowValue(snapshot,texture.offset.y);
        observeShadowValue(snapshot,texture.repeat.x);observeShadowValue(snapshot,texture.repeat.y);
        observeShadowValue(snapshot,texture.center.x);observeShadowValue(snapshot,texture.center.y);observeShadowValue(snapshot,texture.rotation);
      }
    }
    for(const plane of material.clippingPlanes??[]){
      observeShadowValue(snapshot,plane.normal.x);observeShadowValue(snapshot,plane.normal.y);
      observeShadowValue(snapshot,plane.normal.z);observeShadowValue(snapshot,plane.constant);
    }
    return this.finishShadowSnapshot(snapshot);
  }

  private sourceShadowVisibility(state:SourceState):boolean|undefined {
    if(!state.descriptor.source.castShadow)return false;
    return this.scene?visibleInSourceGraph(state.descriptor.source,this.scene):undefined;
  }
  private queueSourceShadowBounds(state:SourceState,currentVisible:boolean|undefined):void {
    if(!state.shadowVisible&&currentVisible===false)return;
    if(currentVisible===undefined){this.pendingShadowFull=true;return;}
    const bounds=state.descriptor.worldBox;
    if(bounds.isEmpty())return;
    if(![bounds.min.x,bounds.min.y,bounds.min.z,bounds.max.x,bounds.max.y,bounds.max.z].every(Number.isFinite)){
      this.pendingShadowFull=true;return;
    }
    const key=state.cell?.key??String(state.descriptor.source.userData.spatialCell??state.descriptor.source.uuid);
    const previous=this.pendingShadowBounds.get(key);
    if(previous)previous.union(bounds);else this.pendingShadowBounds.set(key,bounds.clone());
  }

  private geometryState(geometry: THREE.BufferGeometry, validationFrame = 0): GeometryState {
    let state = this.geometryStates.get(geometry);
    if (validationFrame && state?.validationFrame === validationFrame) return state;
    const attribute = geometry.getAttribute('position');
    const buffer = 'data' in attribute ? attribute.data : attribute;
    if (!state || state.attributes[0] !== attribute || state.arrays[0] !== buffer.array || state.versions[0] !== buffer.version) {
      const box = new THREE.Box3(), sphere = new THREE.Sphere();
      if (!copyStreamGeometryBounds(geometry, box, sphere)) {
        box.setFromBufferAttribute(attribute as THREE.BufferAttribute);
        box.getBoundingSphere(sphere);
        // Generic or modified geometries still use their actual positions;
        // manually assigned public bounds cannot suppress visible instances.
        let radiusSquared = 0;
        const point = new THREE.Vector3();
        for (let i = 0; i < attribute.count; i++) radiusSquared = Math.max(radiusSquared, sphere.center.distanceToSquared(point.fromBufferAttribute(attribute, i)));
        sphere.radius = Math.sqrt(radiusSquared);
      }
      state = { attributes: [attribute], arrays: [buffer.array], versions: [buffer.version], box, sphere, revision: (state?.revision ?? 0) + 1, validationFrame };
      this.geometryStates.set(geometry, state);
    }
    state.validationFrame = validationFrame;
    return state;
  }

  private refresh(state: SourceState, validation?: PrepareValidation,forceAuthored=false): void {
    const source = state.descriptor.source;
    const immutable=this.options.isImmutableSource?.(source)===true;
    const fast=!!validation&&immutable&&state.immutableValidated===true&&!forceAuthored;
    const reason=fast?(validation.geometry(source.geometry)??unsupportedSourceMaterials(source,this.options,validation)):unsupportedReason(source,this.options,validation);
    if (reason) throw new Error(`${source.name || source.uuid}: ${reason}`);
    if (!fast&&(!Number.isInteger(source.count) || source.count > state.capacity || source.count > source.instanceMatrix.count || source.count < 0)) throw new Error('Canonical capacity changed; rebuild the adapter before suppressing source drawing');
    state.immutableValidated=immutable;
    const worldElements = source.matrixWorld.elements, previousElements = state.worldMatrix.elements;
    let worldChanged = false;
    for (let index = 0; index < 16; index++) {
      const value = worldElements[index];
      if (value !== previousElements[index]) {
        if (!Number.isFinite(value)) throw new Error('Canonical world transforms must be finite');
        worldChanged = true;
      }
    }
    const geometry = this.geometryState(source.geometry, validation?.frame);
    const displacement = displacementPadding(source, validation);
    if(fast&&!worldChanged&&state.geometry===source.geometry&&state.geometryRevision===geometry.revision&&state.displacement===displacement)return;
    const matrix = source.instanceMatrix, color = source.instanceColor;
    const sortCenter = source.boundingSphere?.center;
    const changed = state.count !== source.count || state.geometry !== source.geometry || state.geometryRevision !== geometry.revision ||
      state.matrixAttribute !== matrix || state.matrixArray !== matrix.array || state.matrixVersion !== matrix.version ||
      state.colorAttribute !== color || state.colorArray !== color?.array || state.colorVersion !== (color?.version ?? -1) ||
      worldChanged || state.displacement !== displacement ||
      Boolean(state.sortCenter) !== Boolean(sortCenter) || Boolean(sortCenter && !state.sortCenter?.equals(sortCenter));
    if (!changed) return;
    const shadowVisible=this.sourceShadowVisibility(state);
    this.queueSourceShadowBounds(state,shadowVisible);
    state.count = source.count; state.geometry = source.geometry; state.geometryRevision = geometry.revision;
    state.matrixAttribute = matrix; state.matrixArray = matrix.array; state.matrixVersion = matrix.version;
    state.colorAttribute = color; state.colorArray = color?.array; state.colorVersion = color?.version ?? -1;
    state.worldMatrix.copy(source.matrixWorld); state.displacement = displacement; state.revision++;
    this.shadowContentRevision++;
    state.sortCenter = sortCenter?.clone();
    state.matrices.set((matrix.array as Float32Array).subarray(0, source.count * 16));
    const local = new THREE.Matrix4(), world = new THREE.Matrix4(), nativeSphere = new THREE.Sphere();
    const localBox = new THREE.Box3(), point = new THREE.Vector3();
    const descriptor = state.descriptor;
    descriptor.localBox.makeEmpty(); descriptor.worldBox.makeEmpty();
    descriptor.localSphere.makeEmpty();
    const prototypeBox = geometry.box.clone().expandByScalar(displacement);
    for (let i = 0; i < source.count; i++) {
      local.fromArray(state.matrices, i * 16);
      if (!local.elements.every(Number.isFinite)) throw new Error('Instance transforms must be finite');
      world.multiplyMatrices(source.matrixWorld, local);
      descriptor.localBox.union(localBox.copy(prototypeBox).applyMatrix4(local));
      descriptor.worldBox.union(localBox.copy(prototypeBox).applyMatrix4(world));
      // Three unions instance spheres in canonical slot order; preserve its
      // center exactly because WebGLRenderer uses it for opaque depth sorting.
      descriptor.localSphere.union(nativeSphere.copy(geometry.sphere).applyMatrix4(local));
      // Transform all eight prototype-box corners through the full affine world
      // matrix. This remains conservative under rotation, nonuniform scale and
      // shear, and avoids the empty space of tall-tree circumscribed spheres.
      const offset = i * 6;
      state.bounds[offset] = (localBox.min.x + localBox.max.x) * .5;
      state.bounds[offset + 1] = (localBox.min.y + localBox.max.y) * .5;
      state.bounds[offset + 2] = (localBox.min.z + localBox.max.z) * .5;
      state.bounds[offset + 3] = (localBox.max.x - localBox.min.x) * .5;
      state.bounds[offset + 4] = (localBox.max.y - localBox.min.y) * .5;
      state.bounds[offset + 5] = (localBox.max.z - localBox.min.z) * .5;
    }
    // A caller-provided canonical sphere center is also part of its sort key.
    if (source.boundingSphere) descriptor.localSphere.center.copy(source.boundingSphere.center);
    if (source.count) {
      const center = descriptor.localSphere.center;
      const dx = Math.max(Math.abs(descriptor.localBox.min.x - center.x), Math.abs(descriptor.localBox.max.x - center.x));
      const dy = Math.max(Math.abs(descriptor.localBox.min.y - center.y), Math.abs(descriptor.localBox.max.y - center.y));
      const dz = Math.max(Math.abs(descriptor.localBox.min.z - center.z), Math.abs(descriptor.localBox.max.z - center.z));
      const nativeWorldStretch = source.matrixWorld.getMaxScaleOnAxis();
      descriptor.localSphere.radius = Math.hypot(dx, dy, dz) * (nativeWorldStretch ? maximumStretch(source.matrixWorld) / nativeWorldStretch : 1);
    }
    descriptor.worldBox.getBoundingSphere(descriptor.worldSphere);
    state.tree = source.count ? makeTree(Array.from({ length: source.count }, (_, i) => i), state.bounds) : undefined;
    for (const draw of state.draws) {
      draw.proxy.boundingBox ??= new THREE.Box3(); draw.proxy.boundingSphere ??= new THREE.Sphere();
      if (color && (!draw.proxy.instanceColor || draw.proxy.instanceColor.itemSize !== color.itemSize || draw.proxy.instanceColor.array.constructor !== color.array.constructor || draw.proxy.instanceColor.normalized !== color.normalized)) {
        const cloned = color.clone() as THREE.InstancedBufferAttribute;
        cloned.setUsage(THREE.DynamicDrawUsage); draw.proxy.instanceColor = cloned;
      } else if (!color) draw.proxy.instanceColor = null;
    }
    // Keep this check outside per-frame selection loops.
    descriptor.worldBox.getCenter(point);
    if (!point.toArray().every(Number.isFinite)) throw new Error('Canonical world bounds must be finite');
    // Cells use the union of complete source bounds, not their pivots or nominal
    // 160m footprint. A large crown/building crossing a cell edge cannot vanish.
    const key=String(source.userData.spatialCell??`${Math.floor(point.x/160)},${Math.floor(point.z/160)}`);
    if(state.cell?.key!==key){
      if(state.cell){state.cell.sources.delete(state);state.cell.dirty=true;if(!state.cell.sources.size)this.spatialCells.delete(state.cell.key);}
      let cell=this.spatialCells.get(key);
      if(!cell){cell={key,sources:new Set(),bounds:new THREE.Box3(),dirty:true,volumes:[],classifications:[],
        allPreparedPassesRejected:undefined,frustumOnlyVolume:undefined,frustumOnlyClassification:undefined,drawsInactive:undefined,activePassMask:0};this.spatialCells.set(key,cell);}
      state.cell=cell;cell.sources.add(state);
    }
    state.cell.dirty=true;state.cell.drawsInactive=false;
    this.queueSourceShadowBounds(state,shadowVisible);
  }

  private select(state: SourceState, draw: DrawState, volume: CompiledVolume, statistics: InstancePassStatistics,cellClassification=0,coarse=false): void {
    const box = state.descriptor.worldBox;
    const batch = cellClassification>0?1:classify(volume, (box.min.x + box.max.x) * .5, (box.min.y + box.max.y) * .5, (box.min.z + box.max.z) * .5,
      (box.max.x - box.min.x) * .5, (box.max.y - box.min.y) * .5, (box.max.z - box.min.z) * .5);
    if (batch < 0) { statistics.batchRejected++; return; }
    if (batch > 0||coarse) {
      statistics.batchAccepted++;
      if(draw.identityCount!==state.count){for(let i=0;i<state.count;i++)draw.indices[i]=i;draw.identityCount=state.count;}
      draw.selected=state.count;
      return;
    }
    draw.identityCount=undefined;
    const collect = (node: TreeNode, full = false): void => {
      const bounds = node.bounds;
      const result = full ? 1 : classify(volume, bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]);
      if (result < 0) return;
      if (node.indices) {
        for (const index of node.indices) {
          const offset = index * 6, data = state.bounds;
          if (result > 0 || (statistics.boundsTests++, classify(volume, data[offset], data[offset + 1], data[offset + 2], data[offset + 3], data[offset + 4], data[offset + 5]) >= 0)) draw.indices[draw.selected++] = index;
        }
      } else { collect(node.left!, result > 0); collect(node.right!, result > 0); }
    };
    if (state.tree) collect(state.tree);
    // Stable canonical order retains opaque depth tie behavior and identity maps.
    draw.indices.subarray(0, draw.selected).sort();
  }

  private uploadSelection(state: SourceState, draw: DrawState): boolean {
    // An empty draw does not overwrite its GPU buffer. Keep the last exact
    // sequence so reentering the same view can reuse it after invisible frames.
    if (!draw.selected) return false;
    if (draw.uploadedSelected === draw.selected && draw.uploadedRevision === state.revision) {
      if(draw.identityCount===draw.selected&&draw.uploadedIdentityCount===draw.selected)return false;
      let identical = true;
      for (let slot = 0; slot < draw.selected; slot++) if (draw.uploadedIndices[slot] !== draw.indices[slot]) { identical = false; break; }
      if (identical) return false;
    }
    const matrices = draw.proxy.instanceMatrix.array, color = state.descriptor.source.instanceColor;
    for (let slot = 0; slot < draw.selected; slot++) {
      const original = draw.indices[slot];
      draw.uploadedIndices[slot] = original;
      for (let component = 0; component < 16; component++) matrices[slot * 16 + component] = state.matrices[original * 16 + component];
      if (color && draw.proxy.instanceColor) for (let component = 0; component < color.itemSize; component++) draw.proxy.instanceColor.array[slot * color.itemSize + component] = color.array[original * color.itemSize + component];
    }
    draw.proxy.instanceMatrix.clearUpdateRanges(); draw.proxy.instanceMatrix.addUpdateRange(0, draw.selected * 16); draw.proxy.instanceMatrix.needsUpdate = true;
    if (draw.proxy.instanceColor) {
      draw.proxy.instanceColor.clearUpdateRanges(); draw.proxy.instanceColor.addUpdateRange(0, draw.selected * draw.proxy.instanceColor.itemSize); draw.proxy.instanceColor.needsUpdate = true;
    }
    draw.uploadedSelected = draw.selected; draw.uploadedRevision = state.revision;
    draw.uploadedIdentityCount=draw.identityCount===draw.selected?draw.selected:undefined;
    return true;
  }
}
