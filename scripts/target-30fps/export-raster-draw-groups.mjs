import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildRasterDrawGroups } from '../../src/experiments/rasterDrawGroups.mjs';
const dataset = 'public/acceleration/visibility-world', output = 'artifacts/four-horizons/target-30fps/raster-draw-groups';
const manifestBytes = await readFile(`${dataset}/attribute-manifest.json`), manifest = JSON.parse(manifestBytes);
const batchesBytes = await readFile(`${dataset}/${manifest.sourceBatches}`), batches = JSON.parse(batchesBytes);
const { groups, instanceGroup } = buildRasterDrawGroups(batches, manifest.geometries, manifest.materials, manifest.placements);
const bytes = Buffer.from(instanceGroup.buffer), hash = x => createHash('sha256').update(x).digest('hex');
const counts = new Uint32Array(groups.length); for (const id of instanceGroup) counts[id]++;
if (groups.length !== 625 || instanceGroup.length !== 811683) throw new Error('Unexpected final-world signature census');
await mkdir(output, { recursive: true }); await writeFile(`${output}/instance-groups.bin`, bytes);
await writeFile(`${output}/draw-groups.json`, JSON.stringify({ timestamp: new Date().toISOString(), version: 1,
  scope: 'Exact native draw signature grouping; preserves canonical world instance IDs and material references. Replaces only the dedup partition/group ID, never original instance or triangle IDs.',
  placements: instanceGroup.length, groupCount: groups.length, instanceGroups: { file: 'instance-groups.bin', type: 'Uint32Array', bytes: bytes.length, sha256: hash(bytes) },
  inputHashes: { manifest: hash(manifestBytes), batches: hash(batchesBytes) }, groups: groups.map((group, id) => ({ id, ...group, originalInstances: counts[id] })) }, null, 2));
console.log(JSON.stringify({ groupCount: groups.length, placements: instanceGroup.length, bytes: bytes.length, sha256: hash(bytes) }));
