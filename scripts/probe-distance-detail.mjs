import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MeshoptSimplifier as simplifier } from 'meshoptimizer';

await simplifier.ready;
const manifest = JSON.parse(fs.readFileSync('public/environments/stream/manifest.json'));
for (const id of [105, 378, 482, 491, 102, 0]) {
  const geometry = manifest.geometries[id];
  const raw = fs.readFileSync(`public${geometry.url}`);
  const attribute = (descriptor) => new Float32Array(raw.buffer, raw.byteOffset + descriptor.byteOffset, descriptor.bytes / 4);
  const positions = attribute(geometry.attributes.position);
  const normals = attribute(geometry.attributes.normal);
  const indices = new Uint32Array(raw.buffer, raw.byteOffset + geometry.index.byteOffset, geometry.index.count);
  for (const ratio of [0.1, 0.025, 0.005]) {
    const target = Math.max(12, Math.floor(indices.length * ratio / 3) * 3);
    for (const mode of ['attributes', 'position', 'sloppy']) {
      const start = performance.now();
      const [output, error] = mode === 'attributes'
        ? simplifier.simplifyWithAttributes(indices, positions, 3, normals, 3, [0.25, 0.25, 0.25], null, target, 1, ['Permissive', 'Prune'])
        : mode === 'position'
          ? simplifier.simplify(indices, positions, 3, target, 1, ['Permissive', 'Prune'])
          : simplifier.simplifySloppy(indices, positions, 3, null, target, 1);
      console.log(JSON.stringify({ id, name: geometry.name, original: indices.length / 3, ratio, mode, triangles: output.length / 3, error, errorAbsolute: error * simplifier.getScale(positions, 3), milliseconds: performance.now() - start }));
    }
  }
}
