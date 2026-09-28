// Read GLB JSON only. No scene loading, browser, or GPU use.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const manifest = JSON.parse(fs.readFileSync('public/environments/world-manifest.json', 'utf8'));
const rows = [];
for (const biome of manifest.biomes) {
  const file = path.resolve('public', biome.url.replace(/^\//, ''));
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(20);
  fs.readSync(fd, header, 0, 20, 0);
  if (header.toString('ascii', 0, 4) !== 'glTF') throw new Error('Invalid GLB');
  const bytes = Buffer.alloc(header.readUInt32LE(12));
  fs.readSync(fd, bytes, 0, bytes.length, 20);
  const data = JSON.parse(bytes.toString('utf8'));
  const imageEvidence = [];
  for (const image of data.images ?? []) {
    const view = data.bufferViews[image.bufferView];
    const payload = Buffer.alloc(view.byteLength);
    fs.readSync(fd, payload, 0, payload.length, 28 + bytes.length + (view.byteOffset ?? 0));
    const isPng = payload.toString('ascii', 1, 4) === 'PNG';
    imageEvidence.push({ name: image.name, mimeType: image.mimeType, sha256: crypto.createHash('sha256').update(payload).digest('hex'), width: isPng ? payload.readUInt32BE(16) : null, height: isPng ? payload.readUInt32BE(20) : null });
  }
  fs.closeSync(fd);
  const materials = data.materials ?? [];
  const counts = {};
  const count = key => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const material of materials) {
    count(`alpha_${material.alphaMode ?? 'OPAQUE'}`);
    if (material.doubleSided) count('doubleSided');
    for (const [key, value] of Object.entries(material)) if (/Texture$/.test(key) && value) count(key);
    for (const [key, value] of Object.entries(material.pbrMetallicRoughness ?? {})) if (/Texture$/.test(key) && value) count(key);
    for (const key of Object.keys(material.extensions ?? {})) count(key);
  }
  const attributeLayouts = {};
  for (const mesh of data.meshes) for (const primitive of mesh.primitives) {
    const key = Object.keys(primitive.attributes).sort().join(',');
    attributeLayouts[key] = (attributeLayouts[key] ?? 0) + 1;
  }
  rows.push({ biome: biome.id, file, glbJsonSha256: crypto.createHash('sha256').update(bytes).digest('hex'), materialDefinitions: materials.length, textures: data.textures?.length ?? 0, images: data.images?.length ?? 0, imageEvidence, materialFeatureCounts: counts, primitiveAttributeLayouts: attributeLayouts });
}
const report = { createdAt: new Date().toISOString(), evidence: 'Current public GLB JSON and embedded image bytes. Runtime route polygon-offset clones are additional.', gpuUsed: false, distinctImageContents: new Set(rows.flatMap(row => row.imageEvidence.map(image => image.sha256))).size, rows };
fs.writeFileSync('artifacts/four-horizons/target-30fps/deferred-shading/material-inventory.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({createdAt: report.createdAt, distinctImageContents: report.distinctImageContents, rows: rows.map(({imageEvidence, ...row}) => row)}, null, 2));
