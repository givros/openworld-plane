import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Matrix4 } from 'three';
import { OriginalTriangleAtlas } from '../../src/experiments/VisibleTriangleRasterAdapter.ts';

const source = 'public/acceleration/visibility-world';
const destination = 'artifacts/four-horizons/target-30fps/native-render-capture/atlas';
await mkdir(destination, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(source, 'attribute-manifest.json'), 'utf8'));
const batches = JSON.parse(await readFile(path.join(source, manifest.sourceBatches), 'utf8'));
const arrays = new Map();
for (const name of ['positions.bin', 'triangles.bin', ...Object.keys(manifest.attributeFiles), manifest.nativeTransformFactors.instanceMatrices.file]) {
  arrays.set(name, await readFile(path.join(source, name)));
}
if (manifest.nativeTransformFactors.instanceColorBytes) arrays.set('attribute-instance-colors.bin', await readFile(path.join(source, 'attribute-instance-colors.bin')));
const typed = (name, Type, byteOffset = 0, elements) => { const b = arrays.get(name); return new Type(b.buffer, b.byteOffset + byteOffset, elements ?? (b.byteLength - byteOffset) / Type.BYTES_PER_ELEMENT); };
const geometries = manifest.geometries.map(g => {
  const result = { vertexOffset: g.vertexOffset, vertexCount: g.vertices, triangleOffset: g.triangleOffset, triangleCount: g.triangles };
  for (const [name, a] of Object.entries(g.attributes)) {
    const Type = { Float32Array, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array }[a.arrayType];
    result[name] = { array: typed(a.file, Type, a.byteOffset, a.bytes / Type.BYTES_PER_ELEMENT), itemSize: a.itemSize, normalized: a.normalized };
  }
  return result;
});
const instances = new Array(manifest.placements), nativeBatches = [], batchKeys = new Map();
for (const batch of batches) {
  const key = JSON.stringify([batch.isInstancedMesh, batch.modelMatrix]); let batchId = batchKeys.get(key);
  if (batchId === undefined) { batchId = nativeBatches.length; batchKeys.set(key, batchId); nativeBatches.push({ matrixWorld: new Matrix4().fromArray(batch.modelMatrix), instanced: batch.isInstancedMesh }); }
  for (let slot = 0; slot < batch.count; slot++) {
    const item = instances[batch.sourceStart + slot] = { geometry: batch.geometryId, batch: batchId, material: batch.materialId, matrix: typed(batch.instanceMatrix.file, Float32Array, batch.instanceMatrix.byteOffset + slot * 64, 16) };
    if (batch.instanceColor) item.color = typed(batch.instanceColor.file, Float32Array, batch.instanceColor.byteOffset + slot * 12, 3);
  }
}
console.log('Packing unchanged source atlas');
const atlas = new OriginalTriangleAtlas({ positions: typed('positions.bin', Float32Array), triangles: typed('triangles.bin', Uint32Array), geometries, batches: nativeBatches, instances, maxTextureSize: 16384 });
const textures = [...atlas.floatTextures.map((texture, index) => [`float${index}`, texture]), ['integer', atlas.integerTexture]];
const report = { chunkBytes: 64 * 1024 * 1024, files: [] };
for (const [id, texture] of textures) {
  const data = texture.image.data, bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength), sha256 = createHash('sha256').update(bytes).digest('hex');
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += report.chunkBytes) chunks.push(createHash('sha256').update(bytes.subarray(offset, Math.min(offset + report.chunkBytes, bytes.byteLength))).digest('hex'));
  await writeFile(path.join(destination, `${id}.bin`), bytes);
  report.files.push({ id, file: `atlas/${id}.bin`, byteLength: bytes.byteLength, width: texture.image.width, height: texture.image.height, sha256, chunks });
  console.log(`${id}: ${bytes.byteLength} exact bytes`);
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(report, null, 2));
atlas.dispose();
