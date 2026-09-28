import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read-only topology feasibility analysis. The current binary ABI is not changed.
const folder = process.argv[2] ?? 'public/acceleration/visibility-prototype';
const output = process.argv[3] ?? 'artifacts/four-horizons/target-30fps/bvh4-topology.json';
const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
const buffer = await readFile(path.join(folder, 'nodes.bin'));
const u = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
const f = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
const isLeaf = n => !!(u[n * 8 + 7] & 0x80000000);
const area = n => {
  const b = n * 8, x = f[b + 4] - f[b], y = f[b + 5] - f[b + 1], z = f[b + 6] - f[b + 2];
  return x * y + x * z + y * z;
};
function analyze(root, binaryNodeCount, kind) {
  const stack = [[root, 0]];
  let blocks = 0, childRecords = 0, leaves = 0, primitiveReferences = 0, maximumDepth = 0;
  const occupancy = [0, 0, 0, 0, 0];
  while (stack.length) {
    const [node, depth] = stack.pop();
    const children = isLeaf(node) ? [node] : [u[node * 8 + 3], u[node * 8 + 7]];
    // Collapse the internal child with the largest AABB first. This preserves
    // its exact two child boxes and all leaf lists; only hierarchy fanout changes.
    while (children.length < 4) {
      let chosen = -1, largest = -Infinity;
      for (let i = 0; i < children.length; i++) if (!isLeaf(children[i])) {
        const a = area(children[i]); if (a > largest) { largest = a; chosen = i; }
      }
      if (chosen < 0) break;
      const old = children[chosen]; children.splice(chosen, 1, u[old * 8 + 3], u[old * 8 + 7]);
    }
    blocks++; occupancy[children.length]++; childRecords += children.length;
    maximumDepth = Math.max(maximumDepth, depth);
    for (const child of children) {
      if (isLeaf(child)) { leaves++; primitiveReferences += u[child * 8 + 7] & 0x7fffffff; }
      else stack.push([child, depth + 1]);
    }
  }
  return { kind, binaryNodeCount, binaryBytes: binaryNodeCount * 32, blocks, fixedFourChildBytes: blocks * 128, childRecords, emptyChildSlots: blocks * 4 - childRecords, leaves, primitiveReferences, maximumDepth, occupancy };
}
const geometries = manifest.geometries.map(g => ({ geometry: g.id, name: g.name, binaryDepth: g.maxDepth, ...analyze(g.blasRoot, g.nodes, 'BLAS') }));
const tlas = analyze(manifest.rootTLAS, manifest.tlasNodes, 'TLAS');
const rows = [...geometries, tlas];
const sum = key => rows.reduce((total, row) => total + row[key], 0);
const report = {
  timestamp: new Date().toISOString(), sourceManifest: path.join(folder, 'manifest.json'), sourceABIUnchanged: true,
  method: 'Topology-only greedy BVH2-to-BVH4 collapse; exact float32 child bounds and existing leaf lists retained, no geometry changes',
  binaryBytes: sum('binaryBytes'), bvh4FixedChildBytes: sum('fixedFourChildBytes'), fixedChildMemoryRatio: sum('fixedFourChildBytes') / sum('binaryBytes'),
  bvh4Blocks: sum('blocks'), childRecords: sum('childRecords'), emptyChildSlots: sum('emptyChildSlots'),
  maximumBLASDepth: Math.max(...geometries.map(g => g.maximumDepth)), maximumTLASDepth: tlas.maximumDepth,
  triangleReferences: geometries.reduce((total, g) => total + g.primitiveReferences, 0), instanceReferences: tlas.primitiveReferences,
  coverageCountsMatch: geometries.reduce((total, g) => total + g.primitiveReferences, 0) === manifest.uniqueTriangles && tlas.primitiveReferences === manifest.placements,
  limitations: ['This predicts topology and storage, not GPU time.', 'A BVH4 visit tests up to four boxes; wider fanout can increase box tests even as depth decreases.', 'GPU traversal needs a new distinct ABI and must be compared on the same rays against BVH2 before adoption.'],
  tlas, geometries,
};
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, geometries: undefined, tlas: undefined }, null, 2));
