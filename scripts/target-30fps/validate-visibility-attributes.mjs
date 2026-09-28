import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const folders = process.argv.slice(2);
if (!folders.length) folders.push('public/acceleration/visibility-world', 'public/acceleration/visibility-prototype');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const folder of folders) {
  const began = performance.now(), sourceText = await readFile(path.join(folder, 'manifest.json'));
  const visibility = JSON.parse(sourceText), attributeText = await readFile(path.join(folder, 'attribute-manifest.json'));
  const attributes = JSON.parse(attributeText), batches = JSON.parse(await readFile(path.join(folder, attributes.sourceBatches), 'utf8'));
  if (sha256(sourceText) !== attributes.visibilityManifestSha256) throw new Error('Companion manifest identity mismatch');
  for (const key of ['uniqueGeometries', 'placements', 'weightedTriangles']) if (visibility[key] !== attributes[key]) throw new Error(`Companion census mismatch: ${key}`);
  let checkedAttributeBytes = 0, checkedAttributeRanges = 0;
  for (const [file, bytes] of Object.entries(attributes.attributeFiles)) {
    const data = await readFile(path.join(folder, file));
    if (data.length !== bytes) throw new Error(`Attribute length mismatch: ${file}`);
    for (const geometry of attributes.geometries) for (const a of Object.values(geometry.attributes)) if (a.file === file) {
      if (a.byteOffset < 0 || a.byteOffset + a.bytes > data.length || a.count !== geometry.vertices) throw new Error(`Attribute range invalid: ${geometry.id}/${file}`);
      if (sha256(data.subarray(a.byteOffset, a.byteOffset + a.bytes)) !== a.sha256) throw new Error(`Written attribute differs from canonical source hash: ${geometry.id}/${file}`);
      checkedAttributeRanges++; checkedAttributeBytes += a.bytes;
    }
  }
  const forwardBytes = await readFile(path.join(folder, attributes.forwardMatrices)), instanceBytes = await readFile(path.join(folder, attributes.nativeTransformFactors.instanceMatrices.file)), geometryBytes = await readFile(path.join(folder, attributes.instanceGeometry.file));
  const forward = new Float32Array(forwardBytes.buffer, forwardBytes.byteOffset, forwardBytes.length / 4), instances = new Float32Array(instanceBytes.buffer, instanceBytes.byteOffset, instanceBytes.length / 4), geometryIds = new Uint32Array(geometryBytes.buffer, geometryBytes.byteOffset, geometryBytes.length / 4);
  if (forward.length !== attributes.placements * 16 || instances.length !== forward.length || geometryIds.length !== attributes.placements) throw new Error('Native placement buffer length mismatch');
  let checkedMatrices = 0, checkedMatrixComponents = 0, signedZeroDifferences = 0, nextSource = 0;
  const nonIdentityModels = [];
  for (const batch of batches) {
    if (batch.sourceStart !== nextSource) throw new Error(`Noncontiguous source range: ${batch.id}`);
    const m = batch.modelMatrix;
    if (m.length !== 16) throw new Error(`Invalid native model matrix: ${batch.id}`);
    if (m.some((v, i) => v !== (i % 5 === 0 ? 1 : 0))) nonIdentityModels.push(batch.id);
    for (let instance = batch.sourceStart; instance < batch.sourceStart + batch.count; instance++) {
      if (geometryIds[instance] !== batch.geometryId) throw new Error(`Instance/geometry mismatch: ${instance}`);
      const b = instance * 16;
      for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
        const c = column * 4;
        const value = Math.fround(batch.isInstancedMesh ? m[row] * instances[b + c] + m[row + 4] * instances[b + c + 1] + m[row + 8] * instances[b + c + 2] + m[row + 12] * instances[b + c + 3] : m[c + row]);
        const expected = forward[b + c + row];
        if (value !== expected) throw new Error(`Native matrix factorization changed component: ${instance}/${column}/${row}`);
        if (!Object.is(value, expected)) signedZeroDifferences++;
        checkedMatrixComponents++;
      }
      checkedMatrices++;
    }
    nextSource += batch.count;
  }
  if (nextSource !== attributes.placements) throw new Error('Incomplete native source ranges');
  for (const image of attributes.images) {
    const bytes = await readFile(path.join(folder, image.file));
    if (bytes.length !== image.bytes || sha256(bytes) !== image.sha256 || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) throw new Error(`Original image differs: ${image.id}`);
  }
  for (const material of attributes.materials) {
    const expected = visibility.materials[material.id];
    for (const key of ['name', 'type', 'side', 'roughness', 'metalness', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'vertexColors']) if (material[key] !== expected[key]) throw new Error(`Visibility material state differs: ${material.id}/${key}`);
    for (const value of Object.values(material)) if (value && typeof value === 'object' && Object.hasOwn(value, 'texture') && !attributes.textures[value.texture]) throw new Error(`Unknown texture binding: ${material.id}`);
  }
  for (const texture of attributes.textures) if (!attributes.images.some(image => image.id === texture.image)) throw new Error(`Missing texture image: ${texture.id}`);
  const result = { timestamp: new Date().toISOString(), complete: true, passed: true, visibilityManifestSha256: sha256(sourceText), attributeManifestSha256: sha256(attributeText), checkedAttributeBytes, checkedAttributeRanges, checkedMatrices, checkedMatrixComponents, signedZeroDifferences, nonIdentityModelBatches: nonIdentityModels.length, sourceBatches: batches.length, instancedBatches: batches.filter(b => b.isInstancedMesh).length, images: attributes.images.length, originalImageAliases: attributes.images.reduce((n, image) => n + image.aliases.length, 0), textures: attributes.textures.length, materials: attributes.materials.length, limitations: ['No GPU or decoded-texture rendering is performed. This validates exact CPU source/companion transfer, native matrix factorization and original encoded image bytes.'], seconds: (performance.now() - began) / 1000 };
  await writeFile(path.join(folder, 'attribute-validation.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ folder, ...result }));
}
