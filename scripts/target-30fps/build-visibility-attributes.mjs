import { readFile, writeFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FourBiomeWorld } from '../../src/world/FourBiomeWorld.ts';
import { affineBounds } from './exact-bvh.mjs';

// An isolated companion exporter. Existing visibility buffers are read-only.
// Image bytes are copied from GLB bufferViews, never decoded or re-encoded.
const transformsOnly = process.argv.includes('--transforms-only');
const targets = process.argv.slice(2).filter(argument => argument !== '--transforms-only');
if (!targets.length) targets.push('public/acceleration/visibility-world');
const started = performance.now();
const datasets = await Promise.all(targets.map(async folder => ({ folder, manifest: JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')) })));
const sourceManifest = JSON.parse(await readFile('public/environments/world-manifest.json', 'utf8'));
const terrain = JSON.parse(await readFile('public/environments/terrain.json', 'utf8'));
const world = new FourBiomeWorld(sourceManifest, terrain), images = new Map();
const biomeIds = sourceManifest.biomes.filter(b => datasets.some(d => d.manifest.selectedBiomes.includes(b.id))).map(b => b.id);
const filters = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
const wraps = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
function parseGLB(data) {
  if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2) throw new Error('Expected glTF binary v2');
  let offset = 12, json, binary;
  while (offset < data.length) {
    const bytes = data.readUInt32LE(offset), type = data.readUInt32LE(offset + 4), content = data.subarray(offset + 8, offset + 8 + bytes);
    if (type === 0x4e4f534a) json = JSON.parse(content.toString('utf8'));
    else if (type === 0x004e4942) binary = content;
    offset += 8 + bytes;
  }
  if (!json || !binary) throw new Error('Incomplete GLB chunks');
  return { json, binary };
}
for (const id of biomeIds) {
  const biome = sourceManifest.biomes.find(b => b.id === id), file = path.join('public', biome.url.replace(/^\//, ''));
  let bytes = await readFile(file);
  const hash = sha256(bytes), { json, binary } = parseGLB(bytes), imageEntries = [];
  for (const d of datasets) {
    const expected = d.manifest.inputEvidence.find(input => input.id === id);
    if (expected && (expected.sha256 !== hash || expected.bytes !== bytes.length)) throw new Error(`Visibility source changed: ${id}`);
  }
  for (let index = 0; index < (json.images?.length ?? 0); index++) {
    const image = json.images[index];
    if (image.bufferView === undefined) throw new Error('External image URI needs an explicit exact-byte source resolver');
    const view = json.bufferViews[image.bufferView], data = Buffer.from(binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    const hash = sha256(data), mimeType = image.mimeType;
    if (mimeType !== 'image/png' || data.readUInt32BE(0) !== 0x89504e47) throw new Error('Unexpected image encoding; do not infer decoder metadata');
    if (!images.has(hash)) images.set(hash, { data, metadata: { id: hash, sha256: hash, file: `attribute-images/${hash}.png`, mimeType, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20), aliases: [] } });
    const entry = images.get(hash);
    entry.metadata.aliases.push({ biome: id, imageIndex: index, name: image.name ?? '', gltf: image }); imageEntries.push(entry);
  }
  const loader = new GLTFLoader();
  loader.register(parser => {
    const cache = new Map();
    return { name: 'ExactEmbeddedImageMetadata', loadTexture: async textureIndex => {
      const definition = parser.json.textures[textureIndex], imageDefinition = parser.json.images[definition.source];
      const key = `${imageDefinition.uri ?? imageDefinition.bufferView}:${definition.sampler}`;
      if (cache.has(key)) return cache.get(key);
      const image = imageEntries[definition.source], sampler = parser.json.samplers?.[definition.sampler] ?? {};
      const texture = new THREE.Texture({ width: image.metadata.width, height: image.metadata.height });
      texture.name = definition.name || imageDefinition.name || ''; texture.flipY = false;
      texture.magFilter = filters[sampler.magFilter] ?? THREE.LinearFilter;
      texture.minFilter = filters[sampler.minFilter] ?? THREE.LinearMipmapLinearFilter;
      texture.wrapS = wraps[sampler.wrapS] ?? THREE.RepeatWrapping; texture.wrapT = wraps[sampler.wrapT] ?? THREE.RepeatWrapping;
      texture.generateMipmaps = texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
      texture.userData.exactSource = { biome: id, textureIndex, image: image.metadata.id, gltfTexture: definition, gltfSampler: sampler };
      parser.associations.set(texture, { textures: textureIndex }); cache.set(key, texture); return texture;
    } };
  });
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const annotated = new Set();
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (annotated.has(material)) continue; annotated.add(material);
      const index = gltf.parser.associations.get(material)?.materials;
      material.userData.exactSource = { biome: id, materialIndex: index, gltf: index === undefined ? null : json.materials[index] };
    }
  });
  world.attachScene(id, gltf.scene); bytes = null; global.gc?.();
  console.log(JSON.stringify({ stage: 'loaded-exact-metadata', id, sourceImages: imageEntries.length, imagesDecoded: false }));
}
world.root.updateMatrixWorld(true);
const readExact = async (file, byteOffset, byteLength) => {
  const data = Buffer.allocUnsafe(byteLength); let offset = 0;
  while (offset < data.length) {
    const { bytesRead } = await file.read(data, offset, data.length - offset, byteOffset + offset);
    if (!bytesRead) throw new Error('Unexpected end of existing visibility buffer'); offset += bytesRead;
  }
  return data;
};
function materialMetadata(material, textureIds, textures) {
  const result = {};
  for (const [key, value] of Object.entries(material)) {
    if (['id', 'uuid', 'version', '_alphaTest'].includes(key) || typeof value === 'function') continue;
    if (value?.isTexture) {
      if (!textureIds.has(value)) {
        const id = textures.length; textureIds.set(value, id); value.updateMatrix();
        const source = value.userData.exactSource;
        if (!source || !images.has(source.image)) throw new Error(`Missing exact texture metadata for ${value.name}`);
        const texture = { id, name: value.name, image: source.image, source, offset: value.offset.toArray(), repeat: value.repeat.toArray(), center: value.center.toArray(), rotation: value.rotation, matrix: value.matrix.toArray() };
        for (const property of ['mapping', 'channel', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'format', 'internalFormat', 'type', 'colorSpace', 'flipY', 'generateMipmaps', 'premultiplyAlpha', 'unpackAlignment', 'compareFunction', 'matrixAutoUpdate']) texture[property] = value[property];
        textures.push(texture);
      }
      result[key] = { texture: textureIds.get(value) };
    } else if (value?.isColor || value?.isVector2 || value?.isVector3 || value?.isVector4) result[key] = value.toArray();
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    else if (key === 'defines' || key === 'userData' || Array.isArray(value)) result[key] = value;
  }
  result.alphaTest = material.alphaTest; result.id = null;
  return result;
}
async function writeNativeTransforms(folder, batches, placements) {
  const matrixFile = 'attribute-instance-matrices.bin', matrices = new Float32Array(placements * 16);
  const identity = new THREE.Matrix4().elements, metadata = [], colorFile = 'attribute-instance-colors.bin';
  let colorHandle = null, colorBytes = 0, instancedBatches = 0, coloredBatches = 0;
  try {
    for (let id = 0; id < batches.length; id++) {
      const batch = batches[id], object = batch.object, instanced = !!object.isInstancedMesh;
      if (instanced) instancedBatches++;
      for (let i = 0; i < batch.originalSlots.length; i++) {
        const original = batch.originalSlots[i], source = instanced ? object.instanceMatrix.array.subarray(original * 16, original * 16 + 16) : identity;
        matrices.set(source, (batch.start + i) * 16);
      }
      let instanceColor = null;
      if (instanced && object.instanceColor) {
        const attribute = object.instanceColor;
        if (attribute.isInterleavedBufferAttribute) throw new Error('Unexpected interleaved instance colors');
        const selected = new attribute.array.constructor(batch.originalSlots.length * attribute.itemSize);
        for (let i = 0; i < batch.originalSlots.length; i++) selected.set(attribute.array.subarray(batch.originalSlots[i] * attribute.itemSize, (batch.originalSlots[i] + 1) * attribute.itemSize), i * attribute.itemSize);
        colorHandle ??= await open(path.join(folder, colorFile), 'w');
        const bytes = raw(selected); await colorHandle.write(bytes);
        instanceColor = { file: colorFile, byteOffset: colorBytes, bytes: bytes.length, count: batch.originalSlots.length, itemSize: attribute.itemSize, arrayType: attribute.array.constructor.name, normalized: attribute.normalized, gpuType: attribute.gpuType };
        colorBytes += bytes.length; coloredBatches++;
      }
      metadata.push({ id, isInstancedMesh: instanced, modelMatrix: object.matrixWorld.toArray(), localMatrix: object.matrix.toArray(), instanceMatrix: { file: matrixFile, byteOffset: batch.start * 64, count: batch.originalSlots.length, itemSize: 16, arrayType: 'Float32Array', ordinaryMeshValue: instanced ? null : 'identity; native renderer does not enable instancing for this batch' }, instanceColor });
    }
  } finally { await colorHandle?.close(); }
  await writeFile(path.join(folder, matrixFile), raw(matrices));
  return { metadata, summary: { instanceMatrices: { file: matrixFile, bytes: matrices.byteLength, count: placements, arrayType: 'Float32Array', strideBytes: 64 }, instancedBatches, coloredBatches, instanceColorBytes: colorBytes, batchModelMatrices: 'Exact original Three.Matrix4 Number elements in attribute-source-batches.json. Compute modelView/normal matrices from these separately from instance matrices, following the native shader path.', matricesSeparatedWithoutBaking: true } };
}
try {
  for (const { folder, manifest } of datasets) {
    const began = performance.now(), geometryIds = new Map(), geometries = [], materialIds = new Map(), materialObjects = [], batches = [];
    const selection = manifest.selection, pattern = selection.include ? new RegExp(selection.include) : null;
    const matrix = new THREE.Matrix4(), local = new THREE.Matrix4();
    let placements = 0, weightedTriangles = 0;
    world.root.traverseVisible(object => {
      if (!object.isMesh || (pattern && !pattern.test(object.name))) return;
      let parent = object; while (parent && !parent.userData.biomeId) parent = parent.parent;
      if (!parent || !manifest.selectedBiomes.includes(parent.userData.biomeId)) return;
      const geometry = object.geometry; geometry.computeBoundingBox();
      const localBounds = [...geometry.boundingBox.min.toArray(), ...geometry.boundingBox.max.toArray()], matrices = [], originalSlots = [];
      for (let slot = 0; slot < (object.isInstancedMesh ? object.count : 1); slot++) {
        if (object.isInstancedMesh) { object.getMatrixAt(slot, local); matrix.multiplyMatrices(object.matrixWorld, local); } else matrix.copy(object.matrixWorld);
        const value = Float32Array.from(matrix.elements), bound = affineBounds(localBounds, value), b = selection.bounds;
        if (b && (bound[3] < b[0] || bound[0] > b[2] || bound[5] < b[1] || bound[2] > b[3])) continue;
        matrices.push(value); originalSlots.push(slot);
      }
      if (!matrices.length) return;
      if (Array.isArray(object.material)) throw new Error('Unexpected multi-material canonical batch');
      if (!geometryIds.has(geometry)) { geometryIds.set(geometry, geometries.length); geometries.push({ geometry, name: object.name }); }
      if (!materialIds.has(object.material)) { materialIds.set(object.material, materialObjects.length); materialObjects.push(object.material); }
      batches.push({ object, geometryId: geometryIds.get(geometry), materialId: materialIds.get(object.material), matrices, originalSlots, start: placements });
      placements += matrices.length; weightedTriangles += matrices.length * (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    });
    if (geometries.length !== manifest.uniqueGeometries || placements !== manifest.placements || weightedTriangles !== manifest.weightedTriangles || materialObjects.length !== manifest.materials.length) throw new Error('Canonical dataset census/order changed');
    if (transformsOnly) {
      const companion = JSON.parse(await readFile(path.join(folder, 'attribute-manifest.json'), 'utf8'));
      if (companion.visibilityManifestSha256 !== sha256(await readFile(path.join(folder, 'manifest.json')))) throw new Error('Companion points at another visibility dataset');
      const sourceBatches = JSON.parse(await readFile(path.join(folder, 'attribute-source-batches.json'), 'utf8'));
      if (sourceBatches.length !== batches.length) throw new Error('Native transform batch count changed');
      for (let i = 0; i < batches.length; i++) if (sourceBatches[i].name !== batches[i].object.name || sourceBatches[i].sourceStart !== batches[i].start || sourceBatches[i].count !== batches[i].matrices.length) throw new Error('Native transform source order changed');
      const factors = await writeNativeTransforms(folder, batches, placements);
      for (let i = 0; i < sourceBatches.length; i++) Object.assign(sourceBatches[i], factors.metadata[i]);
      companion.nativeTransformFactors = factors.summary; companion.nativeTransformsUpdatedAt = new Date().toISOString();
      await writeFile(path.join(folder, 'attribute-source-batches.json'), JSON.stringify(sourceBatches));
      await writeFile(path.join(folder, 'attribute-manifest.json'), JSON.stringify(companion, null, 2));
      console.log(JSON.stringify({ stage: 'native-transforms-complete', folder, ...factors.summary }));
      continue;
    }
    const readHandles = new Map(await Promise.all(['positions.bin', 'triangles.bin', 'triangle-source.bin', 'instances.bin', 'instances-forward.bin'].map(async name => [name, await open(path.join(folder, name), 'r')])));
    const writeHandles = new Map(), attributeSizes = new Map(), outputGeometry = [];
    const instanceGeometry = new Uint32Array(placements), sourceBatches = [];
    let verifiedIndexValues = 0, verifiedPositionBytes = 0, verifiedMatrixBytes = 0;
    try {
      for (let id = 0; id < geometries.length; id++) {
        const { geometry, name } = geometries[id], expected = manifest.geometries[id], p = geometry.attributes.position;
        if (name !== expected.name || p.count !== expected.vertices || (geometry.index?.count ?? p.count) / 3 !== expected.triangles) throw new Error(`Geometry identity/order mismatch: ${id}`);
        const existing = await readExact(readHandles.get('positions.bin'), expected.vertexOffset * 12, p.array.byteLength);
        if (!existing.equals(raw(p.array))) throw new Error(`Position bytes changed: geometry ${id}`); verifiedPositionBytes += existing.length;
        const triangleBytes = await readExact(readHandles.get('triangles.bin'), expected.triangleOffset * 12, expected.triangles * 12), orderBytes = await readExact(readHandles.get('triangle-source.bin'), expected.triangleOffset * 4, expected.triangles * 4);
        const ordered = new Uint32Array(triangleBytes.buffer, triangleBytes.byteOffset, expected.triangles * 3), sourceOrder = new Uint32Array(orderBytes.buffer, orderBytes.byteOffset, expected.triangles), indices = geometry.index?.array;
        for (let t = 0; t < expected.triangles; t++) for (let corner = 0; corner < 3; corner++) {
          const original = sourceOrder[t] * 3 + corner, actual = (indices ? indices[original] : original) + expected.vertexOffset;
          if (ordered[t * 3 + corner] !== actual) throw new Error(`Source triangle/order mismatch: geometry ${id}/${t}`);
          verifiedIndexValues++;
        }
        const attributes = {};
        for (const [name, attribute] of Object.entries(geometry.attributes)) {
          if (name === 'position') continue;
          if (attribute.isInterleavedBufferAttribute) throw new Error('Unexpected interleaved source attribute');
          const file = `attribute-${name}.bin`;
          if (!writeHandles.has(file)) { writeHandles.set(file, await open(path.join(folder, file), 'w')); attributeSizes.set(file, 0); }
          const offset = attributeSizes.get(file), data = raw(attribute.array);
          if (offset % attribute.array.BYTES_PER_ELEMENT) throw new Error('Unaligned sparse attribute offset');
          await writeHandles.get(file).write(data);
          attributes[name] = { file, byteOffset: offset, bytes: data.length, count: attribute.count, itemSize: attribute.itemSize, arrayType: attribute.array.constructor.name, normalized: attribute.normalized, gpuType: attribute.gpuType, sha256: sha256(data) };
          attributeSizes.set(file, offset + data.length);
        }
        outputGeometry.push({ id, name, vertexOffset: expected.vertexOffset, vertices: expected.vertices, triangleOffset: expected.triangleOffset, triangles: expected.triangles, blasRoot: expected.blasRoot, groups: geometry.groups, drawRange: { start: geometry.drawRange.start, count: Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : null }, attributes });
        if (id % 250 === 0) console.log(JSON.stringify({ stage: 'verified-attributes', folder, geometry: id, total: geometries.length }));
      }
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index], expectedMatrices = await readExact(readHandles.get('instances-forward.bin'), batch.start * 64, batch.matrices.length * 64), instanceBytes = await readExact(readHandles.get('instances.bin'), batch.start * 64, batch.matrices.length * 64), fields = new Uint32Array(instanceBytes.buffer, instanceBytes.byteOffset, instanceBytes.byteLength / 4);
        for (let i = 0; i < batch.matrices.length; i++) {
          if (!expectedMatrices.subarray(i * 64, i * 64 + 64).equals(raw(batch.matrices[i]))) throw new Error(`Source placement matrix changed: ${batch.start + i}`);
          if (fields[i * 16 + 12] !== manifest.geometries[batch.geometryId].blasRoot || fields[i * 16 + 13] !== batch.materialId || fields[i * 16 + 14] !== batch.start + i) throw new Error(`Instance/material order changed: ${batch.start + i}`);
          instanceGeometry[batch.start + i] = batch.geometryId; verifiedMatrixBytes += 64;
        }
        sourceBatches.push({ id: index, name: batch.object.name, sourceStart: batch.start, count: batch.matrices.length, geometryId: batch.geometryId, materialId: batch.materialId, originalInstanceSlots: batch.originalSlots, renderOrder: batch.object.renderOrder, layers: batch.object.layers.mask, castShadow: batch.object.castShadow, receiveShadow: batch.object.receiveShadow, sourceGeometryRanges: batch.object.userData.sourceGeometryRanges ?? null });
      }
    } finally { await Promise.all([...readHandles.values(), ...writeHandles.values()].map(handle => handle.close())); }
    await writeFile(path.join(folder, 'instance-geometry.bin'), raw(instanceGeometry));
    const nativeTransforms = await writeNativeTransforms(folder, batches, placements);
    for (let i = 0; i < sourceBatches.length; i++) Object.assign(sourceBatches[i], nativeTransforms.metadata[i]);
    await writeFile(path.join(folder, 'attribute-source-batches.json'), JSON.stringify(sourceBatches));
    const textureIds = new Map(), textures = [], materials = materialObjects.map((material, id) => ({ ...materialMetadata(material, textureIds, textures), id }));
    for (let id = 0; id < materials.length; id++) if (materials[id].name !== manifest.materials[id].name || materials[id].side !== manifest.materials[id].side) throw new Error(`Material identity changed: ${id}`);
    const imageIds = new Set(textures.map(texture => texture.image));
    await mkdir(path.join(folder, 'attribute-images'), { recursive: true });
    for (const id of imageIds) { const image = images.get(id); await writeFile(path.join(folder, image.metadata.file), image.data); }
    const companion = {
      version: 1, complete: true, timestamp: new Date().toISOString(), visibilityManifestSha256: sha256(await readFile(path.join(folder, 'manifest.json'))), sourceInputs: manifest.inputEvidence,
      uniqueGeometries: geometries.length, placements, weightedTriangles, attributeFiles: Object.fromEntries(attributeSizes), instanceGeometry: { file: 'instance-geometry.bin', arrayType: 'Uint32Array', count: placements },
      nativeTransformFactors: nativeTransforms.summary,
      sourceBatches: 'attribute-source-batches.json', sourceComponents: 'sources.ndjson', triangleSourceMapping: 'triangle-source.bin', forwardMatrices: 'instances-forward.bin',
      images: [...imageIds].map(id => images.get(id).metadata), textures, materials, geometries: outputGeometry,
      verification: { positionBytesExact: true, sourceIndexOrderExact: true, matricesExact: true, materialAndInstanceOrderExact: true, verifiedPositionBytes, verifiedIndexValues, verifiedMatrixBytes, imagesCopiedWithoutReencoding: true, imagesDecoded: false },
      conventions: { color: 'Linear working-space Three.Color components, unchanged from GLTFLoader', textureColorSpace: 'Exact resolved Texture.colorSpace string', attributes: 'Raw canonical typed-array bytes, including normalized/component type metadata. Offsets are bytes into sparse files; absent attributes are absent, not zero-filled.', materialTextureReferences: 'Any material property {texture:id} refers to textures[id]', matrix: 'Column-major original forward matrices; instance IDs and material IDs agree with visibility instances.bin', triangleIdentity: 'Visibility triangle ID maps to the three exact global position indices; triangle-source.bin maps to original geometry-local triangle ID', sourceDrawPolicy: 'Per canonical batch renderOrder/layers/shadow flags, plus each material depth/blending/side/polygon-offset state', normalMaps: 'Original tangent-space maps and normalScale; no tangents synthesized or attribute simplification' },
      limitations: ['This data companion does not implement shading. Runtime CSM/fog shader integrations and presentation settings must still be reproduced by the experimental renderer.', 'Image bytes and sampler/transform metadata are exact; no decoded-pixel comparison is performed by this CPU-only export.'],
      seconds: (performance.now() - began) / 1000,
    };
    for (const [file, bytes] of attributeSizes) if ((await stat(path.join(folder, file))).size !== bytes) throw new Error(`Incomplete companion attribute write ${file}`);
    await writeFile(path.join(folder, 'attribute-manifest.json'), JSON.stringify(companion, null, 2));
    console.log(JSON.stringify({ stage: 'complete-companion', folder, geometries: geometries.length, placements, materials: materials.length, textures: textures.length, uniqueImages: imageIds.size, attributeFiles: companion.attributeFiles, verification: companion.verification, seconds: companion.seconds }));
  }
} finally { world.dispose(); }
console.log(JSON.stringify({ stage: 'all-complete', seconds: (performance.now() - started) / 1000 }));
