import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MeshoptSimplifier as simplifier } from 'meshoptimizer';

await simplifier.ready;
const source = JSON.parse(fs.readFileSync('public/environments/stream/manifest.json'));
const base = JSON.parse(fs.readFileSync('public/environments/lod-solid-safe/manifest.json'));
const baseBytes = fs.readFileSync(`public${base.buffer.url}`);
const output = 'public/environments/lod-tree-safe';
const url = '/environments/lod-tree-safe/indices.bin';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const definitions = new Map(base.geometries.map(entry => [entry.geometryId, entry]));
const chunks = [baseBytes], memo = new Map(), changes = [];
let offset = baseBytes.length;
fs.mkdirSync(output, { recursive: true });

function bounds(indices, positions) {
  const result = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const index of indices) for (let axis = 0; axis < 3; axis++) {
    const value = positions[index * 3 + axis];
    result[axis] = Math.min(result[axis], value); result[axis + 3] = Math.max(result[axis + 3], value);
  }
  return result;
}

function crossSections(indices, positions, heights, center, radius) {
  return heights.map(height => {
    const result = [Infinity, Infinity, -Infinity, -Infinity];
    for (let triangle = 0; triangle < indices.length; triangle += 3) for (let edge = 0; edge < 3; edge++) {
      const a = indices[triangle + edge] * 3, b = indices[triangle + (edge + 1) % 3] * 3;
      const ya = positions[a + 1], yb = positions[b + 1];
      if ((ya < height) === (yb < height) || Math.abs(yb - ya) < 1e-10) continue;
      const t = (height - ya) / (yb - ya), x = positions[a] + (positions[b] - positions[a]) * t, z = positions[a + 2] + (positions[b + 2] - positions[a + 2]) * t;
      if (Math.hypot(x - center[0], z - center[1]) > radius) continue;
      result[0] = Math.min(result[0], x); result[1] = Math.min(result[1], z);
      result[2] = Math.max(result[2], x); result[3] = Math.max(result[3], z);
    }
    return result;
  });
}

for (const geometry of source.geometries.filter(entry => /branching-wood/i.test(entry.name))) {
  let levels = memo.get(geometry.sha256);
  if (!levels) {
    const raw = fs.readFileSync(`public${geometry.url}`);
    if (hash(raw) !== geometry.sha256) throw new Error('Tree source checksum mismatch');
    const attribute = entry => new Float32Array(raw.buffer, raw.byteOffset + entry.byteOffset, entry.bytes / 4);
    const positions = attribute(geometry.attributes.position), normals = attribute(geometry.attributes.normal);
    const indices = new Uint32Array(raw.buffer, raw.byteOffset + geometry.index.byteOffset, geometry.index.count);
    const height = geometry.bounds[4] - geometry.bounds[1];
    const baseLimit = geometry.bounds[1] + Math.max(.25, Math.min(.5, height * .025));
    const bottom = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) if (positions[i + 1] <= baseLimit) {
      bottom[0] = Math.min(bottom[0], positions[i]); bottom[1] = Math.min(bottom[1], positions[i + 2]);
      bottom[2] = Math.max(bottom[2], positions[i]); bottom[3] = Math.max(bottom[3], positions[i + 2]);
    }
    const center = [(bottom[0] + bottom[2]) / 2, (bottom[1] + bottom[3]) / 2];
    const coreRadius = Math.max(.2, Math.min(.5, height * .025));
    const heights = [.1, .25, .5, .75].map(fraction => geometry.bounds[1] + height * fraction);
    const sectionRadius = Math.max(coreRadius * 2, .7);
    const initialLock = new Uint8Array(positions.length / 3), lock = new Uint8Array(initialLock.length);
    for (let i = 0; i < initialLock.length; i++) {
      const k = i * 3;
      initialLock[i] = +(positions[k + 1] <= baseLimit || Math.hypot(positions[k] - center[0], positions[k + 2] - center[1]) <= coreRadius ||
        [0, 1, 2].some(axis => Math.abs(positions[k + axis] - geometry.bounds[axis]) < 1e-6 || Math.abs(positions[k + axis] - geometry.bounds[axis + 3]) < 1e-6));
    }
    // Lock complete original triangles at the trunk base/core and branch tips.
    // Protecting a lone tip vertex would still let its incident triangle vanish.
    for (let i = 0; i < indices.length; i += 3) if (initialLock[indices[i]] || initialLock[indices[i + 1]] || initialLock[indices[i + 2]]) {
      lock[indices[i]] = lock[indices[i + 1]] = lock[indices[i + 2]] = 1;
    }
    for (let i = 0; i < indices.length; i += 3) for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge] * 3, b = indices[i + (edge + 1) % 3] * 3;
      for (const sectionHeight of heights) {
        const ya = positions[a + 1], yb = positions[b + 1];
        if ((ya < sectionHeight) === (yb < sectionHeight) || Math.abs(yb - ya) < 1e-10) continue;
        const t = (sectionHeight - ya) / (yb - ya), x = positions[a] + (positions[b] - positions[a]) * t, z = positions[a + 2] + (positions[b + 2] - positions[a + 2]) * t;
        if (Math.hypot(x - center[0], z - center[1]) <= sectionRadius) lock[indices[i]] = lock[indices[i + 1]] = lock[indices[i + 2]] = 1;
      }
    }
    const originalSections = crossSections(indices, positions, heights, center, sectionRadius);
    // Retain the existing medium representation, avoiding any band where a
    // newly coarser candidate would force the renderer back to the full tree.
    levels = [...(definitions.get(geometry.id)?.levels ?? [])];
    let previousCount = levels.at(-1)?.index.count ?? indices.length;
    for (const ratio of [.1, .025, .005]) {
      const level = (levels.at(-1)?.level ?? 0) + 1;
      if (level > 3) break;
      const [result, error] = simplifier.simplifyWithAttributes(indices, positions, 3, normals, 3, [.25, .25, .25], lock,
        Math.max(72, Math.floor(indices.length * ratio / 3) * 3), 1, ['Permissive']);
      if (!result.length || result.length >= previousCount) continue;
      const actualBounds = bounds(result, positions);
      const spanRatios = [0, 1, 2].map(axis => (actualBounds[axis + 3] - actualBounds[axis]) / (geometry.bounds[axis + 3] - geometry.bounds[axis]));
      const sections = crossSections(result, positions, heights, center, sectionRadius);
      const sectionRatios = sections.map((section, index) => [0, 1].map(axis => {
        const before = originalSections[index][axis + 2] - originalSections[index][axis];
        return !Number.isFinite(before) || before < 1e-6 ? 1 : (section[axis + 2] - section[axis]) / before;
      }));
      if (Math.min(...spanRatios) < .98 || Math.min(...sectionRatios.flat()) < .9 || Math.max(...sectionRatios.flat()) > 1.1) {
        console.log(JSON.stringify({ rejected: geometry.id, level, triangles: result.length / 3, spanRatios, sectionRatios }));
        continue;
      }
      const bytes = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
      const simplifierErrorAbsolute = error * simplifier.getScale(positions, 3);
      levels.push({ level, requestedRatio: ratio, ratio: result.length / indices.length, triangles: result.length / 3,
        method: 'protected-tree-wood', errorAbsolute: Math.max(simplifierErrorAbsolute, ...actualBounds.map((value, index) => Math.abs(value - geometry.bounds[index]))),
        simplifierErrorAbsolute, errorUnits: 'source-local', actualBounds, spanRatios, orientedProjectedAreaRatios: null,
        treeProtection: { lockedVertices: lock.reduce((sum, value) => sum + value, 0), coreRadius, baseLimit, sectionHeights: heights, sectionRatios },
        index: { url, byteOffset: offset, bytes: bytes.length, count: result.length, arrayType: 'Uint32Array', sha256: hash(bytes) } });
      offset += bytes.length; chunks.push(bytes); previousCount = result.length;
    }
    if (!levels.length) levels = definitions.get(geometry.id)?.levels ?? [];
    memo.set(geometry.sha256, levels);
  }
  if (levels.length) definitions.set(geometry.id, { geometryId: geometry.id, sourceSha256: geometry.sha256, sourceTriangles: geometry.triangles, sourceBounds: geometry.bounds, levels });
  changes.push({ geometryId: geometry.id, name: geometry.name, original: geometry.triangles,
    previous: base.geometries.find(entry => entry.geometryId === geometry.id)?.levels.map(entry => ({ level: entry.level, triangles: entry.triangles })),
    levels: levels.map(entry => ({ level: entry.level, triangles: entry.triangles, error: entry.errorAbsolute, protection: entry.treeProtection })) });
}

const binary = Buffer.concat(chunks), geometries = [...definitions.values()];
for (const entry of geometries) for (const level of entry.levels) level.index.url = url;
const manifest = { ...base, treeWoodDetail: true,
  invariants: { ...base.invariants, treeWoodExemption: { method: 'locked-trunk-and-tips', minimumBoundsSpanRatio: .98,
    minimumTrunkCrossSectionRatio: .9, maximumTrunkCrossSectionRatio: 1.1, pruningAllowed: false, vertexClusteringAllowed: false } },
  buffer: { url, bytes: binary.length, sha256: hash(binary) }, geometries };
fs.writeFileSync(path.join(output, 'indices.bin'), binary);
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync('artifacts/distance-detail-tree-changes.json', JSON.stringify(changes, null, 2));
console.log(JSON.stringify({ geometries: geometries.length, bytes: binary.length, addedBytes: binary.length - baseBytes.length, changes }));
