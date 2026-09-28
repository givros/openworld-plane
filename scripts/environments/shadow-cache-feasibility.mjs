// CPU-only geometry/projection audit. No WebGL context or production imports.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';

const root = process.cwd();
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/four-horizons/comparisons/optimization-upload-reuse/world-pass-profile.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/environments/world-manifest.json')));
const terrain = JSON.parse(fs.readFileSync(path.join(root, 'public/environments/terrain.json')));
const direction = new THREE.Vector3(.48, -.58, .65).normalize();
const orientation = new THREE.Matrix4().lookAt(new THREE.Vector3(), direction, new THREE.Vector3(0, 1, 0));
const worldToLight = orientation.clone().invert();
let minY = Infinity, maxY = -Infinity;
for (const h of terrain.heights) { minY = Math.min(minY, h); maxY = Math.max(maxY, h); }
// This box is a sizing illustration, not an authoritative caster bound.
const estimate = new THREE.Box3(new THREE.Vector3(manifest.bounds.minX, minY, manifest.bounds.minZ),
  new THREE.Vector3(manifest.bounds.maxX, maxY + 100, manifest.bounds.maxZ)).applyMatrix4(worldToLight);
const extent = estimate.getSize(new THREE.Vector3());

function create(fov) {
  const camera = new THREE.PerspectiveCamera(fov, 1440 / 900, .15, 16000), scene = new THREE.Scene();
  const csm = new CSM({camera, parent: scene, cascades: 4, maxFar: 6000, mode: 'custom',
    customSplitsCallback: (_count, _near, far, breaks) => breaks.push(100 / far, 450 / far, 1700 / far, 1),
    shadowMapSize: 4096, lightDirection: direction, lightNear: 1, lightFar: 10000, lightMargin: 1500});
  csm.fade = true; csm.updateFrustums();
  const shaderRange = 6000 - camera.near, boundsRange = 16000 - camera.near;
  csm.frustums.forEach((f, i) => {
    const depth = f.vertices.far[0].z, extra = .25 * depth * depth * (1 / shaderRange - 1 / boundsRange);
    const c = csm.lights[i].shadow.camera;
    c.left -= extra / 2; c.right += extra / 2; c.bottom -= extra / 2; c.top += extra / 2;
    c.updateProjectionMatrix();
  });
  return {camera, csm, scene};
}

const resolutions = [20, 30, 42, 48, 52, 85].map(fov => {
  const {csm} = create(fov);
  const cascades = csm.lights.map((light, cascade) => {
    const width = light.shadow.camera.right - light.shadow.camera.left, texel = width / 4096;
    const x = Math.ceil(extent.x / texel), y = Math.ceil(extent.y / texel);
    return {cascade, widthMetres: width, metresPerTexel: texel,
      illustrativeWholeWorldTexels: [x, y], illustrativeWholeWorldDepthGiB: x * y * 4 / 2 ** 30};
  });
  csm.remove(); csm.dispose(); return {fov, cascades};
});

const moving = {};
for (const biome of manifest.biomes) {
  const rows = evidence.movingCamera.rows.filter(row => row.biome === biome.id);
  const {camera, csm, scene} = create(rows[0].pose.fov);
  const matrices = Array.from({length: 4}, () => []), lightPositions = Array.from({length: 4}, () => []);
  for (const row of rows) {
    camera.position.fromArray(row.pose.position); camera.quaternion.fromArray(row.pose.quaternion); camera.updateMatrixWorld();
    csm.update(); scene.updateMatrixWorld();
    csm.lights.forEach((light, i) => {
      light.shadow.updateMatrices(light); matrices[i].push(light.shadow.matrix.toArray());
      lightPositions[i].push(light.position.clone().applyMatrix4(worldToLight).toArray());
    });
  }
  moving[biome.id] = matrices.map((list, i) => ({cascade: i, poses: list.length,
    distinctShadowMatrices: new Set(list.map(x => JSON.stringify(x))).size,
    depthOriginChanges: lightPositions[i].slice(1).filter((p, j) => Math.abs(p[2] - lightPositions[i][j][2]) > 1e-9).length,
    maxDepthOriginStepMetres: Math.max(0, ...lightPositions[i].slice(1).map((p, j) => Math.abs(p[2] - lightPositions[i][j][2])))}));
  csm.remove(); csm.dispose();
}

const passLimits = manifest.biomes.map(biome => {
  const current = evidence.rows.find(row => row.biome === biome.id && row.mode === 'full-caster-volume');
  const cached = evidence.rows.find(row => row.biome === biome.id && row.mode === 'cached-shadow-diagnostic');
  return {biome: biome.id, currentShadowGpuMs: current.median.shadowGpuMs,
    shadowFreeBeautyGpuMs: cached.median.beautyGpuMs,
    remainingBeautySpeedupFor33ms: cached.median.beautyGpuMs / (1000 / 30),
    maximumPassTimeGainFromFreeShadows: (current.median.shadowGpuMs + current.median.beautyGpuMs) / cached.median.beautyGpuMs,
    beautySubmittedTriangles: cached.passes.beauty.triangles, beautyDrawCalls: cached.passes.beauty.calls};
});
const report = {scope: 'CPU-only analysis of existing measured evidence and local Three r184 CSM projections; no new GPU measurement.',
  performancePromise: false, sourceFile: 'comparisons/optimization-upload-reuse/world-pass-profile.json',
  passLimits, movingShadowMatrices: moving, shadowResolutions: resolutions,
  worldSizingAssumption: {terrainMinY: minY, terrainMaxY: maxY, addedHeightMetres: 100,
    lightPlaneExtentMetres: [extent.x, extent.y], authoritativeCasterBounds: false},
  currentFour4096DepthMiB: 4 * 4096 ** 2 * 4 / 2 ** 20,
  conservativeVariableFovClipmapDepthMiB: 4 * 8192 ** 2 * 4 / 2 ** 20,
  notes: ['GPU intervals are not production FPS; CPU submission may overlap GPU work.',
    'A perfect static shadow cache still leaves the measured beauty pass far above 33 ms in the heavy regions.',
    'Current CSM XY is texel-snapped but depth origin follows the moving frustum continuously.',
    'FOV is animated in production, so fixed texel spacing must be a deliberate cache design, not an assumed invariant.',
    'Atlas figures count depth only, excluding guards, dynamic casters, color attachments, source assets and residency overhead.']};
const output = path.join(root, 'artifacts/four-horizons/loading-profile/shadow-cache-feasibility.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output, passLimits, movingShadowMatrices: moving, fov48: resolutions.find(row => row.fov === 48),
  worldSizingAssumption: report.worldSizingAssumption}, null, 2));
