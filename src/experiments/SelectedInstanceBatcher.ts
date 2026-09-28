import * as THREE from 'three';

interface MemberSnapshot {
  source: THREE.InstancedMesh;
  matrix: THREE.InstancedBufferAttribute;
  matrixVersion: number;
  color: THREE.InstancedBufferAttribute | null;
  colorVersion: number;
  count: number;
  offset: number;
  matrixView?: Float32Array;
  colorView?: Float32Array;
}
interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
  members: THREE.InstancedMesh[];
  previous: MemberSnapshot[];
  count: number;
  generation: number;
}
interface SourceKey {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  renderOrder: number;
  castShadow: boolean;
  receiveShadow: boolean;
  layerMask: number;
  depth: THREE.Material | undefined;
  distance: THREE.Material | undefined;
  colored: boolean;
  matrix: Float64Array;
  group?: Batch;
  ownedRevision?: number;
}
interface Eligibility { generation: number; compatible: boolean; }
function createMemberSnapshot(source: THREE.InstancedMesh): MemberSnapshot {
  return { source, matrix: source.instanceMatrix, matrixVersion: -1, color: source.instanceColor,
    colorVersion: -1, count: -1, offset: -1, matrixView: undefined, colorView: undefined };
}
function createSourceKey(source: THREE.InstancedMesh): SourceKey {
  return { key: '', geometry: source.geometry, material: source.material as THREE.Material,
    renderOrder: source.renderOrder, castShadow: source.castShadow, receiveShadow: source.receiveShadow,
    layerMask: source.layers.mask, depth: source.customDepthMaterial, distance: source.customDistanceMaterial,
    colored: !!source.instanceColor, matrix: new Float64Array(16), group: undefined, ownedRevision: undefined };
}
export interface SelectedInstanceBatcherOptions {
  /** Explicit adapter ownership contract: revision covers callbacks, resources,
   * presentation/world transform and instance-buffer layout. Count and attribute
   * content versions may change without revision. Undefined revokes the lease.
   */
  getSourceRevision?: (source: THREE.InstancedMesh) => number | undefined;
}

/** Experimental post-selection adapter. Its inputs must already be selected for
 * one render pass; canonical scene objects and their instance arrays stay intact.
 * Call prepare before GPU prewarming, with every source/LOD variant that may be
 * selected. Each camera/shadow pass needs its own adapter and owned buffers.
 */
export class SelectedInstanceBatcher {
  private readonly groups = new Map<string, Batch>();
  private readonly selected: THREE.Mesh[] = [];
  private readonly touched: Batch[] = [];
  private sourceKeys = new WeakMap<THREE.InstancedMesh, SourceKey>();
  private geometryEligibility = new WeakMap<THREE.BufferGeometry, Eligibility>();
  private materialEligibility = new WeakMap<THREE.Material, Eligibility>();
  private readonly previousSources: THREE.Mesh[] = [];
  private readonly previousGroups: (Batch | undefined)[] = [];
  private readonly resolvedGroups: (Batch | undefined)[] = [];
  private layoutValid = false;
  private generation = 0;
  readonly statistics = { inputDraws: 0, outputDraws: 0, copiedInstances: 0, copiedBytes: 0, reusedBatches: 0, bufferGrowths: 0,
    reusedKeys: 0, rebuiltKeys: 0, geometryValidations: 0, materialValidations: 0, reusedLayouts: 0, reusedOwnedKeys: 0 };

  constructor(private readonly options: SelectedInstanceBatcherOptions = {}) {}

  private compatibleGeometry(geometry: THREE.BufferGeometry): boolean {
    let entry = this.geometryEligibility.get(geometry);
    if (entry?.generation === this.generation) return entry.compatible;
    if (!entry) { entry = { generation: -1, compatible: false }; this.geometryEligibility.set(geometry, entry); }
    entry.generation = this.generation;
    entry.compatible = false;
    this.statistics.geometryValidations++;
    // A select/prepare operation is synchronous and never mutates shared geometry.
    // Check live membership once per operation, including newly added attributes.
    for (const name in geometry.morphAttributes) {
      if (Object.prototype.hasOwnProperty.call(geometry.morphAttributes, name)) return false;
    }
    for (const name in geometry.attributes) {
      if (!Object.prototype.hasOwnProperty.call(geometry.attributes, name)) continue;
      const attribute = geometry.attributes[name];
      if ('isInstancedBufferAttribute' in attribute && attribute.isInstancedBufferAttribute ||
        'isInterleavedBufferAttribute' in attribute && 'isInstancedInterleavedBuffer' in attribute.data) return false;
    }
    entry.compatible = true;
    return true;
  }

  private compatibleMaterial(material: THREE.Material): boolean {
    let entry = this.materialEligibility.get(material);
    if (entry?.generation === this.generation) return entry.compatible;
    if (!entry) { entry = { generation: -1, compatible: false }; this.materialEligibility.set(material, entry); }
    entry.generation = this.generation;
    this.statistics.materialValidations++;
    entry.compatible = !material.transparent && material.visible && material.blending === THREE.NormalBlending &&
      !(material instanceof THREE.ShaderMaterial) && material.onBeforeRender === THREE.Material.prototype.onBeforeRender;
    return entry.compatible;
  }

  private key(source: THREE.Mesh): SourceKey | undefined {
    if (!(source instanceof THREE.InstancedMesh)) return undefined;
    const previous = this.sourceKeys.get(source), ownedRevision = this.options.getSourceRevision?.(source);
    if (ownedRevision !== undefined && previous?.ownedRevision === ownedRevision && previous.geometry === source.geometry) {
      if (source.count < 0 || !Number.isInteger(source.count) || source.count > source.instanceMatrix.count ||
        source.instanceColor && source.count > source.instanceColor.count) return undefined;
      this.statistics.reusedKeys++; this.statistics.reusedOwnedKeys++;
      return previous;
    }
    if (previous) previous.ownedRevision = undefined;
    if (Array.isArray(source.material) || !source.visible ||
      !this.compatibleMaterial(source.material) ||
      source.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || source.onAfterRender !== THREE.Object3D.prototype.onAfterRender ||
      source.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow || source.onAfterShadow !== THREE.Object3D.prototype.onAfterShadow ||
      source.morphTexture || !this.compatibleGeometry(source.geometry) ||
      !(source.instanceMatrix.array instanceof Float32Array) || source.instanceMatrix.itemSize !== 16 ||
      source.instanceMatrix.normalized || source.instanceMatrix.meshPerAttribute !== 1 ||
      source.count < 0 || source.count > source.instanceMatrix.count || !Number.isInteger(source.count)) return undefined;
    const color = source.instanceColor;
    if (color && (!(color.array instanceof Float32Array) || color.itemSize !== 3 || color.normalized ||
      color.meshPerAttribute !== 1 || color.count < source.count)) return undefined;
    const matrix = source.matrixWorld.elements;
    let changed = !previous || previous.geometry !== source.geometry || previous.material !== source.material ||
      previous.renderOrder !== source.renderOrder || previous.castShadow !== source.castShadow || previous.receiveShadow !== source.receiveShadow ||
      previous.layerMask !== source.layers.mask || previous.depth !== source.customDepthMaterial ||
      previous.distance !== source.customDistanceMaterial || previous.colored !== !!color;
    for (let i = 0; i < 16; i++) {
      const value = matrix[i];
      if (!Number.isFinite(value)) return undefined;
      if (previous && previous.matrix[i] !== value) changed = true;
    }
    if (previous && !changed) { previous.ownedRevision = ownedRevision; this.statistics.reusedKeys++; return previous; }
    this.statistics.rebuiltKeys++;
    const key = `${source.geometry.id}/${source.material.uuid}/${source.renderOrder}/${source.castShadow}/${source.receiveShadow}/${source.layers.mask}/${source.customDepthMaterial?.uuid ?? '-'}/${source.customDistanceMaterial?.uuid ?? '-'}/${color ? 1 : 0}/${matrix.join(',')}`;
    const state = previous ?? createSourceKey(source);
    state.key = key; state.geometry = source.geometry; state.material = source.material;
    state.renderOrder = source.renderOrder; state.castShadow = source.castShadow; state.receiveShadow = source.receiveShadow;
    state.layerMask = source.layers.mask; state.depth = source.customDepthMaterial; state.distance = source.customDistanceMaterial;
    state.colored = !!color; state.matrix.set(matrix); state.group = undefined; state.ownedRevision = ownedRevision;
    if (!previous) this.sourceKeys.set(source, state);
    return state;
  }

  private makeMesh(source: THREE.InstancedMesh, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity);
    mesh.name = 'selected-instance-batch';
    mesh.count = 0;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.matrix.copy(source.matrixWorld);
    mesh.matrixWorld.copy(source.matrixWorld);
    mesh.frustumCulled = false;
    mesh.castShadow = source.castShadow;
    mesh.receiveShadow = source.receiveShadow;
    mesh.renderOrder = source.renderOrder;
    mesh.layers.mask = source.layers.mask;
    mesh.customDepthMaterial = source.customDepthMaterial;
    mesh.customDistanceMaterial = source.customDistanceMaterial;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (source.instanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  private group(key: string, source: THREE.InstancedMesh): Batch {
    let group = this.groups.get(key);
    if (!group) {
      group = { mesh: this.makeMesh(source, 0), capacity: 0, members: [], previous: [], count: 0, generation: -1 };
      this.groups.set(key, group);
    }
    return group;
  }

  private reserve(group: Batch, source: THREE.InstancedMesh, count: number): void {
    if (count <= group.capacity) return;
    const capacity = Math.max(count, Math.max(1, group.capacity * 2));
    const previous = group.mesh;
    group.mesh = this.makeMesh(source, capacity);
    group.capacity = capacity;
    group.previous.length = 0;
    previous.dispose(); // InstancedMesh disposal releases instance buffers, not shared geometry/material.
    this.statistics.bufferGrowths++;
  }

  /** Reserves worst-case selected instance storage without modifying source data. */
  prepare(sources: readonly THREE.Mesh[]): void {
    this.layoutValid = false;
    const generation = ++this.generation;
    this.touched.length = 0;
    for (const source of sources) {
      const key = this.key(source);
      if (key === undefined) continue;
      const mesh = source as THREE.InstancedMesh, group = key.group ?? (key.group = this.group(key.key, mesh));
      if (group.generation !== generation) {
        group.generation = generation; group.count = 0; this.touched.push(group);
      }
      group.count += mesh.instanceMatrix.count;
    }
    for (const group of this.touched) this.reserve(group, group.mesh, group.count);
  }

  preparationMeshes(): THREE.InstancedMesh[] { return Array.from(this.groups.values(), group => group.mesh); }

  /** Returns a reused array in first-occurrence group order. Unsupported meshes
   * pass through unchanged. Changed groups cost O(selected matrix/color floats).
   * Source callers must mark modified attributes needsUpdate, as Three requires.
   */
  select(sources: readonly THREE.Mesh[]): readonly THREE.Mesh[] {
    const generation = ++this.generation, stats = this.statistics;
    stats.inputDraws = sources.length; stats.outputDraws = 0;
    stats.copiedInstances = 0; stats.copiedBytes = 0; stats.reusedBatches = 0;
    stats.reusedKeys = 0; stats.rebuiltKeys = 0; stats.geometryValidations = 0; stats.materialValidations = 0;
    stats.reusedLayouts = 0; stats.reusedOwnedKeys = 0;
    let sameLayout = this.layoutValid && this.previousSources.length === sources.length;
    this.resolvedGroups.length = sources.length;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const key = this.key(source);
      const group = key === undefined ? undefined : key.group ?? (key.group = this.group(key.key, source as THREE.InstancedMesh));
      this.resolvedGroups[i] = group;
      if (this.previousSources[i] !== source || this.previousGroups[i] !== group) sameLayout = false;
    }
    if (sameLayout) stats.reusedLayouts++;
    else {
      this.selected.length = 0; this.touched.length = 0;
      this.previousSources.length = sources.length; this.previousGroups.length = sources.length;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i], group = this.resolvedGroups[i];
        this.previousSources[i] = source; this.previousGroups[i] = group;
        if (group === undefined) { this.selected.push(source); continue; }
        if (group.generation !== generation) {
          group.generation = generation; group.members.length = 0;
          this.touched.push(group);
          // Filled after reserve, which can replace a group mesh.
          this.selected.push(group.mesh);
        }
        group.members.push(source as THREE.InstancedMesh);
      }
      this.layoutValid = true;
    }
    for (const group of this.touched) {
      group.count = 0;
      for (const source of group.members) group.count += source.count;
      const old = group.mesh;
      this.reserve(group, group.members[0], group.count);
      if (old !== group.mesh) this.selected[this.selected.indexOf(old)] = group.mesh;
      group.mesh.count = group.count;
      let offset = 0, firstMatrix = Infinity, lastMatrix = 0, firstColor = Infinity, lastColor = 0;
      for (let i = 0; i < group.members.length; i++) {
        const source = group.members[i], count = source.count;
        const previous = group.previous[i] ?? (group.previous[i] = createMemberSnapshot(source));
        const moved = previous.source !== source || previous.count !== count || previous.offset !== offset;
        const matrixChanged = moved || previous.matrix !== source.instanceMatrix || previous.matrixVersion !== source.instanceMatrix.version;
        const colorChanged = moved || previous.color !== source.instanceColor || previous.colorVersion !== (source.instanceColor?.version ?? -1);
        if (!matrixChanged && !colorChanged) { offset += count; continue; }
        if (matrixChanged) {
          const array = source.instanceMatrix.array as Float32Array;
          let view = previous.matrixView;
          if (!view || view.buffer !== array.buffer || view.byteOffset !== array.byteOffset || view.length !== count * 16)
            view = previous.matrixView = array.subarray(0, count * 16);
          group.mesh.instanceMatrix.array.set(view, offset * 16);
          firstMatrix = Math.min(firstMatrix, offset * 16); lastMatrix = (offset + count) * 16;
          stats.copiedBytes += count * 64;
        }
        if (colorChanged && group.mesh.instanceColor && source.instanceColor) {
          const array = source.instanceColor.array as Float32Array;
          let view = previous.colorView;
          if (!view || view.buffer !== array.buffer || view.byteOffset !== array.byteOffset || view.length !== count * 3)
            view = previous.colorView = array.subarray(0, count * 3);
          group.mesh.instanceColor.array.set(view, offset * 3);
          firstColor = Math.min(firstColor, offset * 3); lastColor = (offset + count) * 3;
          stats.copiedBytes += count * 12;
        }
        if (matrixChanged || colorChanged && source.instanceColor) stats.copiedInstances += count;
        previous.source = source; previous.count = count; previous.matrix = source.instanceMatrix;
        previous.matrixVersion = source.instanceMatrix.version; previous.color = source.instanceColor;
        previous.colorVersion = source.instanceColor?.version ?? -1; previous.offset = offset;
        offset += count;
      }
      group.previous.length = group.members.length;
      if (firstMatrix !== Infinity) {
        for (const range of group.mesh.instanceMatrix.updateRanges) {
          firstMatrix = Math.min(firstMatrix, range.start); lastMatrix = Math.max(lastMatrix, range.start + range.count);
        }
        group.mesh.instanceMatrix.clearUpdateRanges();
        group.mesh.instanceMatrix.addUpdateRange(firstMatrix, lastMatrix - firstMatrix);
        group.mesh.instanceMatrix.needsUpdate = true;
      }
      if (firstColor !== Infinity && group.mesh.instanceColor) {
        for (const range of group.mesh.instanceColor.updateRanges) {
          firstColor = Math.min(firstColor, range.start); lastColor = Math.max(lastColor, range.start + range.count);
        }
        group.mesh.instanceColor.clearUpdateRanges();
        group.mesh.instanceColor.addUpdateRange(firstColor, lastColor - firstColor);
        group.mesh.instanceColor.needsUpdate = true;
      }
      if (firstMatrix === Infinity && firstColor === Infinity) stats.reusedBatches++;
    }
    stats.outputDraws = this.selected.length;
    return this.selected;
  }

  dispose(): void {
    for (const group of this.groups.values()) group.mesh.dispose();
    this.groups.clear(); this.selected.length = 0; this.touched.length = 0;
    this.previousSources.length = 0; this.previousGroups.length = 0; this.resolvedGroups.length = 0; this.layoutValid = false;
    this.sourceKeys = new WeakMap(); this.geometryEligibility = new WeakMap(); this.materialEligibility = new WeakMap();
  }
}
