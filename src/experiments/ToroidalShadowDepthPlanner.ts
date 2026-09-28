/**
 * Pure planning for an exact static shadow-depth window. No GPU work is done here.
 * A cache texel stores the nearest static caster's world coordinate along the
 * fixed sun-forward axis, not depth normalized to a moving light camera.
 *
 * The caller must query all relevant static casters, keep the source raster
 * coverage/polygon-offset policy, and validate those rules against native CSM.
 * Dynamic aircraft depth is rendered separately; combine static and dynamic
 * comparison results for each native PCF tap before the existing 20-tap average.
 */

export type ShadowRevision = string | number;
export type SunBasis = readonly [number, number, number, number, number, number, number, number, number];
export interface ShadowDepthCacheIdentity {
  readonly sourceIdentity: string;
  readonly geometryRevision: ShadowRevision;
  readonly materialRevision: ShadowRevision;
  readonly casterPolicyRevision: ShadowRevision;
  /** Change when FOV, viewport dimensions, or projection setup changes. */
  readonly projectionRevision: ShadowRevision;
  /** Rows: light X, light Y, light forward; fixed orthonormal world-space axes. */
  readonly sunBasis: SunBasis;
  /** Exact world metres per shadow texel in X/Y; no density adaptation. */
  readonly texelScale: readonly [number, number];
  /** Current CSM uses 4096. Small maps are useful for exhaustive CPU fixtures. */
  readonly mapSize: number;
}
export interface ShadowRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ShadowWindow extends ShadowRect { readonly width: number; readonly height: number }
export interface ShadowWindowUpdate {
  readonly id: number;
  readonly world: ShadowRect;
  readonly destination: ShadowRect;
}
export interface ShadowWindowPlan {
  readonly id: number;
  readonly generation: number;
  readonly baseRevision: number;
  readonly identity: ShadowDepthCacheIdentity;
  readonly identityKey: string;
  readonly window: ShadowWindow;
  readonly reason: 'initial' | 'invalidated' | 'identity-change' | 'teleport' | 'shift' | 'unchanged';
  /** New-world-window minus the committed world window: at most two rectangles. */
  readonly exposedWorldRectangles: readonly ShadowRect[];
  /** The same rectangles split at toroidal wrap boundaries. */
  readonly updates: readonly ShadowWindowUpdate[];
  readonly requiredTexels: number;
  readonly reusedTexels: number;
}
export interface CommittedShadowWindow {
  readonly revision: number;
  readonly generation: number;
  readonly identity: ShadowDepthCacheIdentity;
  readonly identityKey: string;
  readonly window: ShadowWindow;
}
export interface LightDepthCamera {
  /** dot(lightCameraWorldPosition, fixedSunForward). Deliberately not in cache key. */
  readonly axisOrigin: number;
  readonly near: number;
  readonly far: number;
}
interface PendingPlan { plan: ShadowWindowPlan; started: boolean; completed: Set<number> }

export class StaleShadowWindowPlanError extends Error {
  constructor() { super('The shadow-window plan is stale or is not the current plan.'); this.name = 'StaleShadowWindowPlanError'; }
}

const finite = (value: number, label: string): void => { if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`); };
const safeInteger = (value: number, label: string): void => { if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`); };
const rectangle = (x: number, y: number, width: number, height: number): ShadowRect => Object.freeze({ x, y, width, height });

export function positiveShadowModulo(value: number, size: number): number {
  safeInteger(value, 'World shadow pixel'); safeInteger(size, 'Shadow map size');
  if (size <= 0) throw new Error('Shadow map size must be positive.');
  return ((value % size) + size) % size;
}

function captureIdentity(identity: ShadowDepthCacheIdentity): ShadowDepthCacheIdentity {
  if (!identity.sourceIdentity) throw new Error('A source identity is required.');
  for (const name of ['geometryRevision', 'materialRevision', 'casterPolicyRevision', 'projectionRevision'] as const) {
    const value = identity[name];
    if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid ${name}.`);
  }
  safeInteger(identity.mapSize, 'Shadow map size');
  if (identity.mapSize < 1 || !Number.isSafeInteger(identity.mapSize * identity.mapSize)) throw new Error('Invalid shadow map size.');
  if (identity.texelScale.length !== 2 || identity.texelScale.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Texel scale must be two positive finite values.');
  if (identity.sunBasis.length !== 9 || identity.sunBasis.some(value => !Number.isFinite(value))) throw new Error('Sun basis must contain nine finite values.');
  for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) {
    let product = 0; for (let i = 0; i < 3; i++) product += identity.sunBasis[a * 3 + i] * identity.sunBasis[b * 3 + i];
    if (Math.abs(product - (a === b ? 1 : 0)) > 1e-6) throw new Error('Sun basis must be orthonormal.');
  }
  return Object.freeze({
    sourceIdentity: identity.sourceIdentity, geometryRevision: identity.geometryRevision, materialRevision: identity.materialRevision,
    casterPolicyRevision: identity.casterPolicyRevision, projectionRevision: identity.projectionRevision,
    sunBasis: Object.freeze([...identity.sunBasis]) as unknown as SunBasis,
    texelScale: Object.freeze([...identity.texelScale]) as unknown as readonly [number, number], mapSize: identity.mapSize,
  });
}

/** Samples are globally anchored at (integerWorldPixel + .5) * texelScale. */
export function snapShadowWindow(centerLightXY: readonly [number, number], identity: ShadowDepthCacheIdentity): ShadowWindow {
  finite(centerLightXY[0], 'Light X'); finite(centerLightXY[1], 'Light Y');
  const size = identity.mapSize;
  const x = Math.floor(centerLightXY[0] / identity.texelScale[0] - size / 2 + .5);
  const y = Math.floor(centerLightXY[1] / identity.texelScale[1] - size / 2 + .5);
  for (const value of [x, y, x + size, y + size]) safeInteger(value, 'Shadow window edge');
  return rectangle(x, y, size, size);
}

/** The first strip spans the full Y extent; the second spans only shared X. */
function difference(next: ShadowWindow, previous: ShadowWindow): ShadowRect[] {
  const left = Math.max(next.x, previous.x), right = Math.min(next.x + next.width, previous.x + previous.width);
  const bottom = Math.max(next.y, previous.y), top = Math.min(next.y + next.height, previous.y + previous.height);
  if (left >= right || bottom >= top) return [next];
  const result: ShadowRect[] = [];
  if (next.x < previous.x) result.push(rectangle(next.x, next.y, previous.x - next.x, next.height));
  else if (next.x > previous.x) result.push(rectangle(previous.x + previous.width, next.y, next.x - previous.x, next.height));
  if (next.y < previous.y) result.push(rectangle(left, next.y, right - left, previous.y - next.y));
  else if (next.y > previous.y) result.push(rectangle(left, previous.y + previous.height, right - left, next.y - previous.y));
  return result;
}

function splitTorus(rect: ShadowRect, size: number): { world: ShadowRect; destination: ShadowRect }[] {
  const px = positiveShadowModulo(rect.x, size), py = positiveShadowModulo(rect.y, size);
  const firstWidth = Math.min(rect.width, size - px), firstHeight = Math.min(rect.height, size - py);
  const xs = [{ offset: 0, physical: px, extent: firstWidth }], ys = [{ offset: 0, physical: py, extent: firstHeight }];
  if (firstWidth < rect.width) xs.push({ offset: firstWidth, physical: 0, extent: rect.width - firstWidth });
  if (firstHeight < rect.height) ys.push({ offset: firstHeight, physical: 0, extent: rect.height - firstHeight });
  return ys.flatMap(y => xs.map(x => ({ world: rectangle(rect.x + x.offset, rect.y + y.offset, x.extent, y.extent), destination: rectangle(x.physical, y.physical, x.extent, y.extent) })));
}

/**
 * Plans may supersede other plans before writes start. Once beginUpdates() is
 * called, no replacement update may start until commit or discardCompletedUpdate.
 * This prevents a late stale GPU write from corrupting a newer toroidal window.
 */
export class ToroidalShadowDepthPlanner {
  private generation = 0;
  private sequence = 0;
  private revision = 0;
  private committed: CommittedShadowWindow | null = null;
  private pending: PendingPlan | null = null;
  private writesInFlight: PendingPlan | null = null;
  private wasInvalidated = false;

  get committedWindow(): CommittedShadowWindow | null { return this.writesInFlight ? null : this.committed; }
  get hasWritesInFlight(): boolean { return this.writesInFlight !== null; }

  canReuse(identity: ShadowDepthCacheIdentity): boolean {
    return !!this.committedWindow && this.committedWindow.identityKey === JSON.stringify(captureIdentity(identity));
  }

  plan(centerLightXY: readonly [number, number], suppliedIdentity: ShadowDepthCacheIdentity): ShadowWindowPlan {
    if (this.writesInFlight) throw new Error('Shadow updates are still in flight; wait for their completion before replanning.');
    const identity = captureIdentity(suppliedIdentity), identityKey = JSON.stringify(identity), window = snapShadowWindow(centerLightXY, identity);
    const compatible = this.committed?.identityKey === identityKey;
    const rectangles = compatible ? difference(window, this.committed!.window) : [window];
    const requiredTexels = rectangles.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    let reason: ShadowWindowPlan['reason'];
    if (!this.committed) reason = this.wasInvalidated ? 'invalidated' : 'initial';
    else if (!compatible) reason = 'identity-change';
    else if (!requiredTexels) reason = 'unchanged';
    else if (requiredTexels === identity.mapSize * identity.mapSize) reason = 'teleport';
    else reason = 'shift';
    const updates = rectangles.flatMap(rect => splitTorus(rect, identity.mapSize)).map((update, id) => Object.freeze({ id, ...update }));
    const plan: ShadowWindowPlan = Object.freeze({
      id: ++this.sequence, generation: this.generation, baseRevision: this.committed?.revision ?? 0, identity, identityKey, window, reason,
      exposedWorldRectangles: Object.freeze(rectangles), updates: Object.freeze(updates), requiredTexels,
      reusedTexels: identity.mapSize * identity.mapSize - requiredTexels,
    });
    this.pending = { plan, started: false, completed: new Set() };
    return plan;
  }

  /** Call immediately before dispatching writes; the old cache is unreadable. */
  beginUpdates(plan: ShadowWindowPlan): void {
    const pending = this.current(plan);
    if (pending.started) throw new Error('Shadow updates were already started.');
    pending.started = true;
    if (plan.updates.length) this.writesInFlight = pending;
  }

  /** Acknowledge only after this rectangle's GPU work has completed. */
  acknowledgeUpdate(plan: ShadowWindowPlan, updateId: number): void {
    const pending = this.current(plan);
    if (!pending.started || this.writesInFlight !== pending) throw new Error('Shadow updates must begin before completion is acknowledged.');
    if (!Number.isInteger(updateId) || updateId < 0 || updateId >= plan.updates.length) throw new Error('Unknown shadow update rectangle.');
    pending.completed.add(updateId);
  }

  commit(plan: ShadowWindowPlan): CommittedShadowWindow {
    const pending = this.current(plan);
    if (plan.updates.length && (!pending.started || pending.completed.size !== plan.updates.length)) throw new Error('Cannot commit an incomplete shadow-depth update.');
    this.committed = Object.freeze({ revision: ++this.revision, generation: this.generation, identity: plan.identity, identityKey: plan.identityKey, window: plan.window });
    this.pending = null; this.writesInFlight = null; this.wasInvalidated = false;
    return this.committed;
  }

  /** Invalidates metadata immediately, but does not pretend queued writes stopped. */
  invalidate(): void {
    this.generation++; this.committed = null; this.pending = null; this.wasInvalidated = true;
  }

  /**
   * Call after abandoned writes have actually completed (or their device was
   * destroyed). No texel is considered reusable afterwards. It also releases
   * the write lock of a plan made stale by invalidate().
   */
  discardCompletedUpdate(plan: ShadowWindowPlan): void {
    if (this.writesInFlight?.plan !== plan) throw new StaleShadowWindowPlanError();
    this.writesInFlight = null; this.invalidate();
  }

  private current(plan: ShadowWindowPlan): PendingPlan {
    if (this.pending?.plan !== plan || plan.generation !== this.generation) throw new StaleShadowWindowPlanError();
    return this.pending;
  }
}

function validateDepthCamera(camera: LightDepthCamera): void {
  finite(camera.axisOrigin, 'Light camera axis origin'); finite(camera.near, 'Light near'); finite(camera.far, 'Light far');
  if (camera.near < 0 || camera.far <= camera.near) throw new Error('Invalid orthographic light depth interval.');
}

/** Unclamped depth. The caller must preserve native near/far clipping policy. */
export function worldLightDepthToShadowDepth(worldLightDepth: number, camera: LightDepthCamera): number {
  finite(worldLightDepth, 'World light-axis depth'); validateDepthCamera(camera);
  return (worldLightDepth - camera.axisOrigin - camera.near) / (camera.far - camera.near);
}

export function shadowDepthToWorldLightDepth(shadowDepth: number, camera: LightDepthCamera): number {
  finite(shadowDepth, 'Shadow depth'); validateDepthCamera(camera);
  return shadowDepth * (camera.far - camera.near) + camera.axisOrigin + camera.near;
}
