import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FourBiomeWorld } from '../../src/world/FourBiomeWorld.ts';
import { affineBounds, buildBoundsBVH, triangleBounds } from './exact-bvh.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const biomeIds = option('--biomes', 'verdant-airfield').split(',');
const include = option('--include', null), pattern = include ? new RegExp(include) : null;
const selectionBounds = option('--bounds', null)?.split(',').map(Number);
if (selectionBounds && (selectionBounds.length !== 4 || selectionBounds.some(v => !Number.isFinite(v)))) throw new Error('Use --bounds minX,minZ,maxX,maxZ');
const output = path.resolve(root, option('--out', 'artifacts/four-horizons/target-30fps/exact-bvh-meadow'));
const started = performance.now();
const manifest = JSON.parse(await readFile(path.join(root, 'public/environments/world-manifest.json'), 'utf8'));
const terrain = JSON.parse(await readFile(path.join(root, 'public/environments/terrain.json'), 'utf8'));
const world = new FourBiomeWorld(manifest, terrain);
const loader = new GLTFLoader();
loader.register(() => ({ name: 'ExactVisibilityCPUTextureFixture', loadTexture: async () => new THREE.Texture() }));
const inputs = [];
for (const id of biomeIds) {
  const biome = manifest.biomes.find(b => b.id === id);
  if (!biome) throw new Error(`Unknown biome: ${id}`);
  const source = path.join(root, 'public', biome.url.replace(/^\//, ''));
  const began = performance.now();
  let data = await readFile(source);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const bytes = data.byteLength;
  const parsed = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  world.attachScene(id, parsed.scene); data = null;
  inputs.push({ id, file: path.relative(root, source).replaceAll('\\', '/'), bytes, sha256 });
  global.gc?.();
  console.log(JSON.stringify({ stage: 'loaded', id, seconds: (performance.now() - began) / 1000 }));
}
world.root.updateMatrixWorld(true);
const geometryIds = new Map(), materialIds = new Map(), selected = [], geometryRecords = [], materials = [];
const localMatrix = new THREE.Matrix4(), matrix = new THREE.Matrix4();
let placementCount = 0, weightedTriangles = 0;
world.root.traverseVisible(object => {
  if (!object.isMesh || (pattern && !pattern.test(object.name))) return;
  if (Array.isArray(object.material)) throw new Error('The visibility ABI currently requires a single material per canonical batch');
  if (object.material.transparent || object.material.alphaTest > 0 || object.material.transmission > 0) throw new Error('Unsupported cutout or transparent material');
  const geometry = object.geometry, position = geometry.attributes.position;
  if (position.itemSize !== 3 || position.normalized || position.isInterleavedBufferAttribute || !(position.array instanceof Float32Array)) throw new Error('Expected exact packed Float32 xyz positions');
  if (geometry.drawRange.start !== 0 || (Number.isFinite(geometry.drawRange.count) && geometry.drawRange.count !== (geometry.index?.count ?? position.count))) throw new Error('Partial geometry draw range requires an explicit source mapping');
  geometry.computeBoundingBox();
  const box = geometry.boundingBox, localBounds = [...box.min.toArray(), ...box.max.toArray()];
  const selectedSlots = [], count = object.isInstancedMesh ? object.count : 1;
  for (let i = 0; i < count; i++) {
    if (object.isInstancedMesh) { object.getMatrixAt(i, localMatrix); matrix.multiplyMatrices(object.matrixWorld, localMatrix); }
    else matrix.copy(object.matrixWorld);
    const exactMatrix = Float32Array.from(matrix.elements), bound = affineBounds(localBounds, exactMatrix);
    if (selectionBounds && (bound[3] < selectionBounds[0] || bound[0] > selectionBounds[2] || bound[5] < selectionBounds[1] || bound[2] > selectionBounds[3])) continue;
    selectedSlots.push({ slot: i, matrix: exactMatrix, bounds: bound });
  }
  if (!selectedSlots.length) return;
  if (!geometryIds.has(geometry)) {
    geometryIds.set(geometry, geometryRecords.length);
    geometryRecords.push({ geometry, name: object.name, localBounds, placements: 0 });
  }
  if (!materialIds.has(object.material)) {
    materialIds.set(object.material, materials.length);
    materials.push({ name: object.material.name, type: object.material.type, side: object.material.side, color: object.material.color?.toArray(), roughness: object.material.roughness, metalness: object.material.metalness, polygonOffset: object.material.polygonOffset, polygonOffsetFactor: object.material.polygonOffsetFactor, polygonOffsetUnits: object.material.polygonOffsetUnits, normalMap: !!object.material.normalMap, roughnessMap: !!object.material.roughnessMap, metalnessMap: !!object.material.metalnessMap, vertexColors: object.material.vertexColors });
  }
  const geometryId = geometryIds.get(geometry), materialId = materialIds.get(object.material);
  geometryRecords[geometryId].placements += selectedSlots.length;
  selected.push({ object, geometryId, materialId, slots: selectedSlots, sourceStart: placementCount });
  placementCount += selectedSlots.length;
  weightedTriangles += selectedSlots.length * (geometry.index?.count ?? position.count) / 3;
});
if (!placementCount) throw new Error('Selection contains no complete source placements');
console.log(JSON.stringify({ stage: 'selected', geometries: geometryRecords.length, placements: placementCount, weightedTriangles }));
await mkdir(output, { recursive: true });
const fileNames = ['nodes.bin', 'positions.bin', 'triangles.bin', 'triangle-source.bin', 'instances.bin', 'instances-forward.bin', 'instance-order.bin', 'sources.ndjson'];
const files = new Map(await Promise.all(fileNames.map(async name => [name, await open(path.join(output, name), 'w')])));
const append = async (name, value) => {
  const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);
  let offset = 0;
  while (offset < buffer.byteLength) { const result = await files.get(name).write(buffer, offset, buffer.byteLength - offset); offset += result.bytesWritten; }
};
let vertexOffset = 0, triangleOffset = 0, nodeOffset = 0, maximumBLASDepth = 0;
const geometryMetadata = [];
try {
  for (let id = 0; id < geometryRecords.length; id++) {
    const began = performance.now(), { geometry, name, localBounds, placements } = geometryRecords[id];
    const positions = geometry.attributes.position.array;
    const sourceIndex = geometry.index?.array ?? Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);
    const bounds = triangleBounds(positions, sourceIndex);
    const bvh = buildBoundsBVH(bounds, { leafSize: 8, indexBase: nodeOffset, leafBase: triangleOffset });
    const triangles = new Uint32Array(sourceIndex.length), sourceTriangles = new Uint32Array(bvh.count);
    for (let t = 0; t < bvh.count; t++) {
      const original = bvh.order[t]; sourceTriangles[t] = original;
      for (let corner = 0; corner < 3; corner++) triangles[t * 3 + corner] = sourceIndex[original * 3 + corner] + vertexOffset;
    }
    await append('positions.bin', positions); await append('triangles.bin', triangles);
    await append('triangle-source.bin', sourceTriangles); await append('nodes.bin', bvh.nodes);
    geometryMetadata.push({ id, name, blasRoot: bvh.root, nodeOffset, nodes: bvh.nodeCount, maxDepth: bvh.maxDepth, vertexOffset, vertices: positions.length / 3, triangleOffset, triangles: bvh.count, placements, localBounds, sourceGeometryRanges: geometry.userData?.sourceGeometryRanges ?? null });
    vertexOffset += positions.length / 3; triangleOffset += bvh.count; nodeOffset += bvh.nodeCount;
    maximumBLASDepth = Math.max(maximumBLASDepth, bvh.maxDepth);
    if (id % 25 === 0 || id === geometryRecords.length - 1) console.log(JSON.stringify({ stage: 'BLAS', geometry: id + 1, total: geometryRecords.length, triangles: triangleOffset, nodes: nodeOffset, lastSeconds: (performance.now() - began) / 1000 }));
  }
  const instanceBounds = new Float64Array(placementCount * 6), packed = new ArrayBuffer(placementCount * 64);
  const packedFloat = new Float32Array(packed), packedUint = new Uint32Array(packed), forward = new Float32Array(placementCount * 16);
  const inverse = new THREE.Matrix4();
  let sourceId = 0;
  for (let batchId = 0; batchId < selected.length; batchId++) {
    const { object, slots, geometryId, materialId, sourceStart } = selected[batchId];
    await append('sources.ndjson', JSON.stringify({ batchId, name: object.name, sourceStart, count: slots.length, geometryId, materialId, originalInstanceSlots: slots.map(s => s.slot), userData: object.userData }) + '\n');
    for (const instance of slots) {
      matrix.fromArray(instance.matrix);
      if (Math.abs(matrix.determinant()) < 1e-20) throw new Error(`Singular source matrix ${object.name}/${instance.slot}`);
      inverse.copy(matrix).invert();
      const b = sourceId * 16, e = inverse.elements;
      for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++) packedFloat[b + row * 4 + column] = e[column * 4 + row];
      packedUint[b + 12] = geometryMetadata[geometryId].blasRoot;
      packedUint[b + 13] = materialId; packedUint[b + 14] = sourceId;
      packedUint[b + 15] = object.material.side | (matrix.determinant() < 0 ? 4 : 0);
      forward.set(instance.matrix, b); instanceBounds.set(instance.bounds, sourceId * 6); sourceId++;
    }
  }
  const tlas = buildBoundsBVH(instanceBounds, { leafSize: 4, indexBase: nodeOffset });
  await append('nodes.bin', tlas.nodes); await append('instances.bin', packed);
  await append('instances-forward.bin', forward); await append('instance-order.bin', tlas.order);
  nodeOffset += tlas.nodeCount;
  for (const handle of files.values()) await handle.close();
  const bufferSizes = Object.fromEntries(await Promise.all(fileNames.map(async name => [name, (await stat(path.join(output, name))).size])));
  for (const name of ['nodes.bin', 'positions.bin', 'triangles.bin', 'instances.bin', 'instance-order.bin']) if (bufferSizes[name] > 2147483644) throw new Error(`${name} exceeds the measured device storage binding limit`);
  const report = {
    version: 1, complete: true, timestamp: new Date().toISOString(), purpose: 'Isolated full-triangle visibility benchmark; no production rendering or shading replacement',
    endianness: 'little', selectedBiomes: biomeIds, selection: { include, bounds: selectionBounds ?? null, rule: 'Keep each selected placement and its complete original triangle geometry; bounds select intersecting whole instances' },
    inputEvidence: inputs, rootTLAS: tlas.root, nodeCount: nodeOffset, tlasNodes: tlas.nodeCount, tlasMaxDepth: tlas.maxDepth, maximumBLASDepth,
    uniqueGeometries: geometryMetadata.length, uniqueVertices: vertexOffset, uniqueTriangles: triangleOffset, placements: placementCount, weightedTriangles,
    buffers: bufferSizes, geometries: geometryMetadata, materials,
    abi: { nodeBytes: 32, node: 'min.xyz f32, left u32, max.xyz f32, rightOrCount u32; bit31 marks leaf; low31=count; left is triangle or instance-order offset', positions: 'Exact source f32 xyz, 12-byte stride', triangles: 'Three global u32 vertex indices per triangle; BLAS leaf order', triangleSource: 'Original geometry-local triangle ID for every triangle in triangles.bin', instanceBytes: 64, instance: 'Inverse affine row0/row1/row2 vec4<f32>, blasRoot/materialId/sourceId/flags u32; flags low2=Three side, bit2=negative determinant', instanceOrder: 'u32 sourceIds in TLAS leaf order', forward: 'Original canonical placement matrix,16 f32 column-major', bounds: 'Unquantized f32 with conservative outward ULP expansion', provenance: 'sources.ndjson maps sourceId ranges to canonical batch metadata and original instance slots' },
    invariants: { triangleReduction: false, positionQuantization: false, matrixBaking: false, materialReduction: false, sourcePositionsExact: true, textureImagesLoaded: false, visibilityOnly: true },
    limitations: ['A Float32 inverse affine matrix has finite rounding; CPU/GPU hit-distance parity must be measured against forward-matrix rasterization.', 'Visibility test does not yet reproduce polygonOffset, raster coverage/AA, normal maps, PBR, fog, or cascaded shadows.', 'Dummy texture objects are used only for CPU geometry transfer; no material/texture appearance equivalence is claimed by this dataset.'],
    buildSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: 'complete', output, uniqueTriangles: triangleOffset, placements: placementCount, nodes: nodeOffset, maxDepth: { BLAS: maximumBLASDepth, TLAS: tlas.maxDepth }, bufferSizes, seconds: report.buildSeconds }));
} finally {
  await Promise.all([...files.values()].map(handle => handle.close().catch(() => {})));
  world.dispose();
}
