import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = data => createHash('sha256').update(data).digest('hex');
const sourceBytes = fs.readFileSync('public/environments/stream/manifest.json');
const source = JSON.parse(sourceBytes);
const outputName = process.env.LOD_OUTPUT_NAME ?? 'lod';
if (!/^lod(?:-[a-z0-9]+)*$/.test(outputName)) throw new Error('Invalid distance-detail output name');
const manifest = JSON.parse(fs.readFileSync(`public/environments/${outputName}/manifest.json`));
const raw = fs.readFileSync(`public${manifest.buffer.url}`);
assert.equal(manifest.sourceManifestSha256, hash(sourceBytes));
assert.equal(manifest.buffer.bytes, raw.length);
assert.equal(manifest.buffer.sha256, hash(raw));
let variants = 0;
let triangleSum = 0;
for (const entry of manifest.geometries) {
  const geometry = source.geometries[entry.geometryId];
  assert.equal(entry.sourceSha256, geometry.sha256);
  assert.deepEqual(entry.sourceBounds, geometry.bounds);
  assert.doesNotMatch(geometry.name, /continuous-terrain|ocean|water|lake-surface|canal-surface|river-surface/i);
  if (manifest.solidSafe) assert.doesNotMatch(geometry.name, /mesa|cliff|butte|strat[au]|sandstone|rock_orange|landform|ridge|rockface|canyon.*rock|canyon.*arch/i);
  let previousLevel = 0;
  let previousCount = geometry.index.count;
  for (const variant of entry.levels) {
    assert.ok(variant.level > previousLevel && variant.level <= 3);
    assert.ok(variant.index.count > 0 && variant.index.count < previousCount);
    assert.equal(variant.index.count % 3, 0);
    assert.equal(variant.index.byteOffset % 4, 0);
    assert.equal(variant.index.count * 4, variant.index.bytes);
    assert.equal(variant.errorUnits, 'source-local');
    assert.ok(Number.isFinite(variant.errorAbsolute) && variant.errorAbsolute >= 0);
    assert.ok(Math.min(...variant.spanRatios) >= 0.7);
    assert.ok(variant.errorAbsolute >= Math.max(...variant.actualBounds.map((value, index) => Math.abs(value - geometry.bounds[index]))));
    if (variant.orientedProjectedAreaRatios) {
      assert.ok(Math.min(...variant.spanRatios) >= 0.98);
      assert.ok(Math.min(...variant.orientedProjectedAreaRatios) >= 0.9);
      assert.ok(Math.max(...variant.orientedProjectedAreaRatios) <= 1.1);
      assert.doesNotMatch(variant.method, /cluster/);
    }
    if (variant.treeProtection) {
      assert.match(geometry.name, /branching-wood/i);
      assert.equal(variant.method, 'protected-tree-wood');
      assert.ok(variant.treeProtection.lockedVertices > 0);
      assert.ok(Math.min(...variant.spanRatios) >= .98);
      assert.ok(Math.min(...variant.treeProtection.sectionRatios.flat()) >= .9);
      assert.ok(Math.max(...variant.treeProtection.sectionRatios.flat()) <= 1.1);
    }
    const bytes = raw.subarray(variant.index.byteOffset, variant.index.byteOffset + variant.index.bytes);
    assert.equal(hash(bytes), variant.index.sha256);
    const indices = new Uint32Array(bytes.buffer, bytes.byteOffset, variant.index.count);
    assert.ok(indices.every(index => index < geometry.attributes.position.count));
    variants++;
    triangleSum += variant.triangles;
    previousLevel = variant.level;
    previousCount = variant.index.count;
  }
}
console.log(JSON.stringify({ verified: true, geometries: manifest.geometries.length, variants, triangles: triangleSum, bytes: raw.length }));
