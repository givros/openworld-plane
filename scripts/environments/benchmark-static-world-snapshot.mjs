// Run with: node --import ./scripts/register-typescript.mjs scripts/environments/benchmark-static-world-snapshot.mjs
// Synthetic CPU microbenchmark at the recorded world's batch/slot scale; no GPU or GLB loading.
import fs from 'node:fs';
import os from 'node:os';
import * as THREE from 'three';
import { StaticWorldSnapshot } from '../../src/world/StaticWorldSnapshot.ts';
import { ShadowReceiverBounds } from '../../src/systems/ShadowCasterVolume.ts';

const count = 33771, instancedCount = 31180, slots = 809092;
const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
const geometries = Array.from({length: 16}, (_, i) => new THREE.BoxGeometry(2 + i * .1, 3 + i, 2));
const materials = Array.from({length: 32}, (_, i) => new THREE.MeshStandardMaterial({color: new THREE.Color().setHSL(i / 32, .5, .4)}));
const matrix = new THREE.Matrix4(), instances = [];
let assigned = 0;
for (let i = 0; i < count; i++) {
  const geometry = geometries[i % geometries.length], material = materials[i % materials.length];
  let mesh;
  if (i < instancedCount) {
    const n = Math.floor(slots / instancedCount) + (i < slots % instancedCount ? 1 : 0);
    mesh = new THREE.InstancedMesh(geometry, material, n); assigned += n;
    for (let j = 0; j < n; j++) mesh.setMatrixAt(j, matrix.makeTranslation((j % 6) * 3, 0, Math.floor(j / 6) * 3));
    instances.push(mesh);
  } else mesh = new THREE.Mesh(geometry, material);
  mesh.position.set((i % 184) * 17, 0, Math.floor(i / 184) * 17); mesh.receiveShadow = true; mesh.castShadow = true; root.add(mesh);
}
scene.updateMatrixWorld(true);
const dynamic = new THREE.Mesh(geometries[0], materials[0]); dynamic.receiveShadow = true; scene.add(dynamic);
const snapshot = new StaticWorldSnapshot(root, {sourceIdentity: 'synthetic-count-scale-fixture-v1'});
const start = performance.now(); snapshot.prepare([dynamic]); const coldMs = performance.now() - start;
snapshot.assertFresh();
const legacy = new ShadowReceiverBounds(); legacy.update(scene);
function sample(run, samples) {
  const values = [];
  for (let i = 0; i < samples; i++) {const before = performance.now(); run(i); values.push(performance.now() - before);}
  values.sort((a, b) => a - b);
  return {samples, medianMs: values[Math.floor(samples / 2)], p95Ms: values[Math.floor(samples * .95)], maximumMs: values.at(-1)};
}
const repeatedTraversal = sample(() => legacy.update(scene), 12);
const warm = sample(i => {dynamic.position.x = i * .1; snapshot.prepare([dynamic]);}, 2000);
snapshot.mutate(['instances'], [instances[0]], () => {instances[0].setMatrixAt(0, matrix.makeTranslation(50, 3, 4)); instances[0].instanceMatrix.needsUpdate = true;});
const invalidationStart = performance.now(), afterMutation = snapshot.prepare([dynamic]), partialInvalidationMs = performance.now() - invalidationStart;
snapshot.assertFresh();
const report = {timestamp: new Date().toISOString(), scope: 'Synthetic CPU bounds microbenchmark; no real source meshes, GPU, rendering, culling or production integration.',
  node: process.version, cpu: os.cpus()[0]?.model, staticBatches: count, instancedBatches: instancedCount, matrixSlots: assigned,
  uniqueFixtureGeometries: geometries.length, materials: materials.length, dynamicReceivers: 1,
  initialSnapshotMs: coldMs, legacyRepeatedReceiverTraversal: repeatedTraversal, warmStaticSnapshot: warm,
  partialInvalidationMs, partialInvalidationSources: afterMutation.processedStaticSources,
  subFiveMillisecondWarmBounds: warm.p95Ms < 5,
  fullAtmospherePreparationMeasured: false, productionPerformanceClaim: false};
fs.writeFileSync('artifacts/four-horizons/loading-profile/static-world-snapshot-cpu.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
snapshot.dispose(); for (const mesh of instances) mesh.dispose(); for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose();
