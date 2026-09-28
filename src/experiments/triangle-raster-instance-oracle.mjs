import * as THREE from 'three';
import { VisibleTriangleRasterAdapter } from './VisibleTriangleRasterAdapter.ts';

/** Diagnostic only: distinguish nearest-triangle coverage from the unchanged vertex-pulling shader. */
export async function createCompleteInstanceOracle(probe) {
  if (!probe.canonicalWorld) throw new Error('Load the independent canonical GLBs first');
  const response = await fetch(`${probe.pairURL}/blocks-1-pairs.bin`);
  if (!response.ok) throw new Error('Missing native visible triangle list');
  const pairs = new Uint32Array(await response.arrayBuffer());
  const touched = new Uint8Array(probe.dataset.input.instances.length);
  for (let p = 0; p < pairs.length; p += 2) touched[pairs[p]] = 1;
  const sources = new Map(), states = [], groups = new Map(), adapters = [], matched = new Set();
  probe.canonicalWorld.root.traverse(object => {
    if (!object.isMesh) return;
    if (!sources.has(object.name)) sources.set(object.name, []);
    sources.get(object.name).push(object);
  });
  let triangles = 0, placements = 0, maximumTriangles = 0;
  for (const batch of probe.dataset.batches) {
    const expectedGeometry = probe.dataset.input.geometries[batch.geometryId];
    const candidates = (sources.get(batch.name) ?? []).filter(object => {
      if (matched.has(object) || !!object.isInstancedMesh !== batch.isInstancedMesh) return false;
      if (object.material.name !== probe.dataset.materials[batch.materialId].name) return false;
      if (object.geometry.attributes.position.count !== expectedGeometry.vertexCount || (object.geometry.index?.count ?? object.geometry.attributes.position.count) !== expectedGeometry.triangleCount * 3) return false;
      if (object.matrixWorld.elements.some((x, i) => x !== batch.modelMatrix[i])) return false;
      if (object.isInstancedMesh) {
        if (object.count !== batch.count) return false;
        for (const slot of [0, Math.floor(batch.count / 2), batch.count - 1]) {
          const expected = probe.dataset.input.instances[batch.sourceStart + slot].matrix, original = batch.originalInstanceSlots[slot];
          if (expected.some((x, component) => x !== object.instanceMatrix.array[original * 16 + component])) return false;
        }
      }
      const position = object.geometry.attributes.position.array;
      const offset = expectedGeometry.vertexOffset * 3;
      for (const index of [0, Math.floor(position.length / 2), position.length - 1]) if (position[index] !== probe.dataset.input.positions[offset + index]) return false;
      return true;
    });
    if (candidates.length !== 1) throw new Error(`Canonical batch matching found ${candidates.length} candidates: ${batch.name}`);
    const source = candidates[0]; matched.add(source);
    const ids = [];
    for (let slot = 0; slot < batch.count; slot++) if (touched[batch.sourceStart + slot]) ids.push(batch.sourceStart + slot);
    const state = { source, visible: source.visible, count: source.count, matrix: source.instanceMatrix, color: source.instanceColor, selectedCount: ids.length };
    if (source.isInstancedMesh && ids.length) {
      const matrix = new Float32Array(ids.length * 16), color = source.instanceColor ? new Float32Array(ids.length * 3) : null;
      ids.forEach((id, index) => {
        const originalSlot = batch.originalInstanceSlots[id - batch.sourceStart];
        matrix.set(source.instanceMatrix.array.subarray(originalSlot * 16, originalSlot * 16 + 16), index * 16);
        if (color) color.set(source.instanceColor.array.subarray(originalSlot * 3, originalSlot * 3 + 3), index * 3);
        const expected = probe.dataset.input.instances[id].matrix;
        if (expected.some((x, component) => x !== matrix[index * 16 + component])) throw new Error(`Canonical instance transform mismatch: ${batch.name}/${originalSlot}`);
      });
      state.selectedMatrix = new THREE.InstancedBufferAttribute(matrix, 16);
      state.selectedColor = color ? new THREE.InstancedBufferAttribute(color, 3) : null;
    }
    states.push(state);
    for (const id of ids) {
      const instance = probe.dataset.input.instances[id], geometry = probe.dataset.input.geometries[instance.geometry];
      const signature = probe.instanceGroup[id], key = `${signature}:${instance.geometry}`;
      if (!groups.has(key)) groups.set(key, { signature, geometry, ids: [] });
      groups.get(key).ids.push(id);
      placements++; triangles += geometry.triangleCount; maximumTriangles = Math.max(maximumTriangles, geometry.triangleCount);
    }
  }
  // The adapter pulls every position by gl_VertexID. This shared, unmodified dummy attribute
  // supplies Three's draw-range capacity; it is optimized out by the compiled vertex shader.
  const dummyPositions = new THREE.BufferAttribute(new Float32Array(maximumTriangles * 9), 3);
  for (const { signature, geometry, ids } of groups.values()) {
    const settings = probe.groups[signature];
    const adapter = new VisibleTriangleRasterAdapter(probe.atlas, probe.dataset.materials[settings.materialId], {
      ...settings, capacity: ids.length, trianglesPerReference: 1, customHooksCompatible: true,
      configureClone: clone => { probe.atmosphere.sunlight.setupMaterial(clone); return () => probe.atmosphere.sunlight.shaders.delete(clone); },
    });
    const references = new Uint32Array(ids.length * 2);
    ids.forEach((id, index) => references.set([id, geometry.triangleOffset], index * 2));
    adapter.setVisibleReferences(references);
    adapter.mesh.geometry.setAttribute('position', dummyPositions);
    adapter.mesh.geometry.setDrawRange(0, geometry.triangleCount * 3);
    adapter.mesh.visible = false; probe.scene.add(adapter.mesh); adapters.push(adapter);
  }
  let mode = 'canonical';
  const restoreCanonical = () => {
    for (const state of states) {
      state.source.visible = state.visible;
      if (state.source.isInstancedMesh) { state.source.count = state.count; state.source.instanceMatrix = state.matrix; state.source.instanceColor = state.color; }
    }
  };
  return {
    inventory: { touchedPlacements: placements, completeTriangles: triangles, originalBatches: states.length, pulledGeometryGroups: adapters.length,
      dummyAttributeBytes: dummyPositions.array.byteLength, scope: 'Every original triangle of every placement touched by at least one corrected native MSAA ray; no geometry simplification.' },
    setMode(next) {
      if (!['canonical', 'native-instances', 'pulled-instances', 'selected'].includes(next)) throw new Error('Unknown diagnostic mode');
      restoreCanonical();
      probe.setMode(next === 'selected' ? 'selected' : 'canonical');
      if (next === 'native-instances') for (const state of states) {
        state.source.visible = state.visible && state.selectedCount > 0;
        if (state.source.isInstancedMesh && state.selectedCount) {
          state.source.count = state.selectedCount; state.source.instanceMatrix = state.selectedMatrix; state.source.instanceColor = state.selectedColor;
        }
      }
      if (next === 'pulled-instances') probe.canonicalWorld.root.visible = false;
      for (const adapter of adapters) adapter.mesh.visible = next === 'pulled-instances';
      mode = next;
    },
    get mode() { return mode; },
    dispose() {
      restoreCanonical();
      for (const adapter of adapters) adapter.dispose();
      // Restore original attribute identities before dropping CPU scratch. Detached instance
      // buffers are released with the renderer/context at the end of this bounded diagnostic.
      for (const state of states) for (const attribute of [state.selectedMatrix, state.selectedColor]) {
        if (attribute) attribute.array = new Float32Array(0);
      }
      states.length = 0; adapters.length = 0; groups.clear(); sources.clear();
    },
  };
}
