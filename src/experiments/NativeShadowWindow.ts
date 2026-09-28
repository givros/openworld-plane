import { Matrix4, Vector3 } from 'three';
import type { DirectionalLight, OrthographicCamera } from 'three';
import { positiveShadowModulo, snapShadowWindow } from './ToroidalShadowDepthPlanner';
import type { LightDepthCamera, ShadowDepthCacheIdentity, ShadowWindow, ShadowWindowUpdate, SunBasis } from './ToroidalShadowDepthPlanner';

export type ShadowSourceBounds = readonly [number, number, number, number, number, number];
export interface NativeShadowWindowSnapshot {
  readonly identity: ShadowDepthCacheIdentity;
  readonly window: ShadowWindow;
  readonly lightCamera: LightDepthCamera;
  readonly globalAxisMinimum: number;
  readonly globalAxisMaximum: number;
  readonly sampleOffset: readonly [.5, .5];
  readonly rasterSamples: 1;
  readonly shadowTargetSamples: 0;
  readonly basisMaximumError: number;
  readonly anchorMaximumErrorTexels: number;
  readonly nearPlaneCanClipGlobalCasters: boolean;
}
export type ShadowWindowRevisions = Pick<ShadowDepthCacheIdentity, 'sourceIdentity' | 'geometryRevision' | 'materialRevision' | 'casterPolicyRevision' | 'projectionRevision'>;

/** Same fixed light orientation used by Three CSM.update, before its translation. */
export function fixedSunBasis(direction: readonly [number, number, number]): SunBasis {
  const forward = new Vector3(...direction).normalize();
  if (forward.lengthSq() === 0) throw new Error('Sun direction must be nonzero.');
  const elements = new Matrix4().lookAt(new Vector3(), forward, new Vector3(0, 1, 0)).elements;
  return [elements[0], elements[1], elements[2], elements[4], elements[5], elements[6], -elements[8], -elements[9], -elements[10]];
}

/**
 * Read after native light.shadow.updateMatrices(light). No light/scene mutation.
 * The stable sun basis avoids invalidating the cache for target-minus-position
 * rounding noise in a translated light's lookAt. That noise is measured below.
 */
export function captureNativeShadowWindow(light: DirectionalLight, basis: SunBasis, sourceBounds: ShadowSourceBounds, revisions: ShadowWindowRevisions): NativeShadowWindowSnapshot {
  const camera = light.shadow.camera as OrthographicCamera, size = light.shadow.mapSize;
  if (!camera.isOrthographicCamera || camera.reversedDepth) throw new Error('Only the current non-reversed orthographic CSM policy is supported.');
  if (size.x !== size.y || size.x !== 4096) throw new Error('The prototype preserves each current 4096-square cascade.');
  if (camera.zoom !== 1 || camera.view?.enabled) throw new Error('A zoomed or view-offset light camera requires a new pixel-grid mapping.');
  if (Math.abs(camera.left + camera.right) > 1e-9 || Math.abs(camera.bottom + camera.top) > 1e-9) throw new Error('Expected symmetric native CSM bounds.');
  if (sourceBounds.length !== 6 || sourceBounds.some(value => !Number.isFinite(value)) || [0, 1, 2].some(axis => sourceBounds[axis] > sourceBounds[axis + 3])) throw new Error('Invalid full-source bounds.');
  const matrix = camera.matrixWorld.elements;
  const actualBasis = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], -matrix[8], -matrix[9], -matrix[10]];
  const basisMaximumError = Math.max(...actualBasis.map((value, index) => Math.abs(value - basis[index])));
  if (basisMaximumError > 1e-9) throw new Error('Light camera orientation differs from the fixed cache sun basis.');
  const position = [matrix[12], matrix[13], matrix[14]], dot = (offset: number, point: readonly number[]) => basis[offset] * point[0] + basis[offset + 1] * point[1] + basis[offset + 2] * point[2];
  const texelScale: readonly [number, number] = [(camera.right - camera.left) / size.x, (camera.top - camera.bottom) / size.y];
  const identity: ShadowDepthCacheIdentity = { ...revisions, sunBasis: [...basis] as unknown as SunBasis, texelScale, mapSize: size.x };
  const center: readonly [number, number] = [dot(0, position), dot(3, position)], window = snapShadowWindow(center, identity);
  const anchorMaximumErrorTexels = Math.max(Math.abs((center[0] + camera.left) / texelScale[0] - window.x), Math.abs((center[1] + camera.bottom) / texelScale[1] - window.y));
  if (anchorMaximumErrorTexels > 1e-6) throw new Error('Native CSM samples are not aligned with the persistent world texel grid.');
  let minimum = Infinity, maximum = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const point = [sourceBounds[(corner & 1) ? 3 : 0], sourceBounds[(corner & 2) ? 4 : 1], sourceBounds[(corner & 4) ? 5 : 2]], depth = dot(6, point);
    minimum = Math.min(minimum, depth); maximum = Math.max(maximum, depth);
  }
  // Source bounds are outward-rounded. Extra metre guards float ray-origin
  // reconstruction; it never clips a source triangle or reduces sample density.
  const padding = Math.max(1, (maximum - minimum) * 2e-6);
  const lightCamera = { axisOrigin: dot(6, position), near: camera.near, far: camera.far };
  return { identity, window, lightCamera, globalAxisMinimum: minimum - padding, globalAxisMaximum: maximum + padding,
    sampleOffset: [.5, .5], rasterSamples: 1, shadowTargetSamples: 0, basisMaximumError, anchorMaximumErrorTexels,
    nearPlaneCanClipGlobalCasters: minimum < lightCamera.axisOrigin + camera.near };
}

/** Pixel Y increases along light-up: these are GL bottom-left coordinates. */
export function shadowWorldSample(snapshot: NativeShadowWindowSnapshot, x: number, y: number, axisDepth: number): readonly [number, number, number] {
  const basis = snapshot.identity.sunBasis, scale = snapshot.identity.texelScale;
  const lx = (x + .5) * scale[0], ly = (y + .5) * scale[1];
  return [0, 1, 2].map(axis => basis[axis] * lx + basis[3 + axis] * ly + basis[6 + axis] * axisDepth) as unknown as readonly [number, number, number];
}

/** 112-byte HLSL cbuffer, uploaded at a 256-byte aligned GPU offset. */
export function packNativeShadowParameters(snapshot: NativeShadowWindowSnapshot, update: ShadowWindowUpdate, cascade: number): ArrayBuffer {
  const size = snapshot.identity.mapSize, { world, destination } = update;
  if (!Number.isInteger(cascade) || cascade < 0 || cascade >= 4) throw new Error('Exactly four cascade slots are available.');
  for (const value of [world.x, world.y, world.width, world.height, destination.x, destination.y]) if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('Rectangle exceeds signed native integer range.');
  if (world.width < 1 || world.height < 1 || destination.width !== world.width || destination.height !== world.height || destination.x !== positiveShadowModulo(world.x, size) || destination.y !== positiveShadowModulo(world.y, size) || destination.x + world.width > size || destination.y + world.height > size) throw new Error('Update must already be split at toroidal boundaries.');
  const bytes = new ArrayBuffer(112), f = new Float32Array(bytes), i = new Int32Array(bytes), u = new Uint32Array(bytes), basis = snapshot.identity.sunBasis;
  f.set([...basis.slice(0, 3), snapshot.identity.texelScale[0]], 0); f.set([...basis.slice(3, 6), snapshot.identity.texelScale[1]], 4);
  f.set([...basis.slice(6, 9), snapshot.globalAxisMinimum], 8);
  f.set([snapshot.globalAxisMaximum, snapshot.lightCamera.axisOrigin + snapshot.lightCamera.near, snapshot.lightCamera.axisOrigin + snapshot.lightCamera.far, 0], 12);
  i.set([world.x, world.y, world.width, world.height], 16); u.set([destination.x, destination.y, size, cascade], 20);
  i.set([snapshot.window.x, snapshot.window.y, 0, 0], 24); return bytes;
}

/** Raw little-endian float bits, not numeric RGBA depth packing or color data. */
export function worldDepthToRGBA8Bytes(values: Float32Array): Uint8Array {
  const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer);
  for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, values[index], true);
  return result;
}
