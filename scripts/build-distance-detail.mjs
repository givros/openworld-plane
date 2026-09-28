import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MeshoptSimplifier as simplifier } from 'meshoptimizer';

// Derived distance representations only. Source attributes, textures and files are never changed.
const root = process.cwd();
const sourcePath = path.join(root, 'public/environments/stream/manifest.json');
const sourceBytes = fs.readFileSync(sourcePath);
const source = JSON.parse(sourceBytes);
const outputName = process.env.LOD_OUTPUT_NAME ?? 'lod';
if (!/^lod(?:-[a-z0-9]+)*$/.test(outputName)) throw new Error('Invalid distance-detail output name');
const output = path.join(root, 'public/environments', outputName);
const outputUrl = `/environments/${outputName}/indices.bin`;
const solidSafe = process.env.LOD_SOLID_SAFE !== '0';
const ratios = [0.1, 0.025, 0.005];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await simplifier.ready;
fs.mkdirSync(output, { recursive: true });
const started = performance.now();
const unique = new Map();
const chunks = [];
const geometries = [];
let byteOffset = 0;
let failures = 0;
let handled = 0;

function readArray(raw, descriptor) {
  const Type = globalThis[descriptor.arrayType];
  return new Type(raw.buffer, raw.byteOffset + descriptor.byteOffset, descriptor.bytes / Type.BYTES_PER_ELEMENT);
}

function selectedBounds(indices, positions) {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const index of indices) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[index * 3 + axis];
      bounds[axis] = Math.min(bounds[axis], value);
      bounds[axis + 3] = Math.max(bounds[axis + 3], value);
    }
  }
  return bounds;
}

function coverageBounds(indices, positions, bounds) {
  const actualBounds = selectedBounds(indices, positions);
  const spanRatios = [0, 1, 2].map(axis => {
    const span = bounds[axis + 3] - bounds[axis];
    return span < 1e-6 ? 1 : (actualBounds[axis + 3] - actualBounds[axis]) / span;
  });
  return { actualBounds, spanRatios };
}

function orientedProjectedAreas(indices, positions) {
  const areas = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const x1 = positions[b] - positions[a], y1 = positions[b + 1] - positions[a + 1], z1 = positions[b + 2] - positions[a + 2];
    const x2 = positions[c] - positions[a], y2 = positions[c + 1] - positions[a + 1], z2 = positions[c + 2] - positions[a + 2];
    const cross = [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2];
    for (let axis = 0; axis < 3; axis++) areas[axis * 2 + (cross[axis] < 0 ? 1 : 0)] += Math.abs(cross[axis]);
  }
  return areas;
}

function makeAttributes(raw, geometry, foliage) {
  const selected = Object.entries(geometry.attributes)
    .filter(([name]) => ['normal', 'uv', 'color'].includes(name));
  const weights = selected.flatMap(([name, descriptor]) => Array(descriptor.itemSize).fill(solidSafe && !foliage ? (name === 'uv' ? 0.25 : 1) : name === 'normal' ? 0.25 : name === 'color' ? 0.5 : 0.05));
  const stride = weights.length;
  const count = geometry.attributes.position.count;
  const data = new Float32Array(count * stride);
  let offset = 0;
  for (const [, descriptor] of selected) {
    const array = readArray(raw, descriptor);
    for (let index = 0; index < count; index++) {
      for (let component = 0; component < descriptor.itemSize; component++) data[index * stride + offset + component] = array[index * descriptor.itemSize + component];
    }
    offset += descriptor.itemSize;
  }
  return { data, stride, weights };
}

for (const geometry of source.geometries) {
  if (geometry.triangles < 96 || /continuous-terrain|ocean|water|lake-surface|canal-surface|river-surface/i.test(geometry.name) || geometry.groups.length || geometry.drawRange.start || geometry.drawRange.count !== null) continue;
  if (solidSafe && /mesa|cliff|butte|strat[au]|sandstone|rock_orange|landform|ridge|rockface|canyon.*rock|canyon.*arch/i.test(geometry.name)) continue;
  let levels = unique.get(geometry.sha256);
  if (!levels) {
    const raw = fs.readFileSync(path.join(root, 'public', geometry.url));
    if (hash(raw) !== geometry.sha256) throw new Error(`Source checksum mismatch: ${geometry.id}`);
    const positions = readArray(raw, geometry.attributes.position);
    const originalIndices = new Uint32Array(readArray(raw, geometry.index));
    const scale = simplifier.getScale(positions, 3);
    const foliage = /foliage|landuse|botanical|wholeplant|flower|shrub|grass|meadow.*drift/i.test(geometry.name);
    const attributes = makeAttributes(raw, geometry, foliage);
    const originalAreas = solidSafe && !foliage ? orientedProjectedAreas(originalIndices, positions) : null;
    const substantialArea = originalAreas ? Math.max(...originalAreas) * 1e-4 : 0;
    const attempts = new Map();
    const solidAttempt = (target, strict = false) => {
      const key = `${target}/${strict}`;
      if (!attempts.has(key)) attempts.set(key, simplifier.simplifyWithAttributes(originalIndices, positions, 3, attributes.data, attributes.stride, attributes.weights, null, target, strict ? 0.02 : 1, strict ? [] : ['Permissive']));
      return attempts.get(key);
    };
    levels = [];
    let previousCount = originalIndices.length;
    for (let level = 1; level <= ratios.length; level++) {
      const target = Math.max(foliage ? 36 : 72, Math.floor(originalIndices.length * ratios[level - 1] / 3) * 3);
      if (target >= previousCount) continue;
      let method = 'attribute-aware';
      let result = originalAreas ? solidAttempt(target) : simplifier.simplifyWithAttributes(originalIndices, positions, 3, attributes.data, attributes.stride, attributes.weights, null, target, 1, ['Permissive', 'Prune']);
      let [indices, error] = result;
      let areaRatios = null;
      if (originalAreas) {
        const evaluate = output => {
          if (!output.length || output.length >= previousCount) return null;
          const coverage = coverageBounds(output, positions, geometry.bounds);
          const ratios = orientedProjectedAreas(output, positions).map((area, axis) => originalAreas[axis] <= substantialArea ? 1 : area / originalAreas[axis]);
          if (Math.min(...coverage.spanRatios) < 0.98 || Math.min(...ratios) < 0.9 || Math.max(...ratios) > 1.1) return null;
          return ratios;
        };
        areaRatios = evaluate(indices);
        if (!areaRatios) {
          for (const fraction of [0.25, 0.5, 0.75]) {
            const fallbackTarget = Math.max(target, Math.floor(originalIndices.length * fraction / 3) * 3);
            if (fallbackTarget >= previousCount) continue;
            const fallback = solidAttempt(fallbackTarget);
            const candidateRatios = evaluate(fallback[0]);
            if (candidateRatios) {
              [indices, error] = fallback;
              areaRatios = candidateRatios;
              method = 'attribute-aware-solid-coverage';
              break;
            }
          }
        }
        if (!areaRatios) {
          const fallback = solidAttempt(target, true);
          areaRatios = evaluate(fallback[0]);
          if (areaRatios) {
            [indices, error] = fallback;
            method = 'strict-topology-solid-coverage';
          }
        }
        if (!areaRatios) continue;
      }
      // Isolated foliage leaves can all disappear under component pruning. Voxel clustering
      // bridges nearby original vertices and retains the original source attributes.
      if (!originalAreas && indices.length < Math.max(12, target / 3)) {
        method = 'vertex-cluster';
        [indices, error] = simplifier.simplifySloppy(originalIndices, positions, 3, null, target, 1);
      }
      let coverage = indices.length ? coverageBounds(indices, positions, geometry.bounds) : null;
      if (!originalAreas && (!coverage || Math.min(...coverage.spanRatios) < 0.7)) {
        // Never emit an empty or severely shrunken representation. A less aggressive
        // cluster target can retain the canopy / building extent when pruning cannot.
        for (const multiplier of [2, 4, 8]) {
          const fallbackTarget = Math.min(previousCount - 3, target * multiplier);
          if (fallbackTarget < 3) break;
          const fallback = simplifier.simplifySloppy(originalIndices, positions, 3, null, fallbackTarget, 1);
          const fallbackCoverage = fallback[0].length ? coverageBounds(fallback[0], positions, geometry.bounds) : null;
          if (fallbackCoverage && Math.min(...fallbackCoverage.spanRatios) >= 0.7) {
            [indices, error] = fallback;
            coverage = fallbackCoverage;
            method = 'vertex-cluster-extent-preserved';
            break;
          }
        }
      }
      if (!coverage || Math.min(...coverage.spanRatios) < 0.7 || indices.length < 3 || indices.length >= previousCount) continue;
      if (indices.some(index => index >= positions.length / 3)) throw new Error(`Invalid output index: ${geometry.id}/${level}`);
      const bytes = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
      const levelDescriptor = {
        level,
        requestedRatio: ratios[level - 1],
        ratio: indices.length / originalIndices.length,
        triangles: indices.length / 3,
        method,
        orientedProjectedAreaRatios: areaRatios,
        errorAbsolute: Math.max(error * scale, ...coverage.actualBounds.map((value, index) => Math.abs(value - geometry.bounds[index]))),
        simplifierErrorAbsolute: error * scale,
        errorUnits: 'source-local',
        actualBounds: coverage.actualBounds,
        spanRatios: coverage.spanRatios,
        index: { url: outputUrl, byteOffset, bytes: bytes.length, count: indices.length, arrayType: 'Uint32Array', sha256: hash(bytes) },
      };
      chunks.push(bytes);
      byteOffset += bytes.length;
      levels.push(levelDescriptor);
      previousCount = indices.length;
    }
    unique.set(geometry.sha256, levels);
    handled++;
    if (!levels.length) failures++;
    if (handled % 100 === 0) console.log(JSON.stringify({ uniqueGeometries: handled, elapsedSeconds: (performance.now() - started) / 1000, bytes: byteOffset, withoutVariants: failures }));
  }
  if (levels.length) geometries.push({ geometryId: geometry.id, sourceSha256: geometry.sha256, sourceTriangles: geometry.triangles, sourceBounds: geometry.bounds, levels });
}

const bytes = Buffer.concat(chunks);
const manifest = {
  version: 1,
  complete: true,
  sourceManifestSha256: hash(sourceBytes),
  sourceWorldSha256: source.sourceManifestSha256,
  ratios,
  solidSafe,
  buffer: { url: outputUrl, bytes: bytes.length, sha256: hash(bytes) },
  geometries,
  invariants: { sourceFilesUnchanged: true, originalVertexAttributesShared: true, originalMaterialsAndTexturesShared: true, terrainAndWaterUnchanged: true, emptyRepresentationsRejected: true, minimumBoundsSpanRatio: 0.7, solidMinimumBoundsSpanRatio: solidSafe ? 0.98 : null, solidMinimumOrientedProjectedAreaRatio: solidSafe ? 0.9 : null, solidPruningAllowed: !solidSafe, solidVertexClusteringAllowed: !solidSafe },
  buildSeconds: (performance.now() - started) / 1000,
};
// Write the manifest last so it never advertises an incomplete aggregate pack.
fs.writeFileSync(path.join(output, 'indices.bin'), bytes);
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
console.log(JSON.stringify({ complete: true, geometries: geometries.length, uniqueGeometries: handled, bytes: bytes.length, seconds: manifest.buildSeconds, withoutVariants: failures }));
