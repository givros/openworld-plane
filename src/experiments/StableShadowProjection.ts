import * as THREE from 'three';
import { CSMFrustum } from 'three/addons/csm/CSMFrustum.js';

/** Reserve normal climbs before the first cached map allocation. */
export function computeStableShadowDistanceEnvelope(groundDistance:number,currentFar:number,near:number):{lowerFar:number;upperFar:number} {
  if(![groundDistance,currentFar,near].every(Number.isFinite)||near<=0||groundDistance<=near||currentFar<=near)
    throw new Error('Invalid stable shadow distance envelope.');
  return {
    // A separately capped camera remains safe even below its ground preset.
    lowerFar:Math.min(groundDistance,currentFar),
    upperFar:Math.max(Math.ceil(groundDistance*1.25/64)*64,Math.ceil(currentFar/64)*64),
  };
}

/** Exact r184 CSM extent, including this project's corrected fade coverage. */
export function computeCascadeExtents(
  camera: THREE.PerspectiveCamera, maxFar: number, breaks: readonly number[], fov = camera.fov, fade = true,
): number[] {
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 179 || !Number.isFinite(maxFar) || maxFar <= camera.near ||
      !Number.isFinite(camera.near) || camera.near <= 0 || !Number.isFinite(camera.far) || camera.far <= camera.near ||
      !breaks.length || breaks.at(-1) !== 1 || breaks.some((value, index) => !Number.isFinite(value) || value <= (index ? breaks[index - 1] : 0) || value > 1)) {
    throw new Error('Invalid stable shadow cascade configuration.');
  }
  const reference = camera.clone();
  reference.fov = fov;
  reference.coordinateSystem = THREE.WebGLCoordinateSystem;
  // CSMFrustum uses conventional clip-space corners even when the renderer uses reverse depth.
  (reference as THREE.PerspectiveCamera & { _reversedDepth: boolean })._reversedDepth = false;
  reference.updateProjectionMatrix();
  const main = new CSMFrustum({ webGL: true }), cascades: CSMFrustum[] = [];
  main.setFromProjectionMatrix(reference.projectionMatrix, maxFar);
  main.split([...breaks], cascades);
  const range = Math.min(reference.far, maxFar) - reference.near;
  return cascades.map(({ vertices }) => {
    const a = vertices.far[0];
    let width = Math.max(a.distanceTo(vertices.far[2]), a.distanceTo(vertices.near[2]));
    if (fade) width += .25 * a.z * a.z / range;
    return width;
  });
}

export interface StableShadowProjectionOptions {
  readonly lightDirection: THREE.Vector3;
  /** Largest original CSM extent in the accepted FOV/distance/aspect envelope. */
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  /** Smallest original extent in the same envelope, evaluated at nativeMapSize. */
  readonly minimumNativeWidth: number;
  readonly minimumNativeHeight: number;
  readonly nativeMapSize: number;
  readonly maxTextureSize: number;
  /** Fixed dot(light world position, light camera's backward axis). */
  readonly depthAxisOrigin: number;
  readonly near: number;
  readonly far: number;
  /** Optional conservative padding for normal bias and roundoff, in world metres. */
  readonly depthPadding?: number;
  /** Keep a successful fixed-grid center while it still contains native coverage. */
  readonly retainCoveredProjection?: boolean;
}

export interface NativeShadowProjection {
  readonly width: number;
  readonly height: number;
  readonly mapSize: number;
}

export type StableShadowFallback = 'texture-limit' | 'native-coverage' | 'native-density' | 'depth-range' | 'sun-direction' | 'horizontal-sun' | 'projection-policy';
export type StableShadowProjectionResult = { readonly applied: true } | { readonly applied: false; readonly reason: StableShadowFallback };

/**
 * Opt-in fixed-grid directional projection for an exact scrolling depth cache.
 * It does not allocate maps or alter assets. A caller must restore the native
 * CSM projection if apply returns false, and invalidate its cache when replacing
 * this reference. Supply the freshly computed native extent, not last frame's
 * stabilized extent. CSM should update its ordinary center before every apply.
 */
export class StableShadowProjection {
  readonly width: number;
  readonly height: number;
  readonly mapSize: number;
  readonly texelWidth: number;
  readonly texelHeight: number;
  private readonly direction: THREE.Vector3;
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly observedDirection = new THREE.Vector3();
  private readonly nextPosition = new THREE.Vector3();
  private readonly nextTarget = new THREE.Vector3();
  private readonly depthPadding: number;
  private retainedCenterX: number | undefined;
  private retainedCenterY: number | undefined;

  constructor(private readonly options: StableShadowProjectionOptions) {
    const positive = [options.referenceWidth, options.referenceHeight, options.minimumNativeWidth, options.minimumNativeHeight, options.nativeMapSize, options.maxTextureSize];
    if (positive.some(value => !Number.isFinite(value) || value <= 0) ||
        !Number.isInteger(options.nativeMapSize) || !Number.isInteger(options.maxTextureSize) ||
        options.minimumNativeWidth > options.referenceWidth || options.minimumNativeHeight > options.referenceHeight ||
        !Number.isFinite(options.depthAxisOrigin) || !Number.isFinite(options.near) || !Number.isFinite(options.far) || options.near < 0 || options.far <= options.near ||
        !options.lightDirection.toArray().every(Number.isFinite) || options.lightDirection.lengthSq() === 0) {
      throw new Error('Invalid stable shadow projection reference.');
    }
    this.depthPadding = options.depthPadding ?? 2;
    if (!Number.isFinite(this.depthPadding) || this.depthPadding < 0) throw new Error('Invalid stable shadow depth padding.');
    this.direction = options.lightDirection.clone().normalize();
    const orientation = new THREE.Matrix4().lookAt(new THREE.Vector3(), this.direction, new THREE.Vector3(0, 1, 0));
    this.axisX.setFromMatrixColumn(orientation, 0);
    this.axisY.setFromMatrixColumn(orientation, 1);
    this.axisZ.setFromMatrixColumn(orientation, 2);

    const minimumTexelWidth = options.minimumNativeWidth / options.nativeMapSize;
    const minimumTexelHeight = options.minimumNativeHeight / options.nativeMapSize;
    // One native texel on each side covers the shift from CSM's old snapped
    // center to the fixed grid. Increase map resolution to preserve density.
    this.width = options.referenceWidth + 2 * minimumTexelWidth;
    this.height = options.referenceHeight + 2 * minimumTexelHeight;
    this.mapSize = Math.ceil(Math.max(this.width / minimumTexelWidth, this.height / minimumTexelHeight));
    this.texelWidth = this.width / this.mapSize;
    this.texelHeight = this.height / this.mapSize;
  }

  /**
   * Height bounds must enclose every possible caster, including the aircraft.
   * A height slab, intersected with the map's X/Y rectangle, also bounds the
   * depth of the project's enormous ocean sheets without using their full AABB.
   */
  apply(light: THREE.DirectionalLight, native: NativeShadowProjection, casterHeights: readonly [number, number]): StableShadowProjectionResult {
    if (![native.width, native.height, native.mapSize, ...casterHeights].every(Number.isFinite) || native.width <= 0 || native.height <= 0 || native.mapSize <= 0 ||
        !Number.isInteger(native.mapSize) || casterHeights[0] > casterHeights[1]) throw new Error('Invalid native shadow coverage or caster heights.');
    if (this.mapSize > this.options.maxTextureSize) return { applied: false, reason: 'texture-limit' };
    if (native.width > this.options.referenceWidth + 1e-9 || native.height > this.options.referenceHeight + 1e-9) return { applied: false, reason: 'native-coverage' };
    if (this.texelWidth > native.width / native.mapSize + 1e-12 || this.texelHeight > native.height / native.mapSize + 1e-12) return { applied: false, reason: 'native-density' };
    const camera = light.shadow.camera;
    if (camera.zoom !== 1 || camera.view?.enabled) return { applied: false, reason: 'projection-policy' };
    if (camera.near !== this.options.near || camera.far !== this.options.far) return { applied: false, reason: 'depth-range' };
    if (Math.abs(this.axisZ.y) < 1e-6) return { applied: false, reason: 'horizontal-sun' };
    light.getWorldPosition(this.position);
    light.target.getWorldPosition(this.target);
    this.observedDirection.subVectors(this.target, this.position).normalize();
    if (this.observedDirection.distanceToSquared(this.direction) > 1e-18 || camera.up.x !== 0 || camera.up.y !== 1 || camera.up.z !== 0) return { applied: false, reason: 'sun-direction' };

    const nativeCenterX = this.position.dot(this.axisX), nativeCenterY = this.position.dot(this.axisY);
    // The larger reserved FOV/distance envelope can cover several flight frames
    // without any map scroll. Test the entire current native rectangle, including
    // a two-texel guard; checking only the view center would miss edge receivers.
    // Each covered axis remains anchored independently. Crossing one edge must
    // not redraw an unrelated strip along the still-covered perpendicular axis.
    const retainX = this.options.retainCoveredProjection && this.retainedCenterX !== undefined &&
      Math.abs(nativeCenterX - this.retainedCenterX) + native.width / 2 <= this.width / 2 - 2 * this.texelWidth;
    const retainY = this.options.retainCoveredProjection && this.retainedCenterY !== undefined &&
      Math.abs(nativeCenterY - this.retainedCenterY) + native.height / 2 <= this.height / 2 - 2 * this.texelHeight;
    const centerX = retainX ? this.retainedCenterX! : Math.round(nativeCenterX / this.texelWidth) * this.texelWidth;
    const centerY = retainY ? this.retainedCenterY! : Math.round(nativeCenterY / this.texelHeight) * this.texelHeight;
    const centerHeight = this.axisX.y * centerX + this.axisY.y * centerY;
    const heightRadius = Math.abs(this.axisX.y) * this.width / 2 + Math.abs(this.axisY.y) * this.height / 2;
    const z0 = (casterHeights[0] - centerHeight - heightRadius) / this.axisZ.y;
    const z1 = (casterHeights[1] - centerHeight + heightRadius) / this.axisZ.y;
    const minZ = Math.min(z0, z1) - this.depthPadding, maxZ = Math.max(z0, z1) + this.depthPadding;
    if (minZ < this.options.depthAxisOrigin - this.options.far || maxZ > this.options.depthAxisOrigin - this.options.near) return { applied: false, reason: 'depth-range' };

    this.nextPosition.copy(this.axisX).multiplyScalar(centerX).addScaledVector(this.axisY, centerY).addScaledVector(this.axisZ, this.options.depthAxisOrigin);
    this.nextTarget.copy(this.nextPosition).add(this.direction);
    if (light.parent) light.parent.worldToLocal(this.nextPosition);
    if (light.target.parent) light.target.parent.worldToLocal(this.nextTarget);
    light.position.copy(this.nextPosition);
    light.target.position.copy(this.nextTarget);
    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    camera.left = -this.width / 2; camera.right = this.width / 2;
    camera.bottom = -this.height / 2; camera.top = this.height / 2;
    camera.updateProjectionMatrix();
    light.shadow.mapSize.set(this.mapSize, this.mapSize);
    // Failed coverage/direction/depth validation must never replace the anchor.
    this.retainedCenterX = centerX;
    this.retainedCenterY = centerY;
    return { applied: true };
  }
}
