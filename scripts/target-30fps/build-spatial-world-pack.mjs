// Lossless offline transport for live residency. No Blender, GPU or GLTF parsing.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const source = path.resolve('public/acceleration/visibility-world');
const output = path.resolve('public/environments/stream');
const started = performance.now();
const readJSON = name => JSON.parse(fs.readFileSync(path.join(source, name), 'utf8'));
const original = readJSON('manifest.json'), attributes = readJSON('attribute-manifest.json'), batches = readJSON('attribute-source-batches.json');
if (!original.complete || !attributes.complete || original.placements !== attributes.placements) throw new Error('Exact source companions are incomplete.');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceManifestSha256 = sha(fs.readFileSync(path.join(source, 'manifest.json')));
if (sourceManifestSha256 !== attributes.visibilityManifestSha256) throw new Error('Attribute and visibility source identity differs.');
for (const directory of ['geometries', 'chunks', 'images']) fs.mkdirSync(path.join(output, directory), { recursive: true });
const descriptors = new Map();
const readRange = (file, offset, bytes) => {
  if (!descriptors.has(file)) descriptors.set(file, fs.openSync(path.join(source, file), 'r'));
  const result = Buffer.allocUnsafe(bytes); let done = 0;
  while (done < bytes) { const count = fs.readSync(descriptors.get(file), result, done, bytes - done, offset + done); if (!count) throw new Error(`Incomplete exact resource ${file}`); done += count; }
  return result;
};
const atomic = (file, bytes) => { const target = path.join(output, file); fs.writeFileSync(`${target}.pending`, bytes); fs.renameSync(`${target}.pending`, target); };
const metadataOnly = process.argv.includes('--metadata-only');
const geometries = metadataOnly ? JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')).geometries : [];
const enclosingSphere = bounds => { const center = [0, 1, 2].map(axis => (bounds[axis] + bounds[axis + 3]) * .5); return { center, radius: Math.hypot(...center.map((value, axis) => bounds[axis + 3] - value)) }; };
try {
  if (!metadataOnly) for (const geometry of attributes.geometries) {
    const originalGeometry = original.geometries[geometry.id], chunks = [], layout = {}; let byteOffset = 0;
    const append = (name, bytes, format) => { layout[name] = { ...format, byteOffset, bytes: bytes.length, sha256: sha(bytes) }; chunks.push(bytes); byteOffset += bytes.length; };
    append('position', readRange('positions.bin', geometry.vertexOffset * 12, geometry.vertices * 12), { itemSize: 3, arrayType: 'Float32Array', normalized: false, gpuType: 1015, count: geometry.vertices });
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const data = readRange(attribute.file, attribute.byteOffset, attribute.bytes);
      if (sha(data) !== attribute.sha256) throw new Error(`Source attribute hash mismatch ${geometry.id}/${name}`);
      append(name, data, { itemSize: attribute.itemSize, arrayType: attribute.arrayType, normalized: attribute.normalized, gpuType: attribute.gpuType, count: attribute.count });
    }
    const sorted = readRange('triangles.bin', geometry.triangleOffset * 12, geometry.triangles * 12);
    const order = readRange('triangle-source.bin', geometry.triangleOffset * 4, geometry.triangles * 4);
    const indices = Buffer.allocUnsafe(geometry.triangles * 12), seen = new Uint8Array(geometry.triangles);
    for (let triangle = 0; triangle < geometry.triangles; triangle++) {
      const destination = order.readUInt32LE(triangle * 4);
      if (destination >= geometry.triangles || seen[destination]) throw new Error(`Non-bijective triangle order ${geometry.id}`); seen[destination] = 1;
      for (let corner = 0; corner < 3; corner++) {
        const vertex = sorted.readUInt32LE(triangle * 12 + corner * 4) - geometry.vertexOffset;
        if (vertex < 0 || vertex >= geometry.vertices) throw new Error(`Invalid source index ${geometry.id}`);
        indices.writeUInt32LE(vertex, destination * 12 + corner * 4);
      }
    }
    const index = { byteOffset, bytes: indices.length, count: geometry.triangles * 3, arrayType: 'Uint32Array', sha256: sha(indices) }; chunks.push(indices); byteOffset += indices.length;
    const bytes = Buffer.concat(chunks, byteOffset), file = `geometries/${geometry.id}.bin`; atomic(file, bytes);
    geometries.push({ id: geometry.id, name: geometry.name, url: `/environments/stream/${file}`, bytes: byteOffset, sha256: sha(bytes), attributes: layout, index, bounds: originalGeometry.localBounds, triangles: geometry.triangles, groups: geometry.groups, drawRange: geometry.drawRange });
    if (geometry.id % 400 === 0) console.log('GEOMETRY', geometry.id, '/', attributes.geometries.length);
  }
  for (const geometry of geometries) {
    const sourceGeometry = attributes.geometries[geometry.id], positionBytes = readRange('positions.bin', sourceGeometry.vertexOffset * 12, sourceGeometry.vertices * 12);
    const positions = new Float32Array(positionBytes.buffer, positionBytes.byteOffset, sourceGeometry.vertices * 3), center = enclosingSphere(geometry.bounds).center;
    let radiusSquared = 0; for (let i = 0; i < positions.length; i += 3) { const x = positions[i] - center[0], y = positions[i + 1] - center[1], z = positions[i + 2] - center[2]; radiusSquared = Math.max(radiusSquared, x * x + y * y + z * z); }
    geometry.boundingSphere = { center, radius: Math.sqrt(radiusSquared) };
  }
  const chunkMap = new Map(), geometryBounds = geometries.map(item => item.bounds);
  const matrices = readRange('attribute-instance-matrices.bin', 0, attributes.placements * 64), matrixView = new Float32Array(matrices.buffer, matrices.byteOffset, matrices.length / 4);
  const forward = readRange('instances-forward.bin', 0, attributes.placements * 64), forwardView = new Float32Array(forward.buffer, forward.byteOffset, forward.length / 4);
  let ordinal = 0, sourceObjects = 0, weightedTriangles = 0, placements = 0;
  const rows = readline.createInterface({ input: fs.createReadStream(path.join(source, 'sources.ndjson'), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rows) {
    if (!line) continue; const provenance = JSON.parse(line), batch = batches[ordinal++];
    if (batch.id !== provenance.batchId || batch.sourceStart !== provenance.sourceStart || batch.count !== provenance.count || batch.geometryId !== provenance.geometryId) throw new Error('Canonical batch/provenance ordering mismatch.');
    const local = geometryBounds[batch.geometryId], bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], localBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let instance = 0; instance < batch.count; instance++) {
      const offset = (batch.sourceStart + instance) * 16;
      // Exact transformed-AABB enclosure, including nonuniform scales and shear.
      const cx = (local[0] + local[3]) * .5, cy = (local[1] + local[4]) * .5, cz = (local[2] + local[5]) * .5;
      const hx = (local[3] - local[0]) * .5, hy = (local[4] - local[1]) * .5, hz = (local[5] - local[2]) * .5;
      for (let axis = 0; axis < 3; axis++) {
        const center = forwardView[offset + axis] * cx + forwardView[offset + 4 + axis] * cy + forwardView[offset + 8 + axis] * cz + forwardView[offset + 12 + axis];
        const half = Math.abs(forwardView[offset + axis]) * hx + Math.abs(forwardView[offset + 4 + axis]) * hy + Math.abs(forwardView[offset + 8 + axis]) * hz;
        bounds[axis] = Math.min(bounds[axis], center - half); bounds[axis + 3] = Math.max(bounds[axis + 3], center + half);
        const nativeOffset = batch.instanceMatrix.byteOffset / 4 + instance * 16;
        const localCenter = matrixView[nativeOffset + axis] * cx + matrixView[nativeOffset + 4 + axis] * cy + matrixView[nativeOffset + 8 + axis] * cz + matrixView[nativeOffset + 12 + axis];
        const localHalf = Math.abs(matrixView[nativeOffset + axis]) * hx + Math.abs(matrixView[nativeOffset + 4 + axis]) * hy + Math.abs(matrixView[nativeOffset + 8 + axis]) * hz;
        localBounds[axis] = Math.min(localBounds[axis], localCenter - localHalf); localBounds[axis + 3] = Math.max(localBounds[axis + 3], localCenter + localHalf);
      }
    }
    const global = /continuous-terrain|ocean|sea-surface/i.test(batch.name) || ((bounds[3] - bounds[0] > 1400 || bounds[5] - bounds[2] > 1400) && geometries[batch.geometryId].bytes < 4 * 1024 * 1024);
    const biomeId = provenance.userData.biomeId, cell = provenance.userData.spatialCell ?? `${Math.floor((bounds[0] + bounds[3]) / 320)},${Math.floor((bounds[2] + bounds[5]) / 320)}`;
    const key = `${biomeId}/${global ? 'global' : cell}`;
    let chunk = chunkMap.get(key);
    if (!chunk) { chunk = { id: key, biomeId, global, bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], batches: [], buffers: [], matrixBytes: 0, sourceObjects: 0, triangles: 0, placements: 0 }; chunkMap.set(key, chunk); }
    for (let axis = 0; axis < 3; axis++) { chunk.bounds[axis] = Math.min(chunk.bounds[axis], bounds[axis]); chunk.bounds[axis + 3] = Math.max(chunk.bounds[axis + 3], bounds[axis + 3]); }
    const matrixBytes = matrices.subarray(batch.instanceMatrix.byteOffset, batch.instanceMatrix.byteOffset + batch.count * 64);
    if (matrixBytes.byteLength !== batch.count * 64) throw new Error('Incomplete native instance factors.');
    const objects = provenance.userData.sourceObjects.length, triangles = geometries[batch.geometryId].triangles * batch.count;
    chunk.batches.push({ id: batch.id, name: batch.name, geometryId: batch.geometryId, materialId: batch.materialId, count: batch.count, isInstancedMesh: batch.isInstancedMesh, modelMatrix: batch.modelMatrix, renderOrder: batch.renderOrder, layers: batch.layers, castShadow: batch.castShadow, receiveShadow: batch.receiveShadow, matrixOffset: chunk.matrixBytes, bounds, localBounds, boundingSphere: enclosingSphere(localBounds), userData: provenance.userData, sourceObjects: objects, triangles });
    chunk.buffers.push(matrixBytes); chunk.matrixBytes += matrixBytes.length; chunk.sourceObjects += objects; chunk.triangles += triangles; chunk.placements += batch.count;
    sourceObjects += objects; weightedTriangles += triangles; placements += batch.count;
  }
  if (ordinal !== batches.length || placements !== original.placements || weightedTriangles !== original.weightedTriangles) throw new Error('Canonical world totals changed during spatial partition.');
  const chunks = [];
  for (const chunk of chunkMap.values()) {
    const stem = chunk.id.replace(/[\/,]/g, '_'), metadataFile = `chunks/${stem}.json`, matrixFile = `chunks/${stem}.bin`;
    const binary = Buffer.concat(chunk.buffers, chunk.matrixBytes); atomic(matrixFile, binary);
    const record = { version: 1, id: chunk.id, biomeId: chunk.biomeId, global: chunk.global, bounds: chunk.bounds, matrices: { url: `/environments/stream/${matrixFile}`, bytes: binary.length, sha256: sha(binary) }, batches: chunk.batches };
    const metadata = Buffer.from(JSON.stringify(record)); atomic(metadataFile, metadata);
    chunks.push({ id: chunk.id, biomeId: chunk.biomeId, global: chunk.global, bounds: chunk.bounds, url: `/environments/stream/${metadataFile}`, metadataBytes: metadata.length, matrixBytes: binary.length, batches: chunk.batches.length, sourceObjects: chunk.sourceObjects, triangles: chunk.triangles, placements: chunk.placements, geometryIds: [...new Set(chunk.batches.map(item => item.geometryId))], materialIds: [...new Set(chunk.batches.map(item => item.materialId))] });
  }
  const images = attributes.images.map(image => { const file = `images/${image.id ?? image.sha256}.png`, existing = image.file ?? image.url; if (!existing) throw new Error('Original image filename missing.'); fs.copyFileSync(path.join(source, existing), path.join(output, file)); return { ...image, url: `/environments/stream/${file}` }; });
  const manifest = { version: 1, complete: true, cellSize: 160, sourceManifestSha256, sourceInputs: attributes.sourceInputs, sourceObjects, placements, triangles: weightedTriangles, uniqueTriangles: original.uniqueTriangles, uniqueGeometries: geometries.length, renderBatches: batches.length, geometries, chunks, materials: attributes.materials, textures: attributes.textures, images, invariants: { originalTriangleOrderRestored: true, attributesByteExact: true, modelAndInstanceFactorsSeparate: true, geometryReduced: false, imagesReencoded: false }, buildSeconds: (performance.now() - started) / 1000 };
  atomic('manifest.json', JSON.stringify(manifest));
  const summary = { timestamp: new Date().toISOString(), sourceManifestSha256, output: path.relative(process.cwd(), output), chunks: chunks.length, globalChunks: chunks.filter(item => item.global).length, geometries: geometries.length, sourceObjects, placements, triangles: weightedTriangles, geometryBytes: geometries.reduce((sum, item) => sum + item.bytes, 0), metadataBytes: chunks.reduce((sum, item) => sum + item.metadataBytes, 0), matrixBytes: chunks.reduce((sum, item) => sum + item.matrixBytes, 0), buildSeconds: manifest.buildSeconds, invariants: manifest.invariants };
  fs.mkdirSync('artifacts/four-horizons/target-30fps/spatial-streaming', { recursive: true }); fs.writeFileSync('artifacts/four-horizons/target-30fps/spatial-streaming/pack.json', JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} finally { for (const descriptor of descriptors.values()) fs.closeSync(descriptor); }
