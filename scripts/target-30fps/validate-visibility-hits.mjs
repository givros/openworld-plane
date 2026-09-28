import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Independent double-precision oracle. GPU inverse matrices are deliberately
// ignored for the primary reference; triangles use plane intersection followed
// by projected 2D barycentrics, rather than the GPU Moller-Trumbore calculation.
const reportPath = process.argv[2] ?? 'artifacts/four-horizons/target-30fps/visibility-world-scalar/report.json';
const folder = process.argv[3] ?? 'public/acceleration/visibility-world';
const output = process.argv[4] ?? path.join(path.dirname(reportPath), 'cpu-oracle.json');
const started = performance.now();
const reportText = await readFile(reportPath, 'utf8'), report = JSON.parse(reportText);
const manifestText = await readFile(path.join(folder, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
if (!report.inspection?.validationHits?.length || !report.inspection.cameraParams) throw new Error('GPU report has no captured validation rays');
for (const key of ['uniqueGeometries', 'uniqueTriangles', 'placements', 'weightedTriangles', 'rootTLAS']) {
  if (report.setup.manifest[key] !== manifest[key]) throw new Error(`GPU report/dataset mismatch: ${key}`);
}
if (JSON.stringify(report.setup.manifest.inputEvidence) !== JSON.stringify(manifest.inputEvidence)) throw new Error('GPU report/dataset source fingerprint mismatch');
const buffers = {};
for (const name of ['nodes.bin', 'positions.bin', 'triangles.bin', 'instances.bin', 'instances-forward.bin', 'instance-order.bin', 'triangle-source.bin']) {
  if ((await stat(path.join(folder, name))).size !== manifest.buffers[name]) throw new Error(`Dataset length mismatch: ${name}`);
  buffers[name] = await readFile(path.join(folder, name));
}
const view = (name, Type) => new Type(buffers[name].buffer, buffers[name].byteOffset, buffers[name].byteLength / Type.BYTES_PER_ELEMENT);
const nodeF = view('nodes.bin', Float32Array), nodeU = view('nodes.bin', Uint32Array);
const positions = view('positions.bin', Float32Array), triangles = view('triangles.bin', Uint32Array);
const instanceF = view('instances.bin', Float32Array), instanceU = view('instances.bin', Uint32Array);
const forward = view('instances-forward.bin', Float32Array), order = view('instance-order.bin', Uint32Array), originalTriangles = view('triangle-source.bin', Uint32Array);
const MISS = 0xffffffff, LEAF = 0x80000000;
const inverseCache = new Map();
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.sqrt(dot(a, a));
const normalize = a => { const l = length(a); return a.map(v => v / l); };
function inverseFromForward(id) {
  if (inverseCache.has(id)) return inverseCache.get(id);
  const b = id * 16;
  const a = forward[b], c01 = forward[b + 4], c02 = forward[b + 8], c10 = forward[b + 1], c11 = forward[b + 5], c12 = forward[b + 9], c20 = forward[b + 2], c21 = forward[b + 6], c22 = forward[b + 10];
  const determinant = a * (c11 * c22 - c12 * c21) - c01 * (c10 * c22 - c12 * c20) + c02 * (c10 * c21 - c11 * c20);
  if (determinant === 0 || !Number.isFinite(determinant)) throw new Error(`Singular matrix ${id}`);
  const inverse = new Float64Array([
    c11 * c22 - c12 * c21, c02 * c21 - c01 * c22, c01 * c12 - c02 * c11, 0,
    c12 * c20 - c10 * c22, a * c22 - c02 * c20, c02 * c10 - a * c12, 0,
    c10 * c21 - c11 * c20, c01 * c20 - a * c21, a * c11 - c01 * c10, 0,
  ]);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) inverse[row * 4 + column] /= determinant;
    inverse[row * 4 + 3] = -(inverse[row * 4] * forward[b + 12] + inverse[row * 4 + 1] * forward[b + 13] + inverse[row * 4 + 2] * forward[b + 14]);
  }
  inverseCache.set(id, inverse); return inverse;
}
function localRay(id, ray, usePackedInverse = false) {
  const m = usePackedInverse ? instanceF.subarray(id * 16, id * 16 + 12) : inverseFromForward(id);
  const origin = [], direction = [];
  for (let row = 0; row < 3; row++) {
    const b = row * 4;
    origin[row] = m[b] * ray.origin[0] + m[b + 1] * ray.origin[1] + m[b + 2] * ray.origin[2] + m[b + 3];
    direction[row] = m[b] * ray.direction[0] + m[b + 1] * ray.direction[1] + m[b + 2] * ray.direction[2];
  }
  return { ...ray, origin, direction };
}
function nearBox(node, ray, far) {
  const b = node * 8; let low = ray.near, high = far;
  for (let axis = 0; axis < 3; axis++) {
    const direction = ray.direction[axis], origin = ray.origin[axis];
    if (direction === 0) { if (origin < nodeF[b + axis] || origin > nodeF[b + axis + 4]) return Infinity; continue; }
    let a = (nodeF[b + axis] - origin) / direction, z = (nodeF[b + axis + 4] - origin) / direction;
    if (a > z) [a, z] = [z, a];
    low = Math.max(low, a); high = Math.min(high, z);
    if (low > high) return Infinity;
  }
  return low;
}
function trianglePoints(triangle, instance = null) {
  const points = [];
  for (let corner = 0; corner < 3; corner++) {
    const p = triangles[triangle * 3 + corner] * 3;
    const local = [positions[p], positions[p + 1], positions[p + 2]];
    if (instance === null) points.push(local);
    else {
      const b = instance * 16;
      points.push([0, 1, 2].map(axis => forward[b + axis] * local[0] + forward[b + axis + 4] * local[1] + forward[b + axis + 8] * local[2] + forward[b + axis + 12]));
    }
  }
  return points;
}
function planeTriangle(points, ray, far, allowOutside = false) {
  const [a, b, c] = points, ab = subtract(b, a), ac = subtract(c, a), normal = cross(ab, ac), denominator = dot(normal, ray.direction);
  if (denominator === 0) return null;
  const distance = dot(normal, subtract(a, ray.origin)) / denominator;
  if (!allowOutside && (distance < ray.near || distance > far)) return null;
  const offset = ray.origin.map((value, axis) => value + distance * ray.direction[axis] - a[axis]);
  let dominant = 0;
  for (let axis = 1; axis < 3; axis++) if (Math.abs(normal[axis]) > Math.abs(normal[dominant])) dominant = axis;
  const i = (dominant + 1) % 3, j = (dominant + 2) % 3;
  const determinant = ab[i] * ac[j] - ab[j] * ac[i];
  const u = (offset[i] * ac[j] - offset[j] * ac[i]) / determinant;
  const v = (ab[i] * offset[j] - ab[j] * offset[i]) / determinant;
  if (!allowOutside && (u < 0 || v < 0 || u + v > 1)) return null;
  return { distance, u, v, frontFace: denominator < 0, incidenceCosine: Math.abs(denominator) / (length(normal) * length(ray.direction)) };
}
function trace(ray, usePackedInverse = false) {
  let best = { instance: MISS, triangle: MISS, distance: ray.far, u: 0, v: 0 }, nodeTests = 0, triangleTests = 0;
  function walk(root, currentRay, visitLeaf) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop(), b = node * 8; nodeTests++;
      if (!Number.isInteger(node) || node < 0 || node >= manifest.nodeCount) throw new Error(`Invalid acceleration node ${node}`);
      if (nearBox(node, currentRay, best.distance) === Infinity) continue;
      if (nodeU[b + 7] & LEAF) visitLeaf(nodeU[b + 3], nodeU[b + 7] & 0x7fffffff);
      else {
        const left = nodeU[b + 3], right = nodeU[b + 7], l = nearBox(left, currentRay, best.distance), r = nearBox(right, currentRay, best.distance);
        if (l < r) { if (r !== Infinity) stack.push(right); if (l !== Infinity) stack.push(left); }
        else { if (l !== Infinity) stack.push(left); if (r !== Infinity) stack.push(right); }
      }
    }
  }
  walk(manifest.rootTLAS, ray, (start, count) => {
    for (let i = start; i < start + count; i++) {
      const instance = order[i], local = localRay(instance, ray, usePackedInverse);
      walk(instanceU[instance * 16 + 12], local, (triangleStart, triangleCount) => {
        for (let triangle = triangleStart; triangle < triangleStart + triangleCount; triangle++) {
          triangleTests++;
          const hit = planeTriangle(trianglePoints(triangle), local, best.distance);
          if (hit && hit.distance < best.distance) best = { instance, triangle, ...hit };
        }
      });
    }
  });
  return { ...best, nodeTests, triangleTests };
}
const offsets = report.setup.sampleOffsetsTopLeft ?? [[.375, .125], [.875, .375], [.125, .625], [.625, .875]];
function cameraRay(hit, float32Arithmetic = false) {
  const c = report.inspection.cameraParams, width = report.setup.width, height = report.setup.height;
  const [ox, oy] = report.setup.samples === 1 ? [.5, .5] : offsets[hit.sample];
  const round = float32Arithmetic ? Math.fround : x => x;
  const vector = (x, y) => c.base.map((value, axis) => round(round(value + round(c.dx[axis] * x)) + round(c.dy[axis] * y)));
  const normalized = value => {
    if (!float32Arithmetic) return normalize(value);
    const norm = round(Math.sqrt(round(round(round(value[0] * value[0]) + round(value[1] * value[1])) + round(value[2] * value[2]))));
    return value.map(x => round(x / norm));
  };
  const forward = normalized(vector(width * .5, height * .5)), direction = normalized(vector(hit.x + ox, hit.y + oy));
  const cosine = dot(forward, direction);
  return { origin: [...c.origin], direction, near: c.near / cosine, far: c.far / cosine };
}
const tolerances = { distanceAbsoluteMeters: .001, distanceRelative: 1e-6, barycentricAbsolute: .001, boundaryWorldAbsoluteMeters: .0005, boundaryWorldRelativeToDistance: 2e-7 };
const distanceTolerance = t => tolerances.distanceAbsoluteMeters + tolerances.distanceRelative * Math.abs(t);
function surfacePosition(instance, triangle, u, v) {
  const [a, b, c] = trianglePoints(triangle, instance);
  return a.map((value, axis) => value + (b[axis] - value) * u + (c[axis] - value) * v);
}
function projectPixel(point) {
  const { origin, base, dx, dy } = report.inspection.cameraParams, v = subtract(point, origin);
  // Solve v = scale * (base + pixelX*dx + pixelY*dy) directly. This
  // retains the captured basis' small float32 non-orthogonality too.
  const denominator = dot(v, cross(dx, dy));
  return [dot(base, cross(v, dy)) / denominator, dot(base, cross(dx, v)) / denominator];
}
function edgeDiagnostic(instance, triangle, ray) {
  if (instance === MISS || triangle === MISS) return null;
  const points = trianglePoints(triangle, instance), hit = planeTriangle(points, ray, Infinity, true);
  if (!hit) return { parallelOrDegenerate: true };
  const ab = subtract(points[1], points[0]), ac = subtract(points[2], points[0]), area2 = length(cross(ab, ac));
  const altitudes = [area2 / length(subtract(points[2], points[1])), area2 / length(ac), area2 / length(ab)];
  const signedEdgeDistances = [1 - hit.u - hit.v, hit.u, hit.v].map((v, i) => v * altitudes[i]);
  const material = manifest.materials[instanceU[instance * 16 + 13]];
  return { ...hit, signedEdgeDistancesMeters: signedEdgeDistances, minimumAbsoluteEdgeDistanceMeters: Math.min(...signedEdgeDistances.map(Math.abs)), originalTriangle: originalTriangles[triangle], material: material?.name, polygonOffset: material?.polygonOffset };
}
const rows = [];
for (const gpu of report.inspection.validationHits) {
  const ray = cameraRay(gpu), cpu = trace(ray), found = cpu.instance !== MISS, sameFound = found === (gpu.instance !== MISS);
  const sameIds = cpu.instance === gpu.instance && cpu.triangle === gpu.triangle;
  const distanceError = sameFound ? Math.abs(cpu.distance - gpu.distance) : null;
  const barycentricError = sameIds && found ? Math.max(Math.abs(cpu.u - gpu.u), Math.abs(cpu.v - gpu.v)) : null;
  const withinDistance = sameFound && (distanceError <= distanceTolerance(cpu.distance));
  const withinBarycentric = !found || (sameIds && barycentricError <= tolerances.barycentricAbsolute);
  const row = { pixel: [gpu.x, gpu.y], sample: gpu.sample, gpu, cpu, sameFound, sameIds, distanceErrorMeters: distanceError, distanceToleranceMeters: distanceTolerance(cpu.distance), barycentricError, withinDistance, withinBarycentric, pass: sameIds && withinDistance && withinBarycentric };
  if (sameIds && found) {
    const cpuPosition = surfacePosition(cpu.instance, cpu.triangle, cpu.u, cpu.v), gpuPosition = surfacePosition(gpu.instance, gpu.triangle, gpu.u, gpu.v);
    const cpuPixel = projectPixel(cpuPosition), gpuPixel = projectPixel(gpuPosition);
    row.surfacePositionErrorMeters = length(subtract(cpuPosition, gpuPosition));
    row.projectedSurfaceDisplacementPixels = Math.hypot(cpuPixel[0] - gpuPixel[0], cpuPixel[1] - gpuPixel[1]);
  } else { row.surfacePositionErrorMeters = null; row.projectedSurfaceDisplacementPixels = null; }
  if (!row.pass) {
    const cpuEdge = edgeDiagnostic(cpu.instance, cpu.triangle, ray), gpuEdge = edgeDiagnostic(gpu.instance, gpu.triangle, ray);
    const packed = trace(ray, true), roundedRay = trace(cameraRay(gpu, true));
    const edgeTolerance = tolerances.boundaryWorldAbsoluteMeters + tolerances.boundaryWorldRelativeToDistance * cpu.distance;
    row.diagnostics = { ray, cpuEdge, gpuTriangleOnReferenceRay: gpuEdge, worldEdgeToleranceMeters: edgeTolerance, nearTriangleBoundary: !!((cpuEdge?.minimumAbsoluteEdgeDistanceMeters ?? Infinity) <= edgeTolerance || (gpuEdge?.minimumAbsoluteEdgeDistanceMeters ?? Infinity) <= edgeTolerance), packedFloat32InverseReference: packed, roundedFloat32CameraReference: roundedRay, packedInverseMatchesGpuIds: packed.instance === gpu.instance && packed.triangle === gpu.triangle, roundedCameraMatchesGpuIds: roundedRay.instance === gpu.instance && roundedRay.triangle === gpu.triangle };
  }
  rows.push(row);
}
const max = key => Math.max(0, ...rows.filter(r => r[key] !== null).map(r => r[key]));
const result = {
  timestamp: new Date().toISOString(), gpuReport: reportPath, gpuReportSha256: createHash('sha256').update(reportText).digest('hex'), datasetManifest: path.join(folder, 'manifest.json'), datasetManifestSha256: createHash('sha256').update(manifestText).digest('hex'),
  method: 'Independent Float64 forward-matrix inverse and triangle-plane/projected-barycentric intersections; existing unquantized BVH is only a broadphase. Primary reference does not read the packed GPU inverse matrices.',
  scope: '192 stratified pixels per sample from one supplied camera report, not an exhaustive full-image/raster/shading equivalence proof',
  rayConstruction: 'Double evaluation of the captured float32 camera basis; mismatches additionally test non-fused Float32 camera arithmetic and packed inverse transforms independently. Hardware FMA/normalize error may differ from either model.',
  tolerances, rays: rows.length, passed: rows.filter(r => r.pass).length, hitMissDisagreements: rows.filter(r => !r.sameFound).length, identityDisagreements: rows.filter(r => !r.sameIds).length, distanceDisagreements: rows.filter(r => !r.withinDistance).length, barycentricDisagreements: rows.filter(r => !r.withinBarycentric).length,
  maximumDistanceErrorMeters: max('distanceErrorMeters'), maximumSameTriangleBarycentricError: max('barycentricError'), boundaryRelatedDisagreements: rows.filter(r => !r.pass && r.diagnostics.nearTriangleBoundary).length,
  maximumSameTriangleSurfacePositionErrorMeters: max('surfacePositionErrorMeters'), maximumSameTriangleProjectedDisplacementPixels: max('projectedSurfaceDisplacementPixels'),
  strictAllWithinTolerance: rows.every(r => r.pass), elapsedSeconds: (performance.now() - started) / 1000,
  limitations: ['A stratified sample cannot exclude errors elsewhere in the image.', 'BVH broadphase shares exported source bounds; this is an independent intersection/transform oracle, not an independent rebuild of acceleration.', 'Raster polygon offset, coverage, clipping tie rules, shader attributes, shadows and transparency composition are outside this visibility-only check.', 'Boundary diagnostics explain possible float32 sensitivity; they never change a failed sample into a pass.'], rows,
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
