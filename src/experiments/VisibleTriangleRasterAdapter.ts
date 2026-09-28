import {
  BufferAttribute, DataTexture, DynamicDrawUsage, FloatType, InstancedBufferAttribute,
  InstancedBufferGeometry, IntType, Material, Matrix3, Matrix4, Mesh, MeshStandardMaterial,
  NearestFilter, NoColorSpace, RGBAFormat, RGBAIntegerFormat, UnsignedIntType,
  Vector3, type Camera, type WebGLRenderer,
} from 'three';

/** Experimental WebGL2 vertex pulling. Nothing in the production renderer imports this file. */
export const VISIBLE_TRIANGLE_ABI = 'original-triangle-raster-v1';
const ABSENT = 0xffffffff;
const INSTANCE_INSTANCED = 1;
const INSTANCE_COLOR = 2;
const INSTANCE_MIRRORED_BATCH = 4;
const BATCH_FLOATS = 44; // model[16], modelView[16], padded normal columns[12].

export interface OriginalAttribute {
  array: Float32Array | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array;
  itemSize: number;
  normalized?: boolean;
}
export interface OriginalGeometry {
  vertexOffset: number;
  vertexCount: number;
  triangleOffset: number;
  triangleCount: number;
  normal: OriginalAttribute;
  uv?: OriginalAttribute;
  uv1?: OriginalAttribute;
  uv2?: OriginalAttribute;
  uv3?: OriginalAttribute;
  color?: OriginalAttribute;
  tangent?: OriginalAttribute;
}
export interface OriginalBatch {
  /** Original source.matrixWorld, retained in double precision until native Float32 upload. */
  matrixWorld: Matrix4;
  instanced: boolean;
}
export interface OriginalInstance {
  geometry: number;
  batch: number;
  material: number;
  /** Original Float32 instanceMatrix; use identity for an ordinary Mesh. */
  matrix: Float32Array;
  color?: Float32Array;
}
export interface OriginalTriangleInput {
  positions: Float32Array;
  /** Global vertex indices in exactly the visibility producer's triangle order. */
  triangles: Uint32Array;
  geometries: readonly OriginalGeometry[];
  batches: readonly OriginalBatch[];
  instances: readonly OriginalInstance[];
  /** Must not exceed the actual WebGL2 MAX_TEXTURE_SIZE; 16384 is an upper limit, not a probe. */
  maxTextureSize?: number;
  /** D3D11/WebGL backend resource limits can be lower than MAX_TEXTURE_SIZE squared. */
  maxFloatPageBytes?: number;
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= ABSENT) throw new Error(`Invalid ${name}`);
}
export function packedTextureShape(scalars: number, maximum = 16384): { width: number; height: number } {
  integer(scalars, 'texture scalar count');
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16384) throw new Error('Invalid texture limit');
  const texels = Math.max(1, Math.ceil(scalars / 4));
  if (texels > maximum * maximum) throw new Error('Lossless atlas exceeds texture capacity; split the dataset');
  const width = Math.min(maximum, texels);
  return { width, height: Math.ceil(texels / width) };
}
function makeTexture(data: Float32Array | Uint32Array, maximum: number): DataTexture {
  const { width, height } = packedTextureShape(data.length, maximum);
  const storage = data.length === width * height * 4 ? data
    : data instanceof Float32Array ? new Float32Array(width * height * 4) : new Uint32Array(width * height * 4);
  if (storage !== data) storage.set(data);
  const texture = new DataTexture(storage, width, height, data instanceof Float32Array ? RGBAFormat : RGBAIntegerFormat,
    data instanceof Float32Array ? FloatType : UnsignedIntType);
  texture.internalFormat = data instanceof Float32Array ? 'RGBA32F' : 'RGBA32UI';
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.colorSpace = NoColorSpace;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Directly populated lossless pages: no extra multi-gigabyte contiguous staging copy. */
class FloatPages {
  readonly arrays: Float32Array[] = [];
  readonly scalarsPerPage: number;
  constructor(count: number, maximum: number, pageBytes: number) {
    if (!Number.isSafeInteger(pageBytes) || pageBytes < 16 || pageBytes > 1073741824) throw new Error('Float pages must be between 16 bytes and 1 GiB');
    const texels = Math.min(maximum * maximum, Math.floor(pageBytes / 16));
    const width = Math.min(maximum, texels), height = Math.floor(texels / width);
    this.scalarsPerPage = width * height * 4;
    const pages = Math.max(1, Math.ceil(count / this.scalarsPerPage));
    if (pages > 3) throw new Error('Lossless float data exceeds three texture pages; split the dataset');
    for (let p = 0; p < pages; p++) {
      const shape = packedTextureShape(Math.min(this.scalarsPerPage, Math.max(0, count - p * this.scalarsPerPage)), maximum);
      this.arrays.push(new Float32Array(shape.width * shape.height * 4));
    }
  }
  set(source: Float32Array, offset: number): void {
    let start = 0;
    while (start < source.length) {
      const page = Math.floor(offset / this.scalarsPerPage), local = offset % this.scalarsPerPage;
      const length = Math.min(source.length - start, this.scalarsPerPage - local);
      this.arrays[page].set(source.subarray(start, start + length), local);
      start += length; offset += length;
    }
  }
  put(offset: number, value: number): void { this.arrays[Math.floor(offset / this.scalarsPerPage)][offset % this.scalarsPerPage] = value; }
  get(offset: number): number { return this.arrays[Math.floor(offset / this.scalarsPerPage)][offset % this.scalarsPerPage]; }
}
function attributeValue(attribute: OriginalAttribute, index: number): number {
  const value = attribute.array[index];
  if (!attribute.normalized || attribute.array instanceof Float32Array) return value;
  if (attribute.array instanceof Uint8Array) return value / 255;
  if (attribute.array instanceof Int8Array) return Math.max(value / 127, -1);
  if (attribute.array instanceof Uint16Array) return value / 65535;
  if (attribute.array instanceof Int16Array) return Math.max(value / 32767, -1);
  if (attribute.array instanceof Uint32Array) return value / 4294967295;
  return Math.max(value / 2147483647, -1);
}
function checkedAttribute(attribute: OriginalAttribute | undefined, count: number, sizes: number[], name: string): number {
  if (!attribute) return 0;
  if (!sizes.includes(attribute.itemSize) || attribute.array.length !== count * attribute.itemSize) throw new Error(`Invalid ${name} attribute`);
  return attribute.array.length;
}

/** Owns only its new atlases and CPU transform snapshots, never the canonical source arrays/materials. */
export class OriginalTriangleAtlas {
  readonly floatTextures: DataTexture[];
  readonly floatPageScalars: number;
  readonly integerTexture: DataTexture;
  readonly batchTexture: DataTexture;
  readonly geometryOffset: number;
  readonly instanceOffset: number;
  readonly triangleCount: number;
  readonly instanceCount: number;
  private readonly batchMatrices: Matrix4[];
  private readonly batchInstanced: boolean[];
  private readonly modelView = new Matrix4();
  private readonly normal = new Matrix3();
  private readonly inputBatch = new Matrix4();
  private readonly previousView = new Matrix4();
  private hasView = false;
  private disposed = false;
  private attachedAdapters = 0;
  private readonly floatPages: FloatPages;

  constructor(input: OriginalTriangleInput) {
    const maximum = input.maxTextureSize ?? 16384;
    if (input.positions.length % 3 || input.triangles.length % 3) throw new Error('Incomplete vertex or triangle');
    this.triangleCount = input.triangles.length / 3;
    this.instanceCount = input.instances.length;
    integer(this.triangleCount, 'triangle count');
    integer(this.instanceCount, 'instance count');
    this.geometryOffset = this.triangleCount; // uint texel offsets.
    this.instanceOffset = this.geometryOffset + input.geometries.length * 3;
    const attributeNames = ['normal', 'uv', 'uv1', 'uv2', 'uv3', 'color', 'tangent'] as const;
    let floatCount = input.positions.length;
    for (const g of input.geometries) {
      for (const [name, value] of Object.entries({ vertexOffset: g.vertexOffset, vertexCount: g.vertexCount, triangleOffset: g.triangleOffset, triangleCount: g.triangleCount })) integer(value, name);
      if (g.vertexOffset + g.vertexCount > input.positions.length / 3 || g.triangleOffset + g.triangleCount > this.triangleCount) throw new Error('Geometry outside global arrays');
      if (!g.normal) throw new Error('Canonical normal attribute is required');
      for (const key of attributeNames) floatCount += checkedAttribute(g[key], g.vertexCount, key === 'color' ? [3, 4] : key === 'normal' ? [3] : key === 'tangent' ? [4] : [2], key);
    }
    for (const instance of input.instances) floatCount += 16 + (instance.color ? 3 : 0);
    // Check all capacities before creating the staging arrays.
    // Validate texture dimensions separately from the D3D11 per-resource byte limit.
    packedTextureShape(0, maximum);
    packedTextureShape((this.instanceOffset + input.instances.length * 2) * 4, maximum);
    packedTextureShape(input.batches.length * BATCH_FLOATS, maximum);
    const us = packedTextureShape((this.instanceOffset + input.instances.length * 2) * 4, maximum);
    if (us.width * us.height * 16 > 1073741824) throw new Error('Integer atlas exceeds 1 GiB; split the dataset');
    const floats = this.floatPages = new FloatPages(floatCount, maximum, input.maxFloatPageBytes ?? 1073741824);
    this.floatPageScalars = floats.scalarsPerPage;
    const words = new Uint32Array(us.width * us.height * 4);
    const owners = new Int32Array(this.triangleCount).fill(-1);
    floats.set(input.positions, 0);
    let cursor = input.positions.length;
    input.geometries.forEach((g, geometryId) => {
      const offsets: Record<string, number> = {};
      for (const key of attributeNames) {
        const attribute = g[key]; offsets[key] = ABSENT;
        if (!attribute) continue;
        offsets[key] = cursor;
        if (attribute.array instanceof Float32Array) floats.set(attribute.array, cursor);
        else for (let n = 0; n < attribute.array.length; n++) floats.put(cursor + n, attributeValue(attribute, n));
        cursor += attribute.array.length;
      }
      const base = (this.geometryOffset + geometryId * 3) * 4;
      words.set([g.vertexOffset, g.vertexCount, offsets.normal, offsets.color], base);
      words.set([offsets.uv, offsets.uv1, offsets.uv2, offsets.uv3], base + 4);
      words.set([offsets.tangent, g.color?.itemSize ?? 0, g.triangleOffset, g.triangleCount], base + 8);
      for (let t = g.triangleOffset; t < g.triangleOffset + g.triangleCount; t++) {
        if (owners[t] !== -1) throw new Error('Overlapping triangle ownership');
        owners[t] = geometryId;
        for (let corner = 0; corner < 3; corner++) {
          const vertex = input.triangles[t * 3 + corner];
          if (vertex < g.vertexOffset || vertex >= g.vertexOffset + g.vertexCount) throw new Error('Triangle crosses geometry vertex ranges');
          words[t * 4 + corner] = vertex;
        }
        words[t * 4 + 3] = geometryId;
      }
    });
    if (owners.some(owner => owner < 0)) throw new Error('Every original triangle needs one geometry owner');
    this.batchMatrices = input.batches.map(batch => batch.matrixWorld.clone());
    this.batchInstanced = input.batches.map(batch => batch.instanced);
    input.instances.forEach((instance, instanceId) => {
      for (const [name, value] of Object.entries({ geometry: instance.geometry, batch: instance.batch, material: instance.material })) integer(value, name);
      if (instance.geometry >= input.geometries.length || instance.batch >= input.batches.length) throw new Error('Invalid instance owner');
      if (instance.matrix.length !== 16 || (instance.color && instance.color.length !== 3)) throw new Error('Invalid original instance matrix/color');
      const batch = input.batches[instance.batch];
      const matrix = new Matrix4().fromArray(instance.matrix);
      if (!batch.instanced && (!matrix.equals(new Matrix4()) || instance.color)) throw new Error('Ordinary Mesh needs identity instance matrix and no instance color');
      // Three does not support negative InstancedMesh matrices; reflection belongs to its batch.
      if (matrix.determinant() <= 0) throw new Error('Nonpositive instance determinant is outside native InstancedMesh support');
      const determinant = batch.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) throw new Error('Singular/nonfinite batch matrix');
      const flags = (batch.instanced ? INSTANCE_INSTANCED : 0) | (instance.color ? INSTANCE_COLOR : 0) | (determinant < 0 ? INSTANCE_MIRRORED_BATCH : 0);
      const matrixOffset = cursor;
      floats.set(instance.matrix, cursor); cursor += 16;
      const colorOffset = instance.color ? cursor : ABSENT;
      if (instance.color) { floats.set(instance.color, cursor); cursor += 3; }
      const base = (this.instanceOffset + instanceId * 2) * 4;
      words.set([instance.geometry, instance.batch, instance.material, flags, matrixOffset, colorOffset, 0, 0], base);
    });
    if (floats.arrays.some(page => page.some(value => !Number.isFinite(value)))) throw new Error('Nonfinite canonical attribute/matrix');
    this.floatTextures = floats.arrays.map(page => makeTexture(page, maximum));
    this.integerTexture = makeTexture(words, maximum);
    this.batchTexture = makeTexture(new Float32Array(input.batches.length * BATCH_FLOATS), maximum);
  }

  /** Call before each camera/pass, using the same updated camera.matrixWorldInverse as Three. */
  prepareView(camera: Pick<Camera, 'matrixWorldInverse'>): boolean {
    this.assertAlive();
    if (this.hasView && this.previousView.equals(camera.matrixWorldInverse)) return false;
    this.previousView.copy(camera.matrixWorldInverse); this.hasView = true;
    const storage = this.batchTexture.image.data as Float32Array;
    for (let i = 0; i < this.batchMatrices.length; i++) {
      const matrix = this.batchMatrices[i], base = i * BATCH_FLOATS;
      matrix.toArray(storage, base);
      this.modelView.multiplyMatrices(camera.matrixWorldInverse, matrix).toArray(storage, base + 16);
      this.normal.getNormalMatrix(this.modelView);
      for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) storage[base + 32 + col * 4 + row] = this.normal.elements[col * 3 + row];
    }
    this.batchTexture.needsUpdate = true;
    return true;
  }

  /** Explicit source transform update. Reflection parity cannot change inside an existing draw. */
  setBatchMatrix(batch: number, matrix: Matrix4): void {
    this.assertAlive();
    if (!this.batchMatrices[batch]) throw new Error('Unknown batch');
    const oldSign = Math.sign(this.batchMatrices[batch].determinant()), determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || Math.sign(determinant) !== oldSign) throw new Error('Changing winding requires rebuilding draw groups');
    this.batchMatrices[batch].copy(matrix); this.hasView = false;
  }
  assertPrepared(camera?: Pick<Camera, 'matrixWorldInverse'>): void {
    this.assertAlive();
    if (!this.hasView || (camera && !this.previousView.equals(camera.matrixWorldInverse))) throw new Error('prepareView is required for the current camera before drawing');
  }
  private assertAlive(): void { if (this.disposed) throw new Error('Triangle atlas is disposed'); }
  attach(): void { this.assertAlive(); this.attachedAdapters++; }
  detach(): void { this.attachedAdapters--; }
  dispose(): void {
    if (this.disposed) return;
    if (this.attachedAdapters) throw new Error('Dispose adapters before their shared atlas');
    this.disposed = true;
    for (const texture of [...this.floatTextures, this.integerTexture, this.batchTexture]) {
      texture.dispose(); texture.image.data = new Uint8Array(0);
    }
    this.batchMatrices.length = 0; this.batchInstanced.length = 0;
    this.floatPages.arrays.length = 0; this.floatTextures.length = 0;
  }

  /** CPU oracle for packing/normal-transform tests and identity inspection; never the draw path. */
  reference(instanceId: number, triangleId: number, corner: number): {
    vertexId: number; position: Vector3; normal: Vector3; worldPosition: Vector3; viewPosition: Vector3; viewNormal: Vector3;
  } {
    this.assertPrepared();
    integer(instanceId, 'instance'); integer(triangleId, 'triangle'); integer(corner, 'corner');
    if (instanceId >= this.instanceCount || triangleId >= this.triangleCount || corner > 2) throw new Error('Reference outside atlas');
    const words = this.integerTexture.image.data as Uint32Array, floats = this.floatPages;
    const instanceBase = (this.instanceOffset + instanceId * 2) * 4, geometry = words[instanceBase], batch = words[instanceBase + 1];
    if (words[triangleId * 4 + 3] !== geometry) throw new Error('Triangle does not belong to instance geometry');
    const g = (this.geometryOffset + geometry * 3) * 4, vertexId = words[triangleId * 4 + corner], local = vertexId - words[g];
    const p = vertexId * 3, no = words[g + 2] + local * 3;
    const position = new Vector3(floats.get(p), floats.get(p + 1), floats.get(p + 2));
    const normal = new Vector3(floats.get(no), floats.get(no + 1), floats.get(no + 2));
    const sourceInstance = this.inputBatch;
    for (let n = 0; n < 16; n++) sourceInstance.elements[n] = floats.get(words[instanceBase + 4] + n);
    const instancePosition = position.clone(), objectNormal = normal.clone();
    if (this.batchInstanced[batch]) {
      instancePosition.applyMatrix4(sourceInstance);
      const e = sourceInstance.elements;
      objectNormal.divide(new Vector3(e[0] ** 2 + e[1] ** 2 + e[2] ** 2, e[4] ** 2 + e[5] ** 2 + e[6] ** 2, e[8] ** 2 + e[9] ** 2 + e[10] ** 2));
      objectNormal.applyMatrix3(new Matrix3().setFromMatrix4(sourceInstance));
    }
    const batchStorage = this.batchTexture.image.data as Float32Array, base = batch * BATCH_FLOATS;
    const model = new Matrix4().fromArray(batchStorage, base), modelView = new Matrix4().fromArray(batchStorage, base + 16);
    const n = new Matrix3(); for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) n.elements[col * 3 + row] = batchStorage[base + 32 + col * 4 + row];
    return { vertexId, position, normal, worldPosition: instancePosition.clone().applyMatrix4(model), viewPosition: instancePosition.applyMatrix4(modelView), viewNormal: objectNormal.applyMatrix3(n).normalize() };
  }
}

export interface VisibleTriangleOptions {
  materialId: number;
  capacity: number;
  /** Consecutive original triangles per pair; aligned to its geometry's triangleOffset. */
  trianglesPerReference?: 1 | 8 | 32 | 64;
  /** Original batch shader features; references with another signature are rejected. */
  instanced: boolean;
  instanceColors?: boolean;
  vertexColorSize?: 0 | 3 | 4;
  tangents?: boolean;
  mirroredBatch?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  layersMask?: number;
  /** Re-register identity-sensitive hooks, especially CSM.setupMaterial(clone), then return cleanup. */
  configureClone?: (clone: MeshStandardMaterial) => void | (() => void);
  /** Required for textured alpha cutouts or displaced vertices; a nearest geometric hit is insufficient. */
  selectionCoversAlphaAndDisplacement?: boolean;
  /** Custom hooks must be audited for use of vertex/instance IDs or extra attributes. */
  customHooksCompatible?: boolean;
}

const PULL_DECLARATIONS = /* glsl */`
uniform highp sampler2D exactFloatData0;
uniform highp sampler2D exactFloatData1;
uniform highp sampler2D exactFloatData2;
uniform highp usampler2D exactIntegerData;
uniform highp sampler2D exactBatchData;
uniform highp uint exactGeometryOffset;
uniform highp uint exactInstanceOffset;
uniform highp uint exactFloatPageTexels;
attribute uvec2 exactTriangleReference;
vec4 exactFetchF(uint texel) {
  uint page = texel / exactFloatPageTexels;
  uint local = texel % exactFloatPageTexels;
  // Constant sampler branches avoid unsupported dynamically indexed sampler arrays in GLSL ES.
  if (page == 0u) {
    uint width = uint(textureSize(exactFloatData0, 0).x);
    return texelFetch(exactFloatData0, ivec2(int(local % width), int(local / width)), 0);
  }
  if (page == 1u) {
    uint width = uint(textureSize(exactFloatData1, 0).x);
    return texelFetch(exactFloatData1, ivec2(int(local % width), int(local / width)), 0);
  }
  uint width = uint(textureSize(exactFloatData2, 0).x);
  return texelFetch(exactFloatData2, ivec2(int(local % width), int(local / width)), 0);
}
float exactScalar(uint scalar) { return exactFetchF(scalar / 4u)[int(scalar % 4u)]; }
vec2 exactVec2(uint s) { return vec2(exactScalar(s), exactScalar(s + 1u)); }
vec3 exactVec3(uint s) { return vec3(exactScalar(s), exactScalar(s + 1u), exactScalar(s + 2u)); }
vec4 exactVec4(uint s) { return vec4(exactScalar(s), exactScalar(s + 1u), exactScalar(s + 2u), exactScalar(s + 3u)); }
uvec4 exactFetchU(uint texel) {
  uint width = uint(textureSize(exactIntegerData, 0).x);
  return texelFetch(exactIntegerData, ivec2(int(texel % width), int(texel / width)), 0);
}
vec4 exactFetchBatch(uint texel) {
  uint width = uint(textureSize(exactBatchData, 0).x);
  return texelFetch(exactBatchData, ivec2(int(texel % width), int(texel / width)), 0);
}
vec3 exactPosition, exactNormal, exactInstanceColor;
vec4 exactColor, exactTangent;
vec2 exactUv, exactUv1, exactUv2, exactUv3;
mat4 exactModelMatrix, exactModelViewMatrix, exactInstanceMatrix;
mat3 exactNormalMatrix;
void exactLoadOriginalVertex() {
  uvec4 instance0 = exactFetchU(exactInstanceOffset + exactTriangleReference.x * 2u);
  uvec4 instance1 = exactFetchU(exactInstanceOffset + exactTriangleReference.x * 2u + 1u);
  uint geometryBase = exactGeometryOffset + instance0.x * 3u;
  uvec4 geo0 = exactFetchU(geometryBase), geo1 = exactFetchU(geometryBase + 1u), geo2 = exactFetchU(geometryBase + 2u);
  uint triangleId = exactTriangleReference.y + uint(gl_VertexID) / 3u;
  bool paddingTriangle = triangleId >= geo2.z + geo2.w;
  uvec4 tri = exactFetchU(min(triangleId, geo2.z + geo2.w - 1u));
  // The final block's nonexistent triangles have all three vertices at exactly one original
  // vertex. This creates zero-area padding only; no original triangle is modified or omitted.
  uint vertex = tri[paddingTriangle ? 0 : int(uint(gl_VertexID) % 3u)];
  uint localVertex = vertex - geo0.x;
  exactPosition = exactVec3(vertex * 3u);
  exactNormal = exactVec3(geo0.z + localVertex * 3u);
  exactUv = geo1.x == 0xffffffffu ? vec2(0.0) : exactVec2(geo1.x + localVertex * 2u);
  exactUv1 = geo1.y == 0xffffffffu ? vec2(0.0) : exactVec2(geo1.y + localVertex * 2u);
  exactUv2 = geo1.z == 0xffffffffu ? vec2(0.0) : exactVec2(geo1.z + localVertex * 2u);
  exactUv3 = geo1.w == 0xffffffffu ? vec2(0.0) : exactVec2(geo1.w + localVertex * 2u);
  exactColor = vec4(1.0);
  if (geo0.w != 0xffffffffu) {
    uint colorStart = geo0.w + localVertex * geo2.y;
    exactColor.rgb = exactVec3(colorStart);
    if (geo2.y == 4u) exactColor.a = exactScalar(colorStart + 3u);
  }
  exactTangent = geo2.x == 0xffffffffu ? vec4(1.0, 0.0, 0.0, 1.0) : exactVec4(geo2.x + localVertex * 4u);
  uint im = instance1.x;
  exactInstanceMatrix = mat4(exactVec4(im), exactVec4(im + 4u), exactVec4(im + 8u), exactVec4(im + 12u));
  exactInstanceColor = instance1.y == 0xffffffffu ? vec3(1.0) : exactVec3(instance1.y);
  uint bm = instance0.y * 11u;
  exactModelMatrix = mat4(exactFetchBatch(bm), exactFetchBatch(bm + 1u), exactFetchBatch(bm + 2u), exactFetchBatch(bm + 3u));
  exactModelViewMatrix = mat4(exactFetchBatch(bm + 4u), exactFetchBatch(bm + 5u), exactFetchBatch(bm + 6u), exactFetchBatch(bm + 7u));
  exactNormalMatrix = mat3(exactFetchBatch(bm + 8u).xyz, exactFetchBatch(bm + 9u).xyz, exactFetchBatch(bm + 10u).xyz);
}
#define position exactPosition
#define normal exactNormal
#define uv exactUv
#define uv1 exactUv1
#define uv2 exactUv2
#define uv3 exactUv3
#define tangent exactTangent
#define modelMatrix exactModelMatrix
#define modelViewMatrix exactModelViewMatrix
#define normalMatrix exactNormalMatrix
#define instanceMatrix exactInstanceMatrix
#define instanceColor exactInstanceColor
`;

/** One opaque, shader-compatible draw group. Its visibility list is BEAUTY-ONLY. */
export class VisibleTriangleRasterAdapter {
  readonly mesh: Mesh<InstancedBufferGeometry, MeshStandardMaterial>;
  readonly references: InstancedBufferAttribute;
  private readonly releaseHook: (() => void) | undefined;
  private disposed = false;
  private readonly flags: number;

  constructor(readonly atlas: OriginalTriangleAtlas, source: MeshStandardMaterial, readonly options: VisibleTriangleOptions) {
    integer(options.materialId, 'material ID'); integer(options.capacity, 'reference capacity');
    if (options.capacity < 1) throw new Error('Positive reference capacity required');
    if (![1, 8, 32, 64].includes(options.trianglesPerReference ?? 1)) throw new Error('Unsupported original-triangle block size');
    if (source.type !== 'MeshStandardMaterial') throw new Error('This prototype supports MeshStandardMaterial only');
    if (source.transparent || source.blending !== 1 || !source.depthTest || !source.depthWrite || source.wireframe || source.alphaHash) throw new Error('Sparse nearest-hit rendering requires opaque, depth-writing triangles');
    if ((source.alphaTest > 0 || source.alphaToCoverage || source.displacementMap) && !options.selectionCoversAlphaAndDisplacement) throw new Error('Selection must cover alpha-tested/displaced coverage');
    if ((source.onBeforeCompile !== Material.prototype.onBeforeCompile || source.customProgramCacheKey !== Material.prototype.customProgramCacheKey || source.onBeforeRender !== Material.prototype.onBeforeRender)
      && (!options.configureClone || !options.customHooksCompatible)) throw new Error('Custom material hooks need an explicit compatible clone rebind');
    if ((options.vertexColorSize ?? 0) !== 0 && !source.vertexColors) throw new Error('Vertex-color signature does not match material');
    if (source.vertexColors && !options.vertexColorSize) throw new Error('Canonical vertex-color itemSize is required');
    if (options.instanceColors && !options.instanced) throw new Error('Instance color requires native instancing');
    const material = source.clone();
    const cleanup = options.configureClone?.(material);
    this.releaseHook = typeof cleanup === 'function' ? cleanup : undefined;
    const priorCompile = material.onBeforeCompile;
    const priorKey = material.customProgramCacheKey.call(material);
    const signature = [options.instanced, options.instanceColors, options.vertexColorSize ?? 0, options.tangents, options.mirroredBatch, options.trianglesPerReference ?? 1].join(':');
    material.customProgramCacheKey = () => `${priorKey}|${VISIBLE_TRIANGLE_ABI}|${signature}`;
    material.onBeforeCompile = function (shader, renderer) {
      priorCompile.call(this, shader, renderer);
      const main = /void\s+main\s*\(\s*\)\s*\{/g;
      if ([...shader.vertexShader.matchAll(main)].length !== 1 || !shader.vertexShader.includes('#include <project_vertex>') || !shader.vertexShader.includes('#include <defaultnormal_vertex>')) throw new Error('Original standard vertex chunks are required after material hooks');
      Object.assign(shader.uniforms, {
        exactFloatData0: { value: atlas.floatTextures[0] }, exactFloatData1: { value: atlas.floatTextures[1] ?? atlas.floatTextures[0] },
        exactFloatData2: { value: atlas.floatTextures[2] ?? atlas.floatTextures[0] }, exactIntegerData: { value: atlas.integerTexture }, exactBatchData: { value: atlas.batchTexture },
        exactGeometryOffset: { value: atlas.geometryOffset }, exactInstanceOffset: { value: atlas.instanceOffset },
        exactFloatPageTexels: { value: atlas.floatPageScalars / 4 },
      });
      // Global color varying guards must see this before their declarations; native attribute aliases
      // intentionally start only after all global includes, immediately before main.
      if (options.instanceColors) {
        shader.vertexShader = '#define USE_INSTANCING_COLOR\n' + shader.vertexShader;
        shader.fragmentShader = '#ifndef USE_COLOR\n#define USE_COLOR\n#endif\n' + shader.fragmentShader;
      }
      let aliases = PULL_DECLARATIONS;
      if (options.instanced) aliases += '\n#define USE_INSTANCING\n';
      aliases += options.vertexColorSize === 3 ? '\n#define color exactColor.rgb\n' : '\n#define color exactColor\n';
      shader.vertexShader = shader.vertexShader.replace(main, `${aliases}\nvoid main() {\n  exactLoadOriginalVertex();`);
    };
    const geometry = new InstancedBufferGeometry();
    const verticesPerReference = 3 * (options.trianglesPerReference ?? 1);
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(verticesPerReference * 3), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(verticesPerReference * 3), 3));
    for (const name of ['uv', 'uv1', 'uv2', 'uv3']) geometry.setAttribute(name, new BufferAttribute(new Float32Array(verticesPerReference * 2), 2));
    if (options.vertexColorSize) geometry.setAttribute('color', new BufferAttribute(new Float32Array(verticesPerReference * options.vertexColorSize), options.vertexColorSize));
    if (options.tangents) geometry.setAttribute('tangent', new BufferAttribute(new Float32Array(verticesPerReference * 4), 4));
    this.references = new InstancedBufferAttribute(new Uint32Array(options.capacity * 2), 2);
    this.references.gpuType = IntType;
    this.references.setUsage(DynamicDrawUsage);
    geometry.setAttribute('exactTriangleReference', this.references);
    geometry.setDrawRange(0, verticesPerReference); geometry.instanceCount = 0;
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'Experimental exact visible triangles';
    this.mesh.matrixAutoUpdate = false; this.mesh.matrixWorldAutoUpdate = false;
    // The native renderer also chooses gl.frontFace from object.matrixWorld determinant. The shader
    // pulls its actual matrix independently, so this marker reproduces the original batch winding.
    if (options.mirroredBatch) this.mesh.matrix.makeScale(-1, 1, 1);
    this.mesh.matrixWorld.copy(this.mesh.matrix);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = options.receiveShadow ?? true;
    this.mesh.renderOrder = options.renderOrder ?? 0;
    this.mesh.layers.mask = options.layersMask ?? 1;
    this.mesh.userData.exactTriangleRaster = { abi: VISIBLE_TRIANGLE_ABI, materialId: options.materialId, beautyOnly: true };
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => atlas.assertPrepared(camera);
    this.mesh.raycast = () => { throw new Error('Raycast canonical geometry; dummy triangle positions are not a picking surface'); };
    this.flags = (options.instanced ? INSTANCE_INSTANCED : 0) | (options.instanceColors ? INSTANCE_COLOR : 0) | (options.mirroredBatch ? INSTANCE_MIRRORED_BATCH : 0);
    atlas.attach();
  }

  /** Caller supplies canonical draw order. Duplicates/wrong material/ownership fail atomically. */
  setVisibleReferences(pairs: Uint32Array): void {
    if (this.disposed) throw new Error('Triangle adapter is disposed');
    if (pairs.length % 2 || pairs.length > this.references.array.length) throw new Error('Invalid/capacity-exceeding reference list');
    const words = this.atlas.integerTexture.image.data as Uint32Array;
    const seen = new Map<number, Set<number>>();
    for (let i = 0; i < pairs.length; i += 2) {
      const instance = pairs[i], triangle = pairs[i + 1];
      if (instance >= this.atlas.instanceCount || triangle >= this.atlas.triangleCount) throw new Error('Reference outside original arrays');
      const base = (this.atlas.instanceOffset + instance * 2) * 4, geometryId = words[base];
      if (words[base + 2] !== this.options.materialId || words[base + 3] !== this.flags) throw new Error('Reference crosses material/native shader/winding group');
      if (words[triangle * 4 + 3] !== geometryId) throw new Error('Triangle does not belong to original instance');
      const g = (this.atlas.geometryOffset + geometryId * 3) * 4;
      if ((triangle - words[g + 10]) % (this.options.trianglesPerReference ?? 1) !== 0) throw new Error('Reference block is not aligned to its geometry');
      if ((this.options.vertexColorSize ?? 0) && words[g + 9] !== this.options.vertexColorSize) throw new Error('Vertex-color signature mismatch');
      if (this.options.tangents && words[g + 8] === ABSENT) throw new Error('Missing original tangent');
      const triangles = seen.get(instance) ?? new Set<number>();
      if (triangles.has(triangle)) throw new Error('Duplicate original triangle reference');
      triangles.add(triangle); seen.set(instance, triangles);
    }
    (this.references.array as Uint32Array).set(pairs);
    this.references.clearUpdateRanges();
    if (pairs.length) this.references.addUpdateRange(0, pairs.length);
    if (pairs.length) this.references.needsUpdate = true;
    this.mesh.geometry.instanceCount = pairs.length / 2;
  }
  identityAt(drawInstance: number): { instanceId: number; triangleId: number } {
    integer(drawInstance, 'draw instance');
    if (this.disposed || drawInstance >= this.mesh.geometry.instanceCount) throw new Error('Unknown visible triangle');
    return { instanceId: this.references.array[drawInstance * 2], triangleId: this.references.array[drawInstance * 2 + 1] };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent(); this.mesh.geometry.instanceCount = 0;
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.releaseHook?.(); this.atlas.detach();
    this.references.array = new Uint32Array(0);
    this.mesh.material.onBeforeCompile = Material.prototype.onBeforeCompile;
    this.mesh.onBeforeRender = () => {};
  }
}

/** Type-only helper for CPU shader assembly fixtures; not an actual GLSL compiler. */
export function assembleVisibleTriangleShader(adapter: VisibleTriangleRasterAdapter, shader: Parameters<Material['onBeforeCompile']>[0]): void {
  adapter.mesh.material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
}
