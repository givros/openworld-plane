import type { Box3, BufferGeometry, Sphere } from 'three';

interface StreamBoundsSnapshot {
  attribute: ReturnType<BufferGeometry['getAttribute']>;
  array: ArrayLike<number>;
  version: number;
  box: Box3;
  sphere: Sphere;
}

// Only the exact-resource loader registers these snapshots. Arbitrary userData
// or public geometry bounds must never opt a mutable geometry into this path.
const snapshots = new WeakMap<BufferGeometry, StreamBoundsSnapshot>();

/** Record bounds computed from the original Float32 positions by the packer. */
export function registerStreamGeometryBounds(geometry: BufferGeometry): void {
  const attribute = geometry.getAttribute('position');
  if (!attribute || !geometry.boundingBox || !geometry.boundingSphere) throw new Error('Exact stream geometry bounds are missing');
  const buffer = 'data' in attribute ? attribute.data : attribute;
  snapshots.set(geometry, {
    attribute, array: buffer.array, version: buffer.version,
    box: geometry.boundingBox.clone(), sphere: geometry.boundingSphere.clone(),
  });
}

/** Copy only while the original position stream remains unchanged. */
export function copyStreamGeometryBounds(geometry: BufferGeometry, box: Box3, sphere: Sphere): boolean {
  const snapshot = snapshots.get(geometry);
  if (!snapshot) return false;
  const attribute = geometry.getAttribute('position');
  if (!attribute || attribute !== snapshot.attribute) return false;
  const buffer = 'data' in attribute ? attribute.data : attribute;
  if (buffer.array !== snapshot.array || buffer.version !== snapshot.version) return false;
  box.copy(snapshot.box); sphere.copy(snapshot.sphere);
  return true;
}
