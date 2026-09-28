import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MeshoptSimplifier as simplifier } from 'meshoptimizer';

await simplifier.ready;
const manifest = JSON.parse(fs.readFileSync('public/environments/stream/manifest.json'));
const ids = [482, 491, 492, 1593, 2511, ...manifest.geometries.filter(g => /mesa|cliff/i.test(g.name)).slice(0, 3).map(g => g.id)];
function projectedAreas(indices, positions) {
  const area = [0, 0, 0];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const x1 = positions[b] - positions[a], y1 = positions[b + 1] - positions[a + 1], z1 = positions[b + 2] - positions[a + 2];
    const x2 = positions[c] - positions[a], y2 = positions[c + 1] - positions[a + 1], z2 = positions[c + 2] - positions[a + 2];
    area[0] += Math.abs(y1 * z2 - z1 * y2);
    area[1] += Math.abs(z1 * x2 - x1 * z2);
    area[2] += Math.abs(x1 * y2 - y1 * x2);
  }
  return area;
}
for (const id of ids) {
  const geometry = manifest.geometries[id];
  const raw = fs.readFileSync(`public${geometry.url}`);
  const array = descriptor => new Float32Array(raw.buffer, raw.byteOffset + descriptor.byteOffset, descriptor.bytes / 4);
  const positions = array(geometry.attributes.position);
  const normals = array(geometry.attributes.normal);
  const indices = new Uint32Array(raw.buffer, raw.byteOffset + geometry.index.byteOffset, geometry.index.count);
  const areas = projectedAreas(indices, positions);
  for (const ratio of [0.1, 0.025, 0.005]) {
    for (const mode of ['strict', 'permissive']) {
      const start = performance.now();
      const target = Math.max(72, Math.floor(indices.length * ratio / 3) * 3);
      const [output, error] = simplifier.simplifyWithAttributes(indices, positions, 3, normals, 3, [1, 1, 1], null, target, 1, mode === 'strict' ? [] : ['Permissive']);
      const areaRatios = projectedAreas(output, positions).map((area, axis) => areas[axis] ? area / areas[axis] : 1);
      console.log(JSON.stringify({ id, name: geometry.name, original: indices.length / 3, ratio, mode, triangles: output.length / 3, areaRatios, errorAbsolute: error * simplifier.getScale(positions, 3), milliseconds: performance.now() - start }));
    }
  }
}
