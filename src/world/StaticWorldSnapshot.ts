import * as THREE from 'three';

export type StaticWorldChange = 'source' | 'membership' | 'geometry' | 'instances' | 'transforms' | 'materials' | 'visibility';
export interface StaticWorldSnapshotOptions {
  /** Source-byte/registry hash supplied by the owner after a successful load. */
  sourceIdentity: string;
  /** Required if a renderer virtualizes the canonical layer mask. */
  logicalLayers?: (source: THREE.Mesh) => number;
}
export interface StaticWorldFrame {
  /** Borrowed read-only values; overwritten by the next prepare. */
  readonly receiverBounds: THREE.Box3;
  readonly staticReceiverBounds: THREE.Box3;
  readonly staticSources: readonly THREE.Mesh[];
  readonly staticRevision: number;
  readonly sunlightRevision: number;
  readonly sourceIdentity: string;
  readonly cacheKey: string;
  readonly staticReceivers: number;
  readonly dynamicReceivers: number;
  readonly processedStaticSources: number;
  readonly rebuiltMembership: boolean;
}
interface Entry { source: THREE.Mesh; bounds: THREE.Box3; active: boolean; signature: unknown[] }
interface GeometryEntry { box: THREE.Box3; signature: unknown[] }
const changes: readonly StaticWorldChange[] = ['source', 'membership', 'geometry', 'instances', 'transforms', 'materials', 'visibility'];

function equal(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}
function geometrySignature(geometry: THREE.BufferGeometry): unknown[] {
  const result: unknown[] = [geometry, geometry.drawRange.start, geometry.drawRange.count];
  const add = (name: string, attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): void => {
    const buffer = 'data' in attribute ? attribute.data : attribute;
    result.push(name, attribute, buffer, buffer.array, buffer.version, attribute.count, attribute.itemSize, attribute.normalized);
    if ('offset' in attribute) result.push(attribute.offset, attribute.data.stride);
  };
  if (geometry.index) add('index', geometry.index);
  for (const name of Object.keys(geometry.attributes).sort()) add(name, geometry.attributes[name]);
  for (const [name, attributes] of Object.entries(geometry.morphAttributes).sort(([a], [b]) => a.localeCompare(b))) for (const attribute of attributes ?? []) add(`morph:${name}`, attribute);
  for (const group of geometry.groups) result.push(group.start, group.count, group.materialIndex);
  return result;
}
/** Capture native material fields and texture revisions, without copying image data. */
function materialSignature(material: THREE.Material): unknown[] {
  const output: unknown[] = [], visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') { output.push(value); return; }
    output.push(value);
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof THREE.Texture) {
      output.push(value.version, value.source, value.source.version, value.image,
        value.wrapS, value.wrapT, value.magFilter, value.minFilter, value.anisotropy,
        value.channel, value.flipY, value.colorSpace, value.mapping, value.rotation,
        value.offset.x, value.offset.y, value.repeat.x, value.repeat.y, value.center.x, value.center.y,
        ...value.matrix.elements);
      return;
    }
    if (ArrayBuffer.isView(value)) return; // Native buffer edits require their declared version/owner invalidation.
    for (const key of Object.keys(value).sort()) {
      if (key === '_listeners') continue;
      output.push(key); visit((value as Record<string, unknown>)[key]);
    }
  };
  visit(material); output.push(material.onBeforeRender, material.onBeforeCompile, material.customProgramCacheKey);
  return output;
}
function materials(source: THREE.Mesh): THREE.Material[] {
  return [...(Array.isArray(source.material) ? source.material : [source.material]), source.customDepthMaterial, source.customDistanceMaterial]
    .filter((item): item is THREE.Material => item !== undefined);
}
function displacement(source: THREE.Mesh): number {
  let padding = 0;
  for (const material of materials(source)) {
    const surface = material as THREE.MeshStandardMaterial;
    if (surface.displacementMap) padding = Math.max(padding, Math.abs(surface.displacementScale) + Math.abs(surface.displacementBias));
  }
  return padding;
}
function visible(source: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = source; node; node = node.parent) if (!node.visible) return false;
  return true;
}
function objectSignature(object: THREE.Object3D): unknown[] {
  return [object.parent, object.visible, object.matrixAutoUpdate, object.matrixWorldAutoUpdate,
    object.position.x, object.position.y, object.position.z, object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w,
    object.scale.x, object.scale.y, object.scale.z, ...object.matrix.elements, ...object.matrixWorld.elements];
}

/**
 * Owner-managed static scene snapshot. This module is not installed in production.
 *
 * FourBiomeWorld must route EVERY static edit through mutate/invalidate, including
 * source replacement, parent transforms, membership, visibility, material/texture
 * edits and geometry/instance buffers. The ordinary Three needsUpdate rules still
 * apply to GPU buffers. A returned cache key proves a declared revision, not that
 * arbitrary external writes were magically detected without inspecting them.
 * assertFresh is the expensive debug/QA audit for that contract. External root
 * ancestor changes are checked cheaply on every prepare and require invalidation.
 * Dynamic aircraft/clouds belong outside root and are supplied explicitly.
 */
export class StaticWorldSnapshot {
  private root: THREE.Object3D | null;
  private options: StaticWorldSnapshotOptions;
  private readonly sources: THREE.Mesh[] = [];
  private readonly entries = new Map<THREE.Mesh, Entry>();
  private readonly nodeSignatures = new Map<THREE.Object3D, unknown[]>();
  private readonly geometryEntries = new Map<THREE.BufferGeometry, GeometryEntry>();
  private readonly materialSignatures = new Map<THREE.Material, unknown[]>();
  private readonly dirty = new Set<THREE.Mesh>();
  private readonly dirtyNodes = new Set<THREE.Object3D>();
  private readonly staticBounds = new THREE.Box3();
  private readonly combinedBounds = new THREE.Box3();
  private readonly temporaryBox = new THREE.Box3();
  private readonly instanceMatrix = new THREE.Matrix4();
  private fullRebuild = true;
  private revision = 1;
  private lightRevision = 0;
  private sunlight: readonly number[] = [];
  private ancestorSignature: unknown[] = [];
  private staticReceivers = 0;
  private transaction = false;

  constructor(root: THREE.Object3D, options: StaticWorldSnapshotOptions) {
    if (!options.sourceIdentity) throw new Error('An authoritative static source identity is required');
    this.root = root; this.options = {...options};
  }
  /** Declared source provenance; changing it invalidates all prior static evidence. */
  setSourceIdentity(identity: string): void {
    this.requireRoot();
    if (!identity) throw new Error('Static source identity must not be empty');
    if (identity === this.options.sourceIdentity) return;
    this.options.sourceIdentity = identity; this.invalidate(['source']);
  }
  /** Direction, projection/depth datums, bias/filter settings and light state in a fixed documented order. */
  setSunlight(coefficients: readonly number[]): void {
    this.requireRoot();
    if (!coefficients.every(Number.isFinite)) throw new Error('Sunlight revision coefficients must be finite');
    if (equal(this.sunlight, coefficients)) return;
    this.sunlight = [...coefficients]; this.lightRevision++;
  }
  /** Use before a synchronous owner mutation; prepare cannot observe a partial transaction. */
  mutate(kinds: readonly StaticWorldChange[], targets: readonly THREE.Object3D[], mutation: () => void): void {
    this.requireRoot();
    if (this.transaction) throw new Error('Nested static mutations are not supported');
    this.invalidate(kinds, targets); this.transaction = true;
    try {
      const result: unknown = mutation();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw new Error('Static mutation must be synchronous');
    } finally { this.transaction = false; }
  }
  /** Geometry/material edits rebuild shared dependencies; pose/visibility/instance edits can target a subtree. */
  invalidate(kinds: readonly StaticWorldChange[], targets: readonly THREE.Object3D[] = []): void {
    const root = this.requireRoot();
    if (!kinds.length || kinds.some(kind => !changes.includes(kind))) throw new Error('Declare at least one supported static change');
    this.revision++;
    if (!targets.length || kinds.some(kind => ['source', 'membership', 'geometry', 'materials'].includes(kind))) { this.fullRebuild = true; return; }
    for (const target of targets) {
      let member = false;
      for (let node: THREE.Object3D | null = target; node; node = node.parent) if (node === root) member = true;
      if (!member) throw new Error('Target is outside the static root; invalidate membership for removal/reparenting');
      target.traverse(node => { this.dirtyNodes.add(node); if (node instanceof THREE.Mesh) this.dirty.add(node); });
    }
  }
  private requireRoot(): THREE.Object3D {
    if (!this.root) throw new Error('Static snapshot has been disposed');
    return this.root;
  }
  private ancestors(): unknown[] {
    const result: unknown[] = [];
    for (let node = this.requireRoot().parent; node; node = node.parent) result.push(node, ...objectSignature(node));
    return result;
  }
  private sourceSignature(source: THREE.Mesh): unknown[] {
    const result: unknown[] = [...objectSignature(source), source.geometry, source.material, ...materials(source), source.receiveShadow, source.castShadow,
      this.options.logicalLayers?.(source) ?? source.layers.mask, source.customDepthMaterial, source.customDistanceMaterial,
      source.onBeforeRender, source.onAfterRender, source.onBeforeShadow, source.onAfterShadow];
    if (source instanceof THREE.InstancedMesh) result.push(source.count, source.instanceMatrix, source.instanceMatrix.array, source.instanceMatrix.version,
      source.instanceColor, source.instanceColor?.array, source.instanceColor?.version, source.morphTexture);
    return result;
  }
  private geometry(geometry: THREE.BufferGeometry): GeometryEntry {
    let entry = this.geometryEntries.get(geometry);
    if (!entry) {
      const attribute = geometry.getAttribute('position');
      if (!attribute) throw new Error('Static source geometry requires a position attribute');
      // Retain Three's native object/frustum/raycast bounds on declared edits.
      // The old receiver traversal refreshed these; caching must not leave them stale.
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      entry = {box: new THREE.Box3().setFromBufferAttribute(attribute as THREE.BufferAttribute), signature: geometrySignature(geometry)};
      this.geometryEntries.set(geometry, entry);
    }
    return entry;
  }
  private updateEntry(source: THREE.Mesh): void {
    if (source instanceof THREE.SkinnedMesh || source.morphTargetInfluences?.length ||
      Object.values(source.geometry.morphAttributes).some(attributes => attributes?.length) ||
      source instanceof THREE.InstancedMesh && source.morphTexture) throw new Error('Animated/morph meshes must stay outside the static root');
    source.updateWorldMatrix(true, false);
    if (!source.matrixWorld.elements.every(Number.isFinite)) throw new Error('Static transforms must be finite');
    const prototype = this.geometry(source.geometry).box.clone().expandByScalar(displacement(source));
    let entry = this.entries.get(source);
    if (!entry) { entry = {source, bounds: new THREE.Box3(), active: false, signature: []}; this.entries.set(source, entry); }
    entry.bounds.makeEmpty();
    if (source instanceof THREE.InstancedMesh) {
      if (!Number.isInteger(source.count) || source.count < 0 || source.count > source.instanceMatrix.count) throw new Error('Invalid static instance count');
      for (let i = 0; i < source.count; i++) {
        source.getMatrixAt(i, this.instanceMatrix);
        if (!this.instanceMatrix.elements.every(Number.isFinite)) throw new Error('Static instance transforms must be finite');
        entry.bounds.union(this.temporaryBox.copy(prototype).applyMatrix4(this.instanceMatrix));
      }
      source.computeBoundingBox(); source.computeBoundingSphere();
    } else entry.bounds.copy(prototype);
    entry.bounds.applyMatrix4(source.matrixWorld);
    entry.active = source.receiveShadow && visible(source);
    entry.signature = this.sourceSignature(source);
    for (const material of materials(source)) if (!this.materialSignatures.has(material)) this.materialSignatures.set(material, materialSignature(material));
  }
  prepare(dynamicReceivers: readonly THREE.Mesh[] = []): StaticWorldFrame {
    const root = this.requireRoot();
    if (this.transaction) throw new Error('Cannot prepare a partial static mutation');
    const rebuilding = this.fullRebuild;
    if (!rebuilding && !equal(this.ancestorSignature, this.ancestors())) throw new Error('Static root ancestor changed; invalidate the complete static root');
    let processed = 0;
    if (rebuilding) {
      root.updateWorldMatrix(true, true);
      this.sources.length = 0; this.entries.clear(); this.nodeSignatures.clear(); this.geometryEntries.clear(); this.materialSignatures.clear();
      root.traverse(node => { if (node instanceof THREE.Mesh) this.sources.push(node); });
      for (const source of this.sources) { this.updateEntry(source); processed++; }
    } else for (const source of this.dirty) {
      if (!this.entries.has(source)) throw new Error('Static membership changed; declare membership invalidation');
      this.updateEntry(source); processed++;
    }
    if (rebuilding || this.dirtyNodes.size) {
      this.staticBounds.makeEmpty(); this.staticReceivers = 0;
      for (const entry of this.entries.values()) if (entry.active) { this.staticBounds.union(entry.bounds); this.staticReceivers++; }
      if (rebuilding) root.traverse(node => this.nodeSignatures.set(node, objectSignature(node)));
      else for (const node of this.dirtyNodes) this.nodeSignatures.set(node, objectSignature(node));
      this.ancestorSignature = this.ancestors();
      this.dirty.clear(); this.dirtyNodes.clear(); this.fullRebuild = false;
    }
    this.combinedBounds.copy(this.staticBounds);
    let dynamicCount = 0;
    for (const source of dynamicReceivers) {
      if (this.entries.has(source)) throw new Error('A source cannot be both static and dynamic');
      if (!source.receiveShadow || !visible(source)) continue;
      source.updateWorldMatrix(true, false);
      // Dynamic geometry is deliberately re-evaluated, not entered in the static cache.
      if (source instanceof THREE.SkinnedMesh || source instanceof THREE.InstancedMesh) { source.computeBoundingBox(); this.temporaryBox.copy(source.boundingBox!); }
      else { source.geometry.computeBoundingBox(); this.temporaryBox.copy(source.geometry.boundingBox!); }
      this.temporaryBox.expandByScalar(displacement(source)).applyMatrix4(source.matrixWorld);
      this.combinedBounds.union(this.temporaryBox); dynamicCount++;
    }
    this.combinedBounds.expandByScalar(2);
    return {receiverBounds: this.combinedBounds, staticReceiverBounds: this.staticBounds, staticSources: this.sources,
      staticRevision: this.revision, sunlightRevision: this.lightRevision, sourceIdentity: this.options.sourceIdentity,
      cacheKey: `${this.options.sourceIdentity}:${this.revision}:${this.lightRevision}`,
      staticReceivers: this.staticReceivers, dynamicReceivers: dynamicCount, processedStaticSources: processed, rebuiltMembership: rebuilding};
  }
  /** Deliberately O(scene + unique materials/attributes). Never call this in the warm render loop. */
  assertFresh(): void {
    const root = this.requireRoot();
    if (this.fullRebuild || this.dirtyNodes.size) throw new Error('Prepare declared mutations before auditing freshness');
    if (!equal(this.ancestorSignature, this.ancestors())) throw new Error('Unreported ancestor mutation');
    let nodes = 0;
    root.traverse(node => {
      nodes++;
      const signature = this.nodeSignatures.get(node);
      if (!signature || !equal(signature, objectSignature(node))) throw new Error(`Unreported membership/transform/visibility mutation: ${node.name || node.uuid}`);
      if (node instanceof THREE.Mesh && !equal(this.entries.get(node)?.signature ?? [], this.sourceSignature(node))) throw new Error(`Unreported source mutation: ${node.name || node.uuid}`);
    });
    if (nodes !== this.nodeSignatures.size) throw new Error('Unreported removed static member');
    for (const [geometry, entry] of this.geometryEntries) if (!equal(entry.signature, geometrySignature(geometry))) throw new Error('Unreported geometry/attribute mutation');
    for (const [material, signature] of this.materialSignatures) if (!equal(signature, materialSignature(material))) throw new Error('Unreported material/texture mutation');
  }
  dispose(): void {
    if (!this.root) return;
    this.sources.length = 0; this.entries.clear(); this.nodeSignatures.clear(); this.geometryEntries.clear(); this.materialSignatures.clear(); this.dirty.clear(); this.dirtyNodes.clear();
    this.ancestorSignature = []; this.sunlight = []; this.root = null; this.options = {sourceIdentity: 'disposed'};
    this.staticBounds.makeEmpty(); this.combinedBounds.makeEmpty();
  }
}
