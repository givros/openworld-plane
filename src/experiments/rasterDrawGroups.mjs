import { Matrix4 } from 'three';

/** Stable full native shader/draw signatures, shared by the browser probe and native export. */
export function buildRasterDrawGroups(batches, geometries, materials, placements) {
  const keys = new Map(), groups = [], instanceGroup = new Uint32Array(placements), matrix = new Matrix4();
  for (const batch of batches) {
    const geometry = geometries[batch.geometryId], attributes = geometry.attributes ?? geometry, material = materials[batch.materialId];
    const settings = { materialId: batch.materialId, instanced: batch.isInstancedMesh, instanceColors: !!batch.instanceColor,
      vertexColorSize: material.vertexColors ? attributes.color?.itemSize ?? 0 : 0, tangents: !!attributes.tangent,
      mirroredBatch: matrix.fromArray(batch.modelMatrix).determinant() < 0,
      receiveShadow: batch.receiveShadow, renderOrder: batch.renderOrder, layersMask: batch.layers };
    const key = JSON.stringify(settings); let index = keys.get(key);
    if (index === undefined) { index = groups.length; keys.set(key, index); groups.push(settings); }
    instanceGroup.fill(index, batch.sourceStart, batch.sourceStart + batch.count);
  }
  return { groups, instanceGroup };
}
