import fs from 'node:fs';
import * as THREE from 'three';

// Offline bounds-only comparison. No browser, GPU or asset modifications.
const report = JSON.parse(fs.readFileSync(process.argv[2] ?? 'artifacts/distance-detail-20260928/temporal-tree/report.json'));
const biome = process.argv[3] ?? 'alpine-lake';
const row = report.rows.find(item => item.biome === biome);
const camera = new THREE.Matrix4().fromArray(row.cases[0].cameraMatrix);
const projection = new THREE.Matrix4().fromArray(row.cases[0].projection);
const origin = new THREE.Vector3().setFromMatrixPosition(camera);
const exactFrustum = new THREE.Frustum().setFromProjectionMatrix(projection.clone().multiply(camera.clone().invert()));
const temporalFrustum = exactFrustum.clone();
for (const plane of temporalFrustum.planes) plane.constant += 24;
const source = JSON.parse(fs.readFileSync('public/environments/stream/manifest.json'));
const detail = new Map(JSON.parse(fs.readFileSync('public/environments/lod/manifest.json')).geometries.map(item => [item.geometryId, item]));
const boxFrom = array => new THREE.Box3(new THREE.Vector3(...array.slice(0, 3)), new THREE.Vector3(...array.slice(3, 6)));
const scenarios = [
  { name: 'batch-exact-2px', temporal: false, individual: false, px: 2 },
  { name: 'batch-temporal-2px', temporal: true, individual: false, px: 2 },
  { name: 'batch-temporal-4px', temporal: true, individual: false, px: 4 },
  { name: 'batch-temporal-6px', temporal: true, individual: false, px: 6 },
  { name: 'instance-temporal-2px', temporal: true, individual: true, px: 2 },
  { name: 'subcell40-temporal-2px', temporal: true, individual: false, cell: 40, px: 2 },
  { name: 'subcell20-temporal-2px', temporal: true, individual: false, cell: 20, px: 2 },
];
const results = scenarios.map(scenario => ({ ...scenario, total: 0, instances: 0, batches: 0, geometries: new Map() }));
const pick = (levels, distance, scale, scenario) => {
  let selected;
  const guardedDistance = distance - (scenario.temporal ? 8 : 0);
  const pixels = report.viewport[1] * projection.elements[5] * .5 * (scenario.temporal ? 1.06 : 1);
  if (guardedDistance > 35) for (const level of levels) {
    // Retained level threshold approximates frozen steady state. An entering
    // level is stricter (0.88), so this does not claim live renderer parity.
    if (level.errorAbsolute * scale * pixels / guardedDistance <= scenario.px * Number(process.env.DETAIL_HYSTERESIS ?? 1.12)) selected = level;
  }
  return selected;
};
for (const chunkMeta of source.chunks) {
  const chunkBox = boxFrom(chunkMeta.bounds);
  if (!temporalFrustum.intersectsBox(chunkBox)) continue;
  const chunk = JSON.parse(fs.readFileSync(`public${chunkMeta.url}`));
  let binary;
  for (const batch of chunk.batches) {
    const batchBox = boxFrom(batch.bounds);
    if (!temporalFrustum.intersectsBox(batchBox)) continue;
    const geometry = source.geometries[batch.geometryId];
    const levels = detail.get(batch.geometryId)?.levels ?? [];
    binary ??= fs.readFileSync(`public${chunk.matrices.url}`);
    const matrices = new Float32Array(binary.buffer, binary.byteOffset + batch.matrixOffset, batch.count * 16);
    const model = new THREE.Matrix4().fromArray(batch.modelMatrix);
    const localBox = boxFrom(geometry.bounds);
    const placements = [];
    let maxScale = 0;
    for (let instance = 0; instance < batch.count; instance++) {
      const matrix = new THREE.Matrix4().fromArray(matrices, instance * 16);
      const scale = matrix.getMaxScaleOnAxis() * model.getMaxScaleOnAxis();
      maxScale = Math.max(maxScale, scale);
      matrix.premultiply(model);
      const bounds = localBox.clone().applyMatrix4(matrix);
      placements.push({ scale, bounds, distance: bounds.distanceToPoint(origin),
        exact: exactFrustum.intersectsBox(bounds), temporal: temporalFrustum.intersectsBox(bounds),
        center: bounds.getCenter(new THREE.Vector3()) });
    }
    for (const result of results) {
      const selected = placements.filter(item => result.temporal ? item.temporal : item.exact);
      if (!selected.length) continue;
      let groups;
      if (result.cell) {
        const cells = new Map();
        for (const placement of placements) {
          const key = `${Math.floor(placement.center.x / result.cell)},${Math.floor(placement.center.z / result.cell)}`;
          let group = cells.get(key);
          if (!group) cells.set(key, group = { bounds: new THREE.Box3(), scale: 0, placements: [] });
          group.bounds.union(placement.bounds); group.scale = Math.max(group.scale, placement.scale); group.placements.push(placement);
        }
        groups = [...cells.values()];
      } else groups = [{ bounds: batchBox, scale: maxScale, placements }];
      let entry = result.geometries.get(batch.geometryId);
      if (!entry) result.geometries.set(batch.geometryId, entry = { id: batch.geometryId, name: geometry.name, triangles: 0, instances: 0, levels: [0, 0, 0, 0], full: 0 });
      for (const group of groups) {
        let active = false;
        const batchLevel = pick(levels, group.bounds.distanceToPoint(origin), group.scale, result);
        for (const placement of group.placements) {
          if (!(result.temporal ? placement.temporal : placement.exact)) continue;
          if (placement.distance > 6016) continue;
          const level = result.individual ? pick(levels, placement.distance, placement.scale, result) : batchLevel;
          const triangles = level?.triangles ?? geometry.triangles;
          entry.triangles += triangles; entry.instances++; entry.levels[level?.level ?? 0]++;
          entry.full += geometry.triangles;
          result.total += triangles; result.instances++; active = true;
        }
        if (active) result.batches++;
      }
    }
  }
}
const output = { biome, origin, note: 'Offline AABB estimate using recorded frozen camera, retained-level 1.12 hysteresis; no GPU timing. Does not reproduce prior temporal-origin or LOD history.',
  results: results.map(result => ({ ...result, geometries: [...result.geometries.values()].sort((a, b) => b.triangles - a.triangles) })) };
fs.writeFileSync(`artifacts/instance-detail-budget-${biome}.json`, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.results.map(result => ({ name: result.name, triangles: result.total, instances: result.instances, batches: result.batches, top: result.geometries.slice(0, 16) })), null, 2));
