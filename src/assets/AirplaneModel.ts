import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MaterialLibrary } from './MaterialLibrary';
import type { Controls, FlightState } from '../game/types';

export const AIRCRAFT_DIMENSIONS = Object.freeze({ length: 9.8, wingspan: 11.76, mainWheelRadius: 0.52, tailWheelRadius: 0.20, propellerVisibleRadius: 1.81, propellerSafetyRadius: 1.86, propellerHub: [0, 2.42, 4.34], neutralPropellerClearance: 0.56 });
type Ring = readonly [number, number, number, number];
type WingStation = readonly [number, number, number, number, number];
const FUSELAGE: readonly Ring[] = [
  [-4.85, 2.34, .13, .16], [-4.57, 2.32, .29, .33], [-4.08, 2.29, .43, .47], [-3.36, 2.25, .56, .59], [-2.42, 2.20, .68, .71], [-1.55, 2.16, .84, .85], [-.72, 2.13, .96, .94], [.18, 2.11, 1.01, .98], [1.08, 2.09, 1.02, .97], [1.92, 2.08, .99, .92], [2.70, 2.09, .91, .83], [3.32, 2.12, .79, .72], [3.78, 2.16, .63, .57], [4.08, 2.22, .40, .40],
];
const CABIN: readonly Ring[] = [
  [1.20, 2.45, .58, .40], [1.08, 2.46, .63, .61], [.94, 2.47, .64, 1.03], [.78, 2.47, .68, 1.23], [.56, 2.47, .70, 1.29], [.28, 2.46, .71, 1.31], [0, 2.45, .70, 1.28], [-.28, 2.44, .68, 1.19], [-.55, 2.42, .62, 1.02], [-.78, 2.39, .53, .77], [-.98, 2.36, .39, .52], [-1.16, 2.33, .27, .39], [-1.31, 2.30, .14, .18],
];
const WINGS: readonly WingStation[] = [[.12, 2.04, 1.22, -.98, .24], [1.85, 2.25, 1.12, -.88, .21], [3.75, 2.47, .98, -.74, .17], [5.24, 2.64, .84, -.58, .13], [5.68, 2.69, .68, -.40, .09], [5.88, 2.71, .45, -.16, .055]];
const TAIL: readonly WingStation[] = [[.08, 2.29, -3.82, -5.02, .15], [1.20, 2.35, -3.97, -4.90, .12], [1.78, 2.38, -4.12, -4.83, .09], [2.05, 2.39, -4.30, -4.72, .05]];
const CHORD = [0, .055, .16, .35, .62, .85, 1];
const SECTION = [0, .55, .9, 1, .72, .34, 0];
const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function buffer(positions: number[], indices?: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
  if (indices) geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function refinedRings(source: readonly Ring[]): Ring[] {
  const rings: Ring[] = [];
  for (let i = 0; i < source.length - 1; i++) {
    const p0 = source[Math.max(0, i - 1)]!, p1 = source[i]!, p2 = source[i + 1]!, p3 = source[Math.min(source.length - 1, i + 2)]!;
    for (let step = 0; step < 4; step++) {
      const t = step / 4, t2 = t * t, t3 = t2 * t;
      const c = (axis: number): number => .5 * (2 * p1[axis]! + (-p0[axis]! + p2[axis]!) * t + (2 * p0[axis]! - 5 * p1[axis]! + 4 * p2[axis]! - p3[axis]!) * t2 + (-p0[axis]! + 3 * p1[axis]! - 3 * p2[axis]! + p3[axis]!) * t3);
      rings.push([lerp(p1[0], p2[0], t), c(1), c(2), c(3)]);
    }
  }
  rings.push(source[source.length - 1]!);
  return rings;
}

const HULL_RINGS = refinedRings(FUSELAGE);
function ringAt(z: number): Ring {
  const bounded = clamp(z, HULL_RINGS[0]![0], HULL_RINGS[HULL_RINGS.length - 1]![0]);
  let i = 0;
  while (i < HULL_RINGS.length - 2 && HULL_RINGS[i + 1]![0] < bounded) i++;
  const a = HULL_RINGS[i]!, b = HULL_RINGS[i + 1]!, t = (bounded - a[0]) / (b[0] - a[0]);
  return [bounded, lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}


function hullShell(upper: boolean): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [], start = upper ? 0 : Math.PI;
  for (const ring of HULL_RINGS) for (let j = 0; j <= 14; j++) {
    const theta = start + j / 14 * Math.PI;
    positions.push(Math.cos(theta) * ring[2], ring[1] + Math.sin(theta) * ring[3], ring[0]);
  }
  for (let i = 0; i < HULL_RINGS.length - 1; i++) for (let j = 0; j < 14; j++) {
    const a = i * 15 + j, b = a + 15;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return buffer(positions, indices);
}

type Point2 = readonly [number, number];
type SurfaceVertex = { uv: Point2; point: THREE.Vector3; normal: THREE.Vector3 };

/** Convex clipping preserves each source triangle's plane rather than bridging it. */
function clipPolygon(subject: Point2[], clipper: readonly Point2[]): Point2[] {
  const cross = (a: Point2, b: Point2, p: Point2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const sign = Math.sign(cross(clipper[0]!, clipper[1]!, clipper[2]!)) || 1;
  let result = subject;
  for (let edge = 0; edge < clipper.length; edge++) {
    const a = clipper[edge]!, b = clipper[(edge + 1) % clipper.length]!, input = result;
    result = [];
    if (!input.length) break;
    let previous = input[input.length - 1]!, previousDistance = cross(a, b, previous) * sign;
    for (const current of input) {
      const distance = cross(a, b, current) * sign;
      if ((distance >= -1e-10) !== (previousDistance >= -1e-10)) {
        const t = previousDistance / (previousDistance - distance);
        result.push([lerp(previous[0], current[0], t), lerp(previous[1], current[1], t)]);
      }
      if (distance >= -1e-10) result.push(current);
      previous = current; previousDistance = distance;
    }
  }
  return result;
}

function appendSurfacePolygon(points: readonly Point2[], triangle: readonly SurfaceVertex[], bias: number, direction: THREE.Vector3 | null, positions: number[], normals: number[]): void {
  if (points.length < 3) return;
  const a = triangle[0]!, b = triangle[1]!, c = triangle[2]!;
  const denominator = (b.uv[1] - c.uv[1]) * (a.uv[0] - c.uv[0]) + (c.uv[0] - b.uv[0]) * (a.uv[1] - c.uv[1]);
  if (Math.abs(denominator) < 1e-12) return;
  const append = (point: Point2): void => {
    const u = ((b.uv[1] - c.uv[1]) * (point[0] - c.uv[0]) + (c.uv[0] - b.uv[0]) * (point[1] - c.uv[1])) / denominator;
    const v = ((c.uv[1] - a.uv[1]) * (point[0] - c.uv[0]) + (a.uv[0] - c.uv[0]) * (point[1] - c.uv[1])) / denominator;
    const w = 1 - u - v, normal = a.normal.clone().multiplyScalar(u).addScaledVector(b.normal, v).addScaledVector(c.normal, w).normalize();
    const p = a.point.clone().multiplyScalar(u).addScaledVector(b.point, v).addScaledVector(c.point, w).addScaledVector(direction ?? normal, bias);
    positions.push(p.x, p.y, p.z); normals.push(normal.x, normal.y, normal.z);
  };
  for (let i = 1; i < points.length - 1; i++) {
    const area = (points[i]![0] - points[0]![0]) * (points[i + 1]![1] - points[0]![1]) - (points[i]![1] - points[0]![1]) * (points[i + 1]![0] - points[0]![0]);
    if (Math.abs(area) < 1e-12) continue;
    append(points[0]!);
    if (area * denominator > 0) { append(points[i]!); append(points[i + 1]!); }
    else { append(points[i + 1]!); append(points[i]!); }
  }
}

function decalBuffer(positions: number[], normals: number[]): THREE.BufferGeometry {
  const geometry = buffer(positions);
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

function hullPatch(z0: number, z1: number, low: number, high: number, side: number, _segments = 40): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [];
  const angle0 = side > 0 ? low : Math.PI - high, angle1 = side > 0 ? high : Math.PI - low;
  const rectangle: Point2[] = [[z0, angle0], [z1, angle0], [z1, angle1], [z0, angle1]];
  const angleStep = TAU / 28;
  const vertex = (ring: Ring, index: number): SurfaceVertex => {
    const theta = index * angleStep, cosine = Math.cos(theta), sine = Math.sin(theta);
    return { uv: [ring[0], theta], point: new THREE.Vector3(cosine * ring[2], ring[1] + sine * ring[3], ring[0]), normal: new THREE.Vector3(cosine / ring[2], sine / ring[3], 0).normalize() };
  };
  for (let r = 0; r < HULL_RINGS.length - 1; r++) {
    const ring0 = HULL_RINGS[r]!, ring1 = HULL_RINGS[r + 1]!;
    if (ring1[0] < z0 || ring0[0] > z1) continue;
    for (let j = Math.floor(angle0 / angleStep); j < Math.ceil(angle1 / angleStep); j++) {
      const a = vertex(ring0, j), b = vertex(ring0, j + 1), c = vertex(ring1, j), d = vertex(ring1, j + 1);
      for (const triangle of [[a, b, c], [b, d, c]]) {
        const clipped = clipPolygon(triangle.map(v => v.uv), rectangle);
        appendSurfacePolygon(clipped, triangle, .0065, null, positions, normals);
      }
    }
  }
  return decalBuffer(positions, normals);
}

function projectShapeOntoSurface(shape: THREE.Shape, surface: THREE.BufferGeometry, side: number, bias: number): THREE.BufferGeometry {
  const marking = new THREE.ShapeGeometry(shape, 16), mp = marking.getAttribute('position'), mi = marking.index;
  const sp = surface.getAttribute('position'), sn = surface.getAttribute('normal'), si = surface.index;
  const positions: number[] = [], normals: number[] = [], direction = side ? new THREE.Vector3(side, 0, 0) : new THREE.Vector3(0, 0, 1);
  const surfaceTriangles: { vertices: SurfaceVertex[]; bounds: number[] }[] = [];
  for (let i = 0; i < (si?.count ?? sp.count); i += 3) {
    const ids = [0, 1, 2].map(offset => si ? si.getX(i + offset) : i + offset);
    const vertices = ids.map(id => { const point = new THREE.Vector3().fromBufferAttribute(sp, id); return { point, normal: new THREE.Vector3().fromBufferAttribute(sn, id), uv: [side ? point.z : point.x, point.y] as Point2 }; });
    const faceNormal = vertices[1]!.point.clone().sub(vertices[0]!.point).cross(vertices[2]!.point.clone().sub(vertices[0]!.point));
    if (faceNormal.dot(direction) <= 1e-10) continue;
    surfaceTriangles.push({ vertices, bounds: [Math.min(...vertices.map(v => v.uv[0])), Math.min(...vertices.map(v => v.uv[1])), Math.max(...vertices.map(v => v.uv[0])), Math.max(...vertices.map(v => v.uv[1]))] });
  }
  for (let i = 0; i < (mi?.count ?? mp.count); i += 3) {
    const triangle: Point2[] = [0, 1, 2].map(offset => { const index = mi ? mi.getX(i + offset) : i + offset; return [mp.getX(index), mp.getY(index)]; });
    const u0 = Math.min(...triangle.map(p => p[0])), u1 = Math.max(...triangle.map(p => p[0])), v0 = Math.min(...triangle.map(p => p[1])), v1 = Math.max(...triangle.map(p => p[1]));
    for (const facet of surfaceTriangles) {
      const bounds = facet.bounds;
      if (u1 < bounds[0]! || u0 > bounds[2]! || v1 < bounds[1]! || v0 > bounds[3]!) continue;
      const clipped = clipPolygon(triangle, facet.vertices.map(v => v.uv));
      appendSurfacePolygon(clipped, facet.vertices, bias, direction, positions, normals);
    }
  }
  marking.dispose();
  return decalBuffer(positions, normals);
}

function loftCabin(): THREE.BufferGeometry {
  const rings = refinedRings(CABIN), positions: number[] = [], indices: number[] = [], count = 32;
  for (const [z, base, radius, height] of rings) for (let j = 0; j <= count; j++) {
    const theta = j / count * Math.PI, cos = Math.cos(theta), sin = Math.sin(theta);
    positions.push(Math.sign(cos) * Math.pow(Math.abs(cos), 2 / 3.7) * radius, base + Math.pow(sin, 2 / 3.7) * height, z);
  }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < count; j++) {
    const a = i * (count + 1) + j, b = a + count + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return buffer(positions, indices);
}

function interpolateStation(stations: readonly WingStation[], x: number): WingStation {
  const at = clamp(x, stations[0]![0], stations[stations.length - 1]![0]);
  let i = 0;
  while (i < stations.length - 2 && stations[i + 1]![0] < at) i++;
  const a = stations[i]!, b = stations[i + 1]!, t = (at - a[0]) / (b[0] - a[0]);
  return [at, lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t), lerp(a[4], b[4], t)];
}
function wingPoint(stations: readonly WingStation[], x: number, chord: number, top: boolean, side: number, bias = 0): THREE.Vector3 {
  const station = interpolateStation(stations, x);
  let j = 0;
  while (j < CHORD.length - 2 && CHORD[j + 1]! < chord) j++;
  const h = lerp(SECTION[j]!, SECTION[j + 1]!, (chord - CHORD[j]!) / (CHORD[j + 1]! - CHORD[j]!));
  return new THREE.Vector3(side * x, station[1] + (top ? 1 : -1) * (station[4] * h * .5 + bias), lerp(station[2], station[3], chord));
}
function wingSurface(stations: readonly WingStation[], side: number): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [], row = CHORD.length * 2;
  for (const station of stations) for (let layer = 0; layer < 2; layer++) for (const u of CHORD) {
    const p = wingPoint(stations, station[0], u, layer === 0, side);
    positions.push(p.x, p.y, p.z);
  }
  for (let i = 0; i < stations.length - 1; i++) for (let layer = 0; layer < 2; layer++) for (let j = 0; j < CHORD.length - 1; j++) {
    const a = i * row + layer * CHORD.length + j, b = a + row;
    if ((side > 0) === (layer === 0)) indices.push(a, b, a + 1, a + 1, b, b + 1);
    else indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  for (const stationIndex of [0, stations.length - 1]) for (let j = 0; j < CHORD.length - 1; j++) {
    const a = stationIndex * row + j, b = a + CHORD.length;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return buffer(positions, indices);
}
function wingPanel(stations: readonly WingStation[], side: number, top: boolean, x0: number, x1: number, u0: number, u1: number): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [], nx = Math.max(1, Math.min(24, Math.ceil((x1 - x0) * 4))), nu = Math.max(1, Math.min(16, Math.ceil((u1 - u0) * 20)));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nu; j++) {
    const p = wingPoint(stations, lerp(x0, x1, i / nx), lerp(u0, u1, j / nu), top, side, .0065);
    positions.push(p.x, p.y, p.z);
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < nu; j++) {
    const a = i * (nu + 1) + j, b = a + nu + 1;
    if ((side > 0) === top) indices.push(a, b, a + 1, a + 1, b, b + 1);
    else indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return buffer(positions, indices);
}

/** Static detail is baked into one buffer per material; pivots remain independent. */
class StaticBatch {
  private readonly parts = new Map<THREE.Material, { name: string; geometry: THREE.BufferGeometry }[]>();
  add(name: string, geometry: THREE.BufferGeometry, material: THREE.Material): void {
    const list = this.parts.get(material) ?? [];
    list.push({ name, geometry });
    this.parts.set(material, list);
  }
  finish(parent: THREE.Group): void {
    for (const [material, parts] of this.parts) {
      const sources = parts.map(({ geometry }) => {
        const normalized = geometry.index ? geometry.toNonIndexed() : geometry.clone();
        for (const attribute of Object.keys(normalized.attributes)) if (!['position', 'normal', 'uv'].includes(attribute)) normalized.deleteAttribute(attribute);
        if (!normalized.getAttribute('uv')) normalized.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(normalized.getAttribute('position').count * 2), 2));
        return normalized;
      });
      const merged = mergeGeometries(sources, false);
      let vertexOffset = 0;
      const partRanges = parts.map((part, index) => { const count = sources[index]!.getAttribute('position').count; const range = { name: part.name, start: vertexOffset, count }; vertexOffset += count; return range; });
      for (const geometry of sources) geometry.dispose();
      for (const part of parts) part.geometry.dispose();
      if (!merged) throw new Error('Aircraft material batch could not be merged.');
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = material.name;
      mesh.userData.parts = parts.map(({ name }) => name);
      mesh.userData.partRanges = partRanges;
      mesh.castShadow = !material.transparent && material.name !== 'Eye white' && material.name !== 'Graphite livery and trim';
      mesh.receiveShadow = false;
      parent.add(mesh);
    }
    this.parts.clear();
  }
}

function sphere(x: number, y: number, z: number, sx: number, sy: number, sz: number, segments = 24): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, segments, Math.max(6, Math.floor(segments * .45))).scale(sx, sy, sz).translate(x, y, z);
}
function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, ends = 10): THREE.BufferGeometry {
  const direction = b.clone().sub(a), geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), ends);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  geometry.applyQuaternion(quaternion).translate((a.x + b.x) * .5, (a.y + b.y) * .5, (a.z + b.z) * .5);
  return geometry;
}
function curvedRod(points: number[][], radius: number, segments = 20): THREE.BufferGeometry {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2]))), segments, radius, 8, false);
}
function extrudedShape(shape: THREE.Shape, depth: number, bevel = .015): THREE.BufferGeometry {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12, steps: 1 });
}


function polygon(points: number[][]): THREE.Shape {
  const shape = new THREE.Shape();
  points.forEach((p, i) => i ? shape.lineTo(p[0]!, p[1]!) : shape.moveTo(p[0]!, p[1]!));
  shape.closePath();
  return shape;
}
function disc(x: number, y: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absarc(x, y, radius, 0, TAU, false);
  return shape;
}

export class AirplaneModel {
  readonly root = new THREE.Group();
  readonly materials: MaterialLibrary;
  private readonly propellerPivot = new THREE.Group();
  private readonly blurMesh: THREE.Mesh;
  private readonly mainWheels: THREE.Group[] = [];
  private readonly tailWheel = new THREE.Group();
  private readonly ailerons: THREE.Group[] = [];
  private readonly elevator = new THREE.Group();
  private readonly rudder = new THREE.Group();
  private readonly eyeGazes: THREE.Group[] = [];
  private readonly ownsMaterials: boolean;
  private mainSpin = 0;
  private tailSpin = 0;
  private disposed = false;
  private readonly modelMetrics: { meshes: number; geometries: number; materials: number; triangles: number; bounds: number[]; semanticParts: string[] };

  constructor(materials?: MaterialLibrary) {
    this.ownsMaterials = !materials;
    this.materials = materials ?? new MaterialLibrary();
    this.root.name = 'Cropper Seven procedural aircraft';
    const m = this.materials, batch = new StaticBatch();
    for (const name of ['Fuselage', 'Main wings', 'Integrated cockpit', 'Windshield face', 'Conforming livery', 'Tail assembly', 'Fixed landing gear', 'Agricultural spray booms', 'Engine and exhausts']) {
      const group = new THREE.Group();
      group.name = name;
      group.userData.bakedIntoSharedMaterialBatches = true;
      this.root.add(group);
    }
    this.buildFuselage(batch);
    this.buildWings(batch);
    this.buildTail(batch);
    this.buildCockpit(batch);
    this.buildLivery(batch);
    this.buildLandingGear(batch);
    this.buildAgriculturalEquipment(batch);
    batch.finish(this.root);
    this.buildPropeller();
    this.blurMesh = new THREE.Mesh(new THREE.RingGeometry(.47, 1.86, 64, 3), m.blur);
    this.blurMesh.name = 'Propeller additive motion blur';
    this.blurMesh.position.set(0, 2.42, 4.38);
    this.blurMesh.visible = false;
    this.root.add(this.blurMesh);
    this.root.updateMatrixWorld(true);
    const geometries = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(), names = new Set<string>();
    let meshes = 0, triangles = 0;
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++;
      geometries.add(object.geometry);
      const materialList = Array.isArray(object.material) ? object.material : [object.material];
      materialList.forEach(material => mats.add(material));
      triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
      for (const name of (object.userData.parts ?? [object.name]) as string[]) names.add(name);
    });
    const bounds = new THREE.Box3().setFromObject(this.root), size = bounds.getSize(new THREE.Vector3());
    this.modelMetrics = { meshes, geometries: geometries.size, materials: mats.size, triangles, bounds: [size.x, size.y, size.z], semanticParts: [...names] };
  }

  private buildFuselage(batch: StaticBatch): void {
    const m = this.materials;
    batch.add('Rounded elliptical upper fuselage — 28 angular segments', hullShell(true), m.primary);
    batch.add('Warm-white elliptical lower fuselage', hullShell(false), m.warmWhite);
    batch.add('Rounded tail cap', sphere(0, 2.34, -4.85, .13, .16, .14), m.primary);
    const cowling = new THREE.CylinderGeometry(.56, .69, .46, 40, 3).rotateX(Math.PI / 2).translate(0, 2.22, 4.04);
    batch.add('Tapered brushed metal nose cowling', cowling, m.metal);
    batch.add('Cowling rear graphite sealing ring', new THREE.TorusGeometry(.66, .023, 6, 40).translate(0, 2.22, 3.83), m.graphite);
    batch.add('Cowling front trim ring', new THREE.TorusGeometry(.553, .024, 6, 40).translate(0, 2.22, 4.27), m.metal);
    batch.add('White crop hopper', sphere(0, 1.32, .05, .72, .34, 1.18), m.warmWhite);
    batch.add('Hopper aluminum outlet', new THREE.CylinderGeometry(.20, .15, .15, 16).translate(0, 1.02, -.22), m.metal);
    const intake = new THREE.Shape();
    intake.moveTo(-.35, 0); intake.quadraticCurveTo(-.32, .30, -.15, .32); intake.lineTo(.15, .32); intake.quadraticCurveTo(.32, .30, .35, 0); intake.closePath();
    batch.add('Dorsal intake sculpted orange lip', extrudedShape(intake, .42, .045).translate(0, 2.78, 3.02), m.primary);
    const throat = new THREE.Shape();
    throat.moveTo(-.255, .015); throat.quadraticCurveTo(-.24, .185, -.11, .20); throat.lineTo(.11, .20); throat.quadraticCurveTo(.24, .185, .255, .015); throat.closePath();
    batch.add('Black dorsal intake opening', new THREE.ShapeGeometry(throat, 12).translate(0, 2.85, 3.493), m.graphite);
    for (let i = -2; i <= 2; i++) batch.add('Intake grille blades', new THREE.BoxGeometry(.023, .155, .017).translate(i * .074, 2.94, 3.506), m.darkMetal);
    for (const side of [-1, 1]) {
      batch.add('Curved metallic exhaust', curvedRod([[side * .82, 2.04, 2.72], [side * 1.04, 1.99, 2.65], [side * 1.13, 1.9, 2.48], [side * 1.12, 1.86, 2.35]], .084), m.metal);
      batch.add('Dark exhaust mouth', new THREE.CircleGeometry(.069, 14).rotateY(Math.PI).translate(side * 1.12, 1.86, 2.332), m.graphite);
      batch.add('Cowling inset fasteners', sphere(side * .48, 2.54, 4.198, .026, .026, .011, 10), m.darkMetal);
      for (const z of [1.65, 2.09, 2.5]) batch.add('Engine access panel louvers', hullPatch(z, z + .15, .54, .57, side, 3), m.graphite);
      batch.add('Fuselage nose panel seam', hullPatch(3.17, 3.18, -.8, 1.36, side, 1), m.darkMetal);
    }
  }

  private buildWings(batch: StaticBatch): void {
    const m = this.materials;
    for (const side of [-1, 1]) {
      batch.add('Closed seven-sample dihedral main wing', wingSurface(WINGS, side), m.primary);
      batch.add('Warm-white upper wing inset', wingPanel(WINGS, side, true, .93, 5.36, .14, .72), m.warmWhite);
      batch.add('Warm-white lower wing inset', wingPanel(WINGS, side, false, .93, 5.36, .14, .72), m.warmWhite);
      batch.add('Orange rolled leading edge highlight', wingPanel(WINGS, side, true, .3, 5.73, .025, .066), m.highlight);
      for (const x of [1.85, 3.75, 5.22]) batch.add('Subtle spanwise access seam', wingPanel(WINGS, side, true, x, x + .012, .11, .78), m.darkMetal);
      batch.add('Aileron hinge seam', wingPanel(WINGS, side, true, 3.15, 5.40, .849, .862), m.graphite);
      batch.add('Dark-metal structural wing brace', rod(new THREE.Vector3(side * .62, 1.48, .34), new THREE.Vector3(side * 3.78, 2.49, .16), .048), m.darkMetal);
      batch.add('Wing brace attachment shoes', sphere(side * 3.76, 2.445, .16, .13, .08, .18, 12), m.metal);
      batch.add('Wingtip red navigation light', sphere(side * 5.78, 2.741, .45, .084, .045, .15, 14), m.navRed);
      const aileron = new THREE.Group();
      aileron.name = side < 0 ? 'Pilot right aileron pivot' : 'Pilot left aileron pivot';
      aileron.position.set(side * 4.24, 2.52, -.49);
      const flapStations: WingStation[] = [3.15, 3.75, 5.24, 5.4].map(x => {
        const station = interpolateStation(WINGS, x);
        return [x, station[1] + .011, lerp(station[2], station[3], .85), station[3], station[4] * .34];
      });
      const flap = wingSurface(flapStations, side).translate(-side * 4.24, -2.52, .49);
      const mesh = new THREE.Mesh(flap, m.primary);
      mesh.name = 'Articulated aileron';
      mesh.castShadow = true;
      aileron.add(mesh);
      this.ailerons.push(aileron);
      this.root.add(aileron);
    }
  }

  private buildTail(batch: StaticBatch): void {
    const m = this.materials;
    for (const side of [-1, 1]) {
      batch.add('Orange horizontal stabilizer', wingSurface(TAIL, side), m.primary);
      batch.add('Lighter orange stabilizer panel', wingPanel(TAIL, side, true, .40, 1.76, .17, .70), m.highlight);
      batch.add('Stabilizer trailing hinge', wingPanel(TAIL, side, true, .23, 1.78, .82, .84), m.graphite);
    }
    this.elevator.name = 'Elevator pivot';
    this.elevator.position.set(0, 2.36, -4.8);
    const elevatorMesh = new THREE.Mesh(new THREE.BoxGeometry(3.5, .075, .24).translate(0, 0, -.06), m.primary);
    elevatorMesh.name = 'Separate elevator'; elevatorMesh.castShadow = true;
    this.elevator.add(elevatorMesh); this.root.add(this.elevator);
    const fin = new THREE.Shape();
    fin.moveTo(-3.24, 2.41); fin.quadraticCurveTo(-3.75, 3.13, -4.04, 4.43); fin.quadraticCurveTo(-4.17, 4.88, -4.42, 4.89); fin.quadraticCurveTo(-4.67, 4.90, -4.73, 4.66); fin.lineTo(-4.75, 2.48); fin.quadraticCurveTo(-4.12, 2.21, -3.24, 2.41);
    batch.add('Tall swept rounded vertical fin', extrudedShape(fin, .12, .045).rotateY(-Math.PI / 2).translate(.06, 0, 0), m.primary);
    for (const side of [-1, 1]) {
      const finPanel = new THREE.Shape();
      finPanel.moveTo(-3.72, 2.65); finPanel.lineTo(-4.26, 4.38); finPanel.quadraticCurveTo(-4.32, 4.54, -4.43, 4.57); finPanel.lineTo(-4.60, 4.53); finPanel.lineTo(-4.60, 2.68); finPanel.closePath();
      batch.add('Tail sheen inset', this.tailDecal(finPanel, side, .110), m.sheen);
      for (const y of [2.86, 3.10]) {
        const chevron = polygon([[-3.70 - (y - 2.86) * .27, y], [-4.57, y + .23], [-4.57, y + .33], [-3.75 - (y - 2.86) * .27, y + .10]]);
        batch.add('Swept black tail chevron', this.tailDecal(chevron, side, .113), m.graphite);
      }
      const letter = new THREE.Shape();
      letter.moveTo(-4.51, 3.44); letter.lineTo(-4.51, 4.24); letter.lineTo(-4.30, 4.24); letter.bezierCurveTo(-3.98, 4.22, -3.98, 3.48, -4.30, 3.44); letter.closePath();
      const hole = new THREE.Path();
      hole.moveTo(-4.385, 3.57); hole.lineTo(-4.29, 3.57); hole.bezierCurveTo(-4.11, 3.64, -4.11, 4.05, -4.29, 4.11); hole.lineTo(-4.385, 4.11); hole.closePath();
      letter.holes.push(hole);
      const letterGeometry = this.tailDecal(letter, side, .115);
      if (side > 0) {
        const p = letterGeometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) p.setZ(i, -8.64 - p.getZ(i));
        const index = letterGeometry.index;
        if (index) for (let i = 0; i < index.count; i += 3) { const a = index.getX(i); index.setX(i, index.getX(i + 2)); index.setX(i + 2, a); }
        letterGeometry.computeVertexNormals();
      }
      batch.add('Custom white capital D tail letter', letterGeometry, m.warmWhite);
      batch.add('Rudder hinge seam', rod(new THREE.Vector3(side * .112, 2.60, -4.64), new THREE.Vector3(side * .112, 4.58, -4.64), .008, 5), m.graphite);
    }
    this.rudder.name = 'Rudder pivot'; this.rudder.position.set(0, 2.29, -4.64);
    const rudderShape = new THREE.Shape();
    rudderShape.moveTo(0, .25); rudderShape.lineTo(0, 2.29); rudderShape.quadraticCurveTo(-.12, 2.28, -.16, 2.1); rudderShape.lineTo(-.18, .25); rudderShape.closePath();
    const rudderMesh = new THREE.Mesh(extrudedShape(rudderShape, .10, .012).rotateY(-Math.PI / 2).translate(.05, 0, 0), m.primary);
    rudderMesh.name = 'Separate articulated rudder'; rudderMesh.castShadow = true;
    this.rudder.add(rudderMesh); this.root.add(this.rudder);
  }

  private tailDecal(shape: THREE.Shape, side: number, x: number): THREE.BufferGeometry {
    const geometry = new THREE.ShapeGeometry(shape, 16).rotateY(-Math.PI / 2).translate(side * x, 0, 0);
    if (side > 0) {
      const index = geometry.index;
      if (index) for (let i = 0; i < index.count; i += 3) { const a = index.getX(i); index.setX(i, index.getX(i + 2)); index.setX(i + 2, a); }
      geometry.computeVertexNormals();
    }
    return geometry;
  }

  private buildCockpit(batch: StaticBatch): void {
    const m = this.materials, cabinGeometry = loftCabin();
    const project = (shape: THREE.Shape, side: number, offset: number, _rounds = 2): THREE.BufferGeometry => projectShapeOntoSurface(shape, cabinGeometry, side, offset);
    batch.add('Continuous rounded-square superellipse cockpit loft', cabinGeometry, m.primary);
    const windshield = new THREE.Shape();
    windshield.moveTo(-.59, 2.73); windshield.quadraticCurveTo(-.55, 3.13, -.405, 3.54); windshield.quadraticCurveTo(0, 3.615, .405, 3.54); windshield.quadraticCurveTo(.55, 3.13, .59, 2.73); windshield.quadraticCurveTo(0, 2.63, -.59, 2.73);
    batch.add('Smoky curved front windshield surround', project(windshield, 0, .007, 2), m.glass);
    for (const side of [-1, 1]) {
      const window = new THREE.Shape();
      window.moveTo(.64, 2.60); window.lineTo(.55, 3.38); window.quadraticCurveTo(.14, 3.42, -.20, 3.26); window.lineTo(-.30, 2.63); window.quadraticCurveTo(.12, 2.55, .64, 2.60);
      batch.add('Curved side window', project(window, side, .009, 2), m.glass);
      const frame = new THREE.Shape();
      frame.moveTo(.63, 2.60); frame.lineTo(.53, 3.36); frame.lineTo(.565, 3.37); frame.lineTo(.67, 2.60); frame.closePath();
      batch.add('Forward window orange mullion', project(frame, side, .017), m.primary);
      const shine = polygon([[.46, 3.31], [.42, 3.15], [-.14, 3.03], [-.17, 3.19]]);
      batch.add('Blue-white side glass reflection', project(shine, side, .019, 3), m.glassHighlight);
      const lowerShine = polygon([[.43, 2.65], [.40, 2.69], [-.19, 2.72], [-.18, 2.66]]);
      batch.add('Lower continuous window glint', project(lowerShine, side, .02, 2), m.glassHighlight);
    }
    const band = new THREE.Shape();
    band.moveTo(-.51, 3.35); band.quadraticCurveTo(-.30, 3.34, 0, 3.225); band.quadraticCurveTo(.30, 3.34, .51, 3.35); band.lineTo(.525, 3.02); band.quadraticCurveTo(0, 2.86, -.525, 3.02); band.closePath();
    batch.add('Curved warm-white expressive eye band', project(band, 0, .010, 2), m.eyeWhite);
    for (const side of [-1, 1]) {
      const irisX = side * .261, irisY = 3.108;
      const gaze = new THREE.Group();
      gaze.name = side < 0 ? 'Right eye gaze pivot' : 'Left eye gaze pivot';
      const eyeBatch = new StaticBatch();
      eyeBatch.add('Blue iris', project(disc(irisX, irisY, .111), 0, .013, 1), m.iris);
      eyeBatch.add('Inward-convergent pupil', project(disc(side * .248, irisY - .004, .049), 0, .016, 1), m.pupil);
      eyeBatch.add('White eye catchlight', project(disc(side * .248 - .019, irisY + .030, .018), 0, .019, 1), m.catchlight);
      eyeBatch.finish(gaze); this.root.add(gaze); this.eyeGazes.push(gaze);
      const brow = new THREE.Shape();
      brow.moveTo(side * .04, 3.245); brow.lineTo(side * .51, 3.395); brow.quadraticCurveTo(side * .56, 3.41, side * .535, 3.49); brow.quadraticCurveTo(side * .29, 3.46, side * .055, 3.34); brow.closePath();
      batch.add('Thick determined orange brow', project(brow, 0, .022), m.primary);
      const rim = polygon([[side * .05, 3.236], [side * .505, 3.385], [side * .507, 3.37], [side * .053, 3.222]]);
      batch.add('Subtle dark upper eye contour', project(rim, 0, .021), m.graphite);
    }
    batch.add('Smoky glass glaze across the face', project(windshield, 0, .025, 2), m.windshield);
    const shine = new THREE.Shape();
    shine.moveTo(-.376, 3.503); shine.quadraticCurveTo(-.22, 3.544, .115, 3.543); shine.lineTo(.128, 3.563); shine.quadraticCurveTo(-.20, 3.572, -.370, 3.528); shine.closePath();
    batch.add('Continuous blue-white windshield highlight', project(shine, 0, .028), m.glassHighlight);
    const lower = new THREE.Shape();
    lower.moveTo(-.52, 2.743); lower.quadraticCurveTo(0, 2.690, .51, 2.743); lower.lineTo(.511, 2.765); lower.quadraticCurveTo(0, 2.712, -.52, 2.765); lower.closePath();
    batch.add('Windshield lower polished orange rail', project(lower, 0, .014), m.highlight);
  }

  private projectHullShape(shape: THREE.Shape, side: number, _rounds = 2, bias = .0065): THREE.BufferGeometry {
    const upper = hullShell(true), lower = hullShell(false), surface = mergeGeometries([upper, lower], false)!;
    const geometry = projectShapeOntoSurface(shape, surface, side, bias);
    upper.dispose(); lower.dispose(); surface.dispose();
    return geometry;
  }

  private buildLivery(batch: StaticBatch): void {
    const m = this.materials;
    batch.add('Flush upper-shell black aft-cockpit collar', hullPatch(-1.59, -1.37, 0, Math.PI, 1, 7), m.graphite);
    for (const side of [-1, 1]) {
      batch.add('Flush upper black fuselage pinstripe', hullPatch(-1.37, 3.18, .286, .382, side, 90), m.graphite);
      batch.add('Flush lower black fuselage pinstripe', hullPatch(-1.37, 3.18, .144, .199, side, 90), m.graphite);
      for (const z of [-1.03, -.72]) {
        const slash = polygon([[z - .17, 2.31], [z + .005, 2.31], [z + .165, 2.95], [z - .01, 2.95]]);
        batch.add('Flush angled white side slash', this.projectHullShape(slash, side, 3, .007), m.warmWhite);
      }
      const smile = new THREE.Shape();
      smile.moveTo(2.94, 1.985); smile.bezierCurveTo(3.24, 1.85, 3.49, 1.91, 3.61, 2.00); smile.lineTo(3.59, 2.019); smile.bezierCurveTo(3.34, 1.95, 3.17, 1.92, 2.95, 2.006); smile.closePath();
      batch.add('Curved small black nose smile', this.projectHullShape(smile, side, 2), m.graphite);
      const skull = new THREE.Shape();
      skull.absellipse(3.415, 2.396, .112, .102, 0, TAU, false, 0);
      const eye1 = new THREE.Path(); eye1.absellipse(3.373, 2.413, .027, .028, 0, TAU, true, 0); skull.holes.push(eye1);
      const eye2 = new THREE.Path(); eye2.absellipse(3.46, 2.413, .027, .028, 0, TAU, true, 0); skull.holes.push(eye2);
      batch.add('Procedural skull nose emblem', this.projectHullShape(skull, side, 2), m.graphite);
      batch.add('Skull jaw', this.projectHullShape(polygon([[3.357, 2.34], [3.36, 2.274], [3.465, 2.274], [3.473, 2.34]]), side, 1), m.graphite);
      for (const sign of [-1, 1]) {
        const bone = polygon([[3.265, 2.295 + sign * .045], [3.279, 2.311 + sign * .045], [3.566, 2.18 - sign * .045], [3.55, 2.164 - sign * .045]]);
        batch.add('Skull crossed bones', this.projectHullShape(bone, side, 2), m.graphite);
      }
      for (let i = 0; i < 6; i++) {
        const z = -3.35 + i * .38;
        batch.add('Fuselage recessed rivets', this.projectHullShape(disc(z, ringAt(z)[1] + .04, .016), side, 0), m.darkMetal);
      }
    }
  }

  private buildLandingGear(batch: StaticBatch): void {
    const m = this.materials;
    for (const side of [-1, 1]) {
      batch.add('White main oleo strut', rod(new THREE.Vector3(side * .64, 1.74, 1.16), new THREE.Vector3(side * 1.76, .53, .72), .091, 12), m.warmWhite);
      batch.add('Silver trailing gear brace', rod(new THREE.Vector3(side * .70, 1.52, -.67), new THREE.Vector3(side * 1.76, .55, .72), .051, 10), m.metal);
      batch.add('Polished oleo inner sleeve', rod(new THREE.Vector3(side * 1.48, .84, .835), new THREE.Vector3(side * 1.75, .55, .73), .065, 12), m.metal);
      batch.add('Main-wheel axle', rod(new THREE.Vector3(side * 1.57, .52, .72), new THREE.Vector3(side * 1.91, .52, .72), .095, 12), m.darkMetal);
      batch.add('Main gear orange shoulder fairing', sphere(side * .67, 1.69, 1.13, .16, .18, .24, 14), m.primary);
      const wheel = this.buildWheel(.52, .27, 'Main wheel');
      wheel.position.set(side * 1.76, .52, .72);
      this.mainWheels.push(wheel); this.root.add(wheel);
    }
    batch.add('Integrated tail-wheel yoke', curvedRod([[0, 2.24, -4.44], [0, 1.78, -4.64], [0, .80, -4.61], [0, .26, -4.67]], .059, 16), m.warmWhite);
    batch.add('Tail-wheel silver tension brace', rod(new THREE.Vector3(0, 1.52, -4.03), new THREE.Vector3(0, .49, -4.62), .033, 8), m.metal);
    batch.add('Tailwheel upper aerodynamic fairing', sphere(0, 1.93, -4.52, .16, .48, .25, 16), m.primary);
    const tail = this.buildWheel(.20, .13, 'Tail wheel');
    this.tailWheel.name = 'Tail wheel spin and steering pivot';
    this.tailWheel.position.set(0, .20, -4.67);
    this.tailWheel.add(tail); this.root.add(this.tailWheel);
  }

  private buildWheel(radius: number, width: number, name: string): THREE.Group {
    const m = this.materials, root = new THREE.Group(), batch = new StaticBatch();
    root.name = `${name} axle pivot`;
    const tireTube = radius * .29, tireMajor = radius - tireTube;
    batch.add(`${name} torus rubber tire`, new THREE.TorusGeometry(tireMajor, tireTube, 14, 40).scale(1, 1, width / (tireTube * 2)).rotateY(Math.PI / 2), m.rubber);
    batch.add(`${name} silver cylindrical hub`, new THREE.CylinderGeometry(radius * .43, radius * .43, width * 1.04, 24).rotateZ(Math.PI / 2), m.metal);
    for (const side of [-1, 1]) {
      batch.add(`${name} dark hub cap`, new THREE.CylinderGeometry(radius * .22, radius * .22, .018, 20).rotateZ(Math.PI / 2).translate(side * (width * .53 + .004), 0, 0), m.darkMetal);
      batch.add(`${name} tire sidewall groove`, new THREE.TorusGeometry(radius * .70, .009, 4, 28).rotateY(Math.PI / 2).translate(side * width * .48, 0, 0), m.graphite);
      for (let j = 0; j < 6; j++) {
        const theta = j / 6 * TAU;
        batch.add(`${name} hub lug`, new THREE.CylinderGeometry(radius * .033, radius * .033, .022, 6).rotateZ(Math.PI / 2).translate(side * width * .55, Math.sin(theta) * radius * .31, Math.cos(theta) * radius * .31), m.darkMetal);
      }
    }
    batch.finish(root);
    return root;
  }

  private buildAgriculturalEquipment(batch: StaticBatch): void {
    const m = this.materials;
    for (const side of [-1, 1]) {
      batch.add('Horizontal aluminum spray boom', rod(new THREE.Vector3(side * .72, 1.43, -.54), new THREE.Vector3(side * 3.72, 1.43, -.54), .043, 10), m.metal);
      batch.add('Spray-boom wing support', rod(new THREE.Vector3(side * 2.85, 2.22, -.39), new THREE.Vector3(side * 2.85, 1.43, -.54), .026, 8), m.darkMetal);
      batch.add('Spray boom outer end cap', sphere(side * 3.73, 1.43, -.54, .048, .05, .05, 10), m.graphite);
      for (const x of [1.05, 1.78, 2.51, 3.24]) {
        batch.add('Crop-spray drop tube', rod(new THREE.Vector3(side * x, 1.43, -.54), new THREE.Vector3(side * x, 1.08, -.54), .026, 8), m.metal);
        batch.add('Rear-facing spray nozzle', rod(new THREE.Vector3(side * x, 1.09, -.54), new THREE.Vector3(side * x, 1.09, -.70), .039, 8), m.darkMetal);
        batch.add('Spray-nozzle orange valve', sphere(side * x, 1.40, -.54, .058, .047, .058, 10), m.primary);
      }
      batch.add('Hopper-to-boom feed line', curvedRod([[side * .37, 1.17, -.2], [side * .58, 1.04, -.35], [side * .79, 1.23, -.51], [side * .81, 1.42, -.54]], .032, 12), m.graphite);
    }
  }

  private buildPropeller(): void {
    const m = this.materials, batch = new StaticBatch();
    this.propellerPivot.name = 'Three-blade propeller +Z rotation pivot';
    this.propellerPivot.position.set(0, 2.42, 4.34);
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Shape();
      blade.moveTo(-.11, .27); blade.bezierCurveTo(-.19, .64, -.25, 1.21, -.145, 1.64); blade.quadraticCurveTo(-.115, 1.79, -.02, 1.806); blade.quadraticCurveTo(.089, 1.806, .124, 1.68); blade.bezierCurveTo(.205, 1.34, .196, .94, .10, .60); blade.lineTo(.105, .27); blade.closePath();
      batch.add('Curved tapered beveled graphite propeller blade', extrudedShape(blade, .035, .012).translate(0, 0, -.0175).rotateZ(i / 3 * TAU), m.propeller);
      const tip = new THREE.Shape();
      tip.moveTo(-.145, 1.626); tip.quadraticCurveTo(-.116, 1.78, -.02, 1.794); tip.quadraticCurveTo(.074, 1.794, .116, 1.663); tip.lineTo(.119, 1.60); tip.lineTo(-.145, 1.60); tip.closePath();
      batch.add('Yellow propeller safety tip front', new THREE.ShapeGeometry(tip, 12).translate(0, 0, .031).rotateZ(i / 3 * TAU), m.tipYellow);
      batch.add('Yellow propeller safety tip rear', new THREE.ShapeGeometry(tip, 12).rotateY(Math.PI).translate(0, 0, -.031).rotateZ(i / 3 * TAU), m.tipYellow);
    }
    // The tail reaches Z=-5.02; this spinner depth fixes the full aircraft length at 9.8.
    const spinnerDepthScale = .44 / .474;
    batch.add('Silver spinner hemisphere', new THREE.SphereGeometry(.47, 32, 20, 0, TAU, 0, Math.PI / 2).rotateX(Math.PI / 2).scale(1, 1, spinnerDepthScale), m.metal);
    batch.add('Dark upper spinner shell', new THREE.SphereGeometry(.474, 24, 12, 0, Math.PI, 0, Math.PI / 2).rotateX(Math.PI / 2).rotateZ(Math.PI).scale(1, 1, spinnerDepthScale), m.darkMetal);
    batch.add('Spinner hub aluminum base flange', new THREE.TorusGeometry(.454, .019, 6, 32), m.metal);
    batch.finish(this.propellerPivot); this.root.add(this.propellerPivot);
  }

  update(dt: number, state: FlightState, controls: Controls): void {
    if (this.disposed) return;
    const response = 1 - Math.exp(-8 * dt), rpm01 = clamp(state.rpm > 1 ? state.rpm / 2500 : state.rpm, 0, 1);
    this.propellerPivot.rotation.z = (this.propellerPivot.rotation.z + dt * rpm01 * 165) % TAU;
    this.materials.blur.opacity = rpm01 > .08 ? Math.min(.16, (rpm01 - .08) * .175) : 0;
    this.blurMesh.visible = rpm01 > .08;
    this.blurMesh.scale.setScalar(.96 + rpm01 * .05);
    if (state.grounded) { this.mainSpin = state.speed / .52; this.tailSpin = state.speed / .20; }
    else { this.mainSpin *= Math.exp(-dt / 2.4); this.tailSpin *= Math.exp(-dt / 1.8); }
    for (const wheel of this.mainWheels) wheel.rotation.x = (wheel.rotation.x + this.mainSpin * dt) % TAU;
    const tail = this.tailWheel.children[0];
    if (tail) tail.rotation.x = (tail.rotation.x + this.tailSpin * dt) % TAU;
    this.tailWheel.rotation.y += (-controls.rudder * .18 - this.tailWheel.rotation.y) * response;
    this.ailerons[0]!.rotation.x += (controls.roll * .24 - this.ailerons[0]!.rotation.x) * response;
    this.ailerons[1]!.rotation.x += (-controls.roll * .24 - this.ailerons[1]!.rotation.x) * response;
    this.elevator.rotation.x += (controls.pitch * .20 - this.elevator.rotation.x) * response;
    this.rudder.rotation.y += (-controls.rudder * .14 - this.rudder.rotation.y) * response;
    const gazeX = clamp(-state.bank * .14, -.055, .055), gazeY = clamp(state.pitch * .08, -.035, .035);
    for (const gaze of this.eyeGazes) {
      gaze.position.x += (gazeX - gaze.position.x) * response;
      gaze.position.y += (gazeY - gaze.position.y) * response;
      gaze.position.z = -gaze.position.y * .31;
    }
  }

  get diagnostics() {
    return {
      ...AIRCRAFT_DIMENSIONS,
      ...this.modelMetrics,
      source: 'Fully procedural Three.js geometry; authored ring and superellipse lofts',
      paintColor: this.materials.paintColor,
      paint: { primary: `#${this.materials.primary.color.getHexString()}`, highlight: `#${this.materials.highlight.color.getHexString()}`, sheen: `#${this.materials.sheen.color.getHexString()}` },
      collisionProxy: { mainWheels: [[-1.76, .52, .72], [1.76, .52, .72]], tailWheel: [0, .20, -4.67], propellerHub: [0, 2.42, 4.34], propellerSafetyRadius: 1.86 },
      animatedParts: 10,
      textures: 0,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    this.root.traverse(object => { if (object instanceof THREE.Mesh) geometries.add(object.geometry); });
    for (const geometry of geometries) geometry.dispose();
    if (this.ownsMaterials) this.materials.dispose();
    this.root.clear();
  }
}

