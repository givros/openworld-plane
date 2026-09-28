import type { InstancedMesh } from 'three';

const frustumOnlySources=new WeakSet<InstancedMesh>();

/** Ordinary mesh containers retain camera-frustum visibility after conversion. */
export function markStreamFrustumOnlySource(source:InstancedMesh):void {frustumOnlySources.add(source);}
export function isStreamFrustumOnlySource(source:InstancedMesh):boolean {return frustumOnlySources.has(source);}
