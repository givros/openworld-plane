import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AirplaneModel } from '../src/assets/AirplaneModel.ts';
import { MaterialLibrary, PAINT_STORAGE_KEY } from '../src/assets/MaterialLibrary.ts';

function partGeometry(model, name) {
  let result;
  model.root.traverse(object => {
    if (!object.isMesh || result) return;
    const part = object.userData.partRanges?.find(part => part.name === name);
    if (!part) return;
    const geometry = new THREE.BufferGeometry();
    for (const attribute of ['position', 'normal']) {
      const values = object.geometry.getAttribute(attribute).array.slice(part.start * 3, (part.start + part.count) * 3);
      geometry.setAttribute(attribute, new THREE.BufferAttribute(values, 3));
    }
    result = geometry;
  });
  assert.ok(result, `Missing semantic aircraft part: ${name}`);
  return result;
}

function assertSurfaceFit(marking, surface, axis, side, minimum, maximum) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(surface, material), ray = new THREE.Raycaster(), p = marking.getAttribute('position');
  mesh.updateMatrixWorld(true);
  const center = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), direction = new THREE.Vector3();
  if (axis !== 'normal') direction[axis] = -side;
  let samples = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (Math.abs(center.x) < .12 && axis === 'x') continue;
    const actual = center[axis];
    if (axis === 'normal') {
      const n = marking.getAttribute('normal');
      direction.fromBufferAttribute(n, i).add(a.fromBufferAttribute(n, i + 1)).add(b.fromBufferAttribute(n, i + 2)).normalize().negate();
      center.addScaledVector(direction, -1);
    } else center[axis] = side * 8;
    ray.set(center, direction);
    const hit = ray.intersectObject(mesh, false)[0];
    assert.ok(hit, `No source hull beneath decal sample ${i / 3}`);
    const gap = axis === 'normal' ? hit.distance - 1 : (actual - hit.point[axis]) * side;
    assert.ok(gap >= minimum && gap <= maximum, `Decal sample ${i / 3} has surface gap ${gap}, expected ${minimum}..${maximum}`);
    samples++;
  }
  assert.ok(samples > 10); material.dispose();
}

test('authored aircraft geometry fits its footprint and all three parked wheels touch the runway', () => {
  const model = new AirplaneModel();
  try {
    assert.ok(model.diagnostics.triangles < 40000);
    assert.ok(model.diagnostics.meshes <= 45);
    assert.ok(Math.abs(model.diagnostics.bounds[0] - 11.76) < 1e-5);
    assert.ok(Math.abs(model.diagnostics.bounds[2] - 9.8) < 1e-5);
    assert.equal(model.diagnostics.textures, 0);
    const wheels = [];
    model.root.traverse(object => { if (object.name === 'Main wheel axle pivot' || object.name === 'Tail wheel spin and steering pivot') wheels.push(object); });
    assert.equal(wheels.length, 3);
    for (const wheel of wheels) assert.ok(Math.abs(new THREE.Box3().setFromObject(wheel).min.y) < 1e-6, `${wheel.name} must touch Y=0`);
    assert.ok(Math.abs(model.diagnostics.propellerHub[1] - model.diagnostics.propellerSafetyRadius - .56) < 1e-10);
    model.root.traverse(object => { if (object.isMesh) for (const v of object.geometry.getAttribute('position').array) assert.ok(Number.isFinite(v)); });
  } finally { model.dispose(); model.dispose(); }
});

test('fuselage stripe and nose panel decals stay outside the exact rendered hull at triangle centers', () => {
  const model = new AirplaneModel();
  const upper = partGeometry(model, 'Rounded elliptical upper fuselage — 28 angular segments');
  const lower = partGeometry(model, 'Warm-white elliptical lower fuselage');
  try {
    for (const name of ['Flush upper black fuselage pinstripe', 'Flush lower black fuselage pinstripe']) {
      const marking = partGeometry(model, name);
      try { assertSurfaceFit(marking, upper, 'x', -1, .001, .018); } finally { marking.dispose(); }
    }
    const seam = partGeometry(model, 'Fuselage nose panel seam');
    const hull = mergeGeometries([upper, lower], false);
    try { assertSurfaceFit(seam, hull, 'normal', -1, .004, .009); } finally { seam.dispose(); hull.dispose(); }
  } finally { upper.dispose(); lower.dispose(); model.dispose(); }
});

test('front windshield and eye band conform to the continuous cabin loft', () => {
  const model = new AirplaneModel(), cabin = partGeometry(model, 'Continuous rounded-square superellipse cockpit loft');
  try {
    for (const name of ['Smoky curved front windshield surround', 'Curved warm-white expressive eye band']) {
      const marking = partGeometry(model, name);
      try { assertSurfaceFit(marking, cabin, 'z', 1, .005, .012); } finally { marking.dispose(); }
    }
  } finally { cabin.dispose(); model.dispose(); }
});

test('paint mutates shared paint roles, preserves other materials and persists the selected color', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  let materials, restored;
  try {
    materials = new MaterialLibrary();
    const primary = materials.primary, white = materials.warmWhite.color.getHexString(), black = materials.graphite.color.getHexString(), eyes = materials.iris.color.getHexString();
    materials.setPaintColor('#3479a8');
    assert.equal(materials.primary, primary); assert.equal(materials.paintColor, '#3479a8');
    assert.equal(saved.get(PAINT_STORAGE_KEY), '#3479a8');
    assert.equal(materials.warmWhite.color.getHexString(), white); assert.equal(materials.graphite.color.getHexString(), black); assert.equal(materials.iris.color.getHexString(), eyes);
    assert.ok(materials.highlight.color.equals(primary.color.clone().lerp(new THREE.Color('#ffffff'), .18)));
    assert.ok(materials.sheen.color.equals(primary.color.clone().lerp(new THREE.Color('#ffffff'), .40)));
    restored = new MaterialLibrary(); assert.equal(restored.paintColor, '#3479a8');
    materials.setPaintColor('#ed870c'); assert.equal(materials.highlight.color.getHexString(), 'ff9f1c'); assert.equal(materials.sheen.color.getHexString(), 'ffc05f');
    materials.setPaintColor('invalid'); assert.equal(materials.paintColor, '#ed870c');
  } finally {
    materials?.dispose(); materials?.dispose(); restored?.dispose();
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage;
  }
});
