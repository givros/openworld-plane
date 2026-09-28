import type { InstancedMesh, Object3D } from 'three';

const ownedSources=new WeakSet<InstancedMesh>();

/**
 * The stream owner promises that instance storage/count, authored local bounds,
 * source callbacks and sorting metadata remain fixed until release/unregister.
 * Parent transforms/visibility, castShadow and shared geometry/material resources
 * remain mutable and are still checked by the renderer. Mark only after transfer.
 */
export function markImmutableStreamSource(source:InstancedMesh):void {ownedSources.add(source);}
export function isImmutableStreamSource(source:InstancedMesh):boolean {return ownedSources.has(source);}
/** Revoke before editing source-local authored state; the next prepare audits it. */
export function releaseImmutableStreamSource(source:InstancedMesh):void {
  ownedSources.delete(source);releaseStaticStreamSource(source);
}

/** A stronger, explicit ownership contract than the authored-instance contract.
 * The owner fixes source-local presentation, hierarchy below anchor, resource
 * bindings, geometry/material/texture content and callbacks until invalidation
 * or revocation. Renderer-managed GPU bookkeeping and camera/light uniforms may
 * still change. The anchor and its ancestors remain dynamic and are audited.
 */
export interface StaticStreamSourceLease {
  readonly anchor:Object3D;
  readonly revision:number;
  readonly resourcesRevision:number;
}
interface OwnedSector { anchor:Object3D; revision:number; readonly resourcesRevision:number }
const staticSources=new WeakMap<InstancedMesh,OwnedSector>();
const observedStaticSources=new WeakSet<InstancedMesh>();
const staticSectors=new WeakMap<Object3D,OwnedSector>();
let staticResourceRevision=0;
let staticOwnershipRevision=0;
/** Membership changes are explicit, so renderers need not look up every source
 * each frame. Sector/source edits use the existing per-sector revision instead.
 */
export function getStaticStreamOwnershipRevision():number {return staticOwnershipRevision;}

/** Call only after authoring and attaching a direct child of this stream sector. */
export function markStaticStreamSource(source:InstancedMesh,anchor:Object3D):void {
  if(source.parent!==anchor)throw new Error('Static stream sources must be direct children of their sector anchor');
  let sector=staticSectors.get(anchor);
  if(!sector){sector={anchor,revision:0,get resourcesRevision(){return staticResourceRevision;}};staticSectors.set(anchor,sector);}
  if(staticSources.get(source)!==sector){
    releaseStaticStreamSource(source);staticSources.set(source,sector);sector.revision++;
    // Fresh stream sources are leased before renderer registration. They cannot
    // invalidate a renderer's existing membership cache; addSources registers
    // them incrementally. Previously observed dynamic sources still invalidate.
    if(observedStaticSources.has(source))staticOwnershipRevision++;
  }
}
export function getStaticStreamSourceLease(source:InstancedMesh):StaticStreamSourceLease|undefined {
  observedStaticSources.add(source);return staticSources.get(source);
}
/** Invalidate before an owner-controlled source edit; capacity still cannot grow. */
export function invalidateStaticStreamSource(source:InstancedMesh):void {
  const sector=staticSources.get(source);if(sector)sector.revision++;
}
/** Invalidate before shared geometry/material/texture edits. Keep Three's normal
 * attribute/texture needsUpdate notifications as well, so GPU uploads stay valid.
 * Resource edits are rare; a global revision avoids per-frame resource scanning.
 */
export function invalidateStaticStreamResources():void {staticResourceRevision++;}
/** Revoke before reparenting, releasing resources, or handing control to callers. */
export function releaseStaticStreamSource(source:InstancedMesh):void {
  const sector=staticSources.get(source);if(sector){sector.revision++;staticSources.delete(source);staticOwnershipRevision++;}
}
