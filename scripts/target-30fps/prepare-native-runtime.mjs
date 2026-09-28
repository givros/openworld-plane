import { readFile, writeFile, mkdir, copyFile, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const source = path.resolve('public/acceleration/visibility-world');
const nativeSource = path.resolve('artifacts/four-horizons/target-30fps/native-dxr-corrected');
const destination = path.resolve('artifacts/four-horizons/target-30fps/native-runtime');
await mkdir(destination, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const batches = JSON.parse(await readFile(path.join(source, 'attribute-source-batches.json'), 'utf8'));
const signaturesFolder = path.resolve('artifacts/four-horizons/target-30fps/raster-draw-groups');
const signatureMetadata = JSON.parse(await readFile(path.join(signaturesFolder, 'draw-groups.json'), 'utf8'));
const rawGroups = await readFile(path.join(signaturesFolder, 'instance-groups.bin'));
const rawMetadata = await readFile(path.join(source, 'native-instance-metadata.bin'));
const groups = new Uint32Array(rawGroups.buffer, rawGroups.byteOffset, rawGroups.byteLength / 4);
const metadata = new Uint32Array(rawMetadata.buffer, rawMetadata.byteOffset, rawMetadata.byteLength / 4);
if (groups.length !== manifest.placements || metadata.length !== manifest.placements * 4) throw new Error('Native runtime placement metadata mismatch');
let groupCount = 0;
for (let i = 0; i < groups.length; i++) { metadata[i * 4] = groups[i]; groupCount = Math.max(groupCount, groups[i] + 1); }
const masks = new Uint8Array(manifest.placements), covered = new Uint8Array(manifest.placements);
let shadowCasters = 0;
for (const batch of batches) for (let i = batch.sourceStart; i < batch.sourceStart + batch.count; i++) {
  if (i >= masks.length || covered[i]) throw new Error('Source batch membership is not a partition');
  masks[i] = 1 | (batch.castShadow ? 2 : 0); covered[i] = 1;
  if (batch.castShadow) shadowCasters++;
}
if (covered.some(x => !x)) throw new Error('Unassigned native instance mask');
const nodes = await open(path.join(source, 'nodes.bin'), 'r'), rawRoot = Buffer.alloc(32);
try { const result = await nodes.read(rawRoot, 0, 32, manifest.rootTLAS * 32); if (result.bytesRead !== 32) throw new Error('Missing TLAS world bounds'); }
finally { await nodes.close(); }
const root = new Float32Array(rawRoot.buffer, rawRoot.byteOffset, 8);
const bounds = new Float64Array([root[0], root[1], root[2], root[4], root[5], root[6]]);
for (let i = 0; i < 3; i++) if (!Number.isFinite(bounds[i]) || !Number.isFinite(bounds[i + 3]) || bounds[i] > bounds[i + 3]) throw new Error('Invalid world bounds');
await writeFile(path.join(destination, 'native-instance-metadata.bin'), rawMetadata);
await writeFile(path.join(destination, 'instance-masks.bin'), masks);
await writeFile(path.join(destination, 'world-bounds.bin'), new Uint8Array(bounds.buffer));
for (const file of ['geometry.bin', 'instance-geometry.bin', 'camera.bin', 'input-evidence.json']) await copyFile(path.join(nativeSource, file), path.join(destination, file));
await copyFile(path.join(signaturesFolder, 'draw-groups.json'), path.join(destination, 'draw-groups.json'));
const report = { timestamp: new Date().toISOString(), sourceManifestSha256: createHash('sha256').update(await readFile(path.join(source, 'manifest.json'))).digest('hex'), placements: manifest.placements, shadowCasters, drawGroups: groupCount, instanceMaskBits: { beauty: 1, staticShadow: 2 }, worldBounds: [...bounds], signatures: signatureMetadata.scope ?? 'Original material and draw-state signature', metadataSha256: createHash('sha256').update(rawMetadata).digest('hex') };
await writeFile(path.join(destination, 'preparation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
