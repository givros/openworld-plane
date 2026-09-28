import * as THREE from 'three';

export const PAINT_STORAGE_KEY = 'cropper-seven-aircraft-paint';
export const PAINT_PRESETS = [
  { name: 'Crop orange', color: '#ed870c' },
  { name: 'Racing red', color: '#c84732' },
  { name: 'Aero blue', color: '#3479a8' },
  { name: 'Forest green', color: '#4c7650' },
  { name: 'Desert gold', color: '#c7952e' },
  { name: 'Graphite', color: '#3a4146' },
] as const;

/** Shared, paint-safe material roles for the entirely procedural aircraft. */
export class MaterialLibrary {
  readonly primary = new THREE.MeshPhysicalMaterial({ name: 'Primary clearcoat paint', color: '#ed870c', roughness: 0.27, metalness: 0.03, clearcoat: 0.94, clearcoatRoughness: 0.13 });
  readonly highlight = new THREE.MeshPhysicalMaterial({ name: 'Paint highlight', color: '#ff9f1c', roughness: 0.29, metalness: 0.03, clearcoat: 0.85, clearcoatRoughness: 0.16 });
  readonly sheen = new THREE.MeshPhysicalMaterial({ name: 'Paint sheen', color: '#ffc05f', roughness: 0.30, metalness: 0.03, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  readonly warmWhite = new THREE.MeshPhysicalMaterial({ name: 'Warm white enamel', color: '#f4f1e9', roughness: 0.37, metalness: 0.025, clearcoat: 0.50 });
  readonly graphite = new THREE.MeshStandardMaterial({ name: 'Graphite livery and trim', color: '#17191b', roughness: 0.48, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  readonly propeller = new THREE.MeshStandardMaterial({ name: 'Graphite composite propeller', color: '#202224', roughness: 0.35, metalness: 0.13 });
  readonly rubber = new THREE.MeshStandardMaterial({ name: 'Rubber tires', color: '#161616', roughness: 0.94 });
  readonly metal = new THREE.MeshStandardMaterial({ name: 'Brushed aluminum', color: '#d5dbde', roughness: 0.34, metalness: 0.74 });
  readonly darkMetal = new THREE.MeshStandardMaterial({ name: 'Engine steel', color: '#3f4447', roughness: 0.47, metalness: 0.62 });
  readonly glass = new THREE.MeshPhysicalMaterial({ name: 'Smoky cockpit glass', color: '#6f858d', roughness: 0.15, metalness: 0.10, clearcoat: 1, transparent: true, opacity: 0.83, side: THREE.DoubleSide });
  readonly windshield = new THREE.MeshPhysicalMaterial({ name: 'Transparent windshield face glaze', color: '#6f858d', roughness: 0.13, metalness: 0.0, clearcoat: 1, transparent: true, opacity: 0.105, depthWrite: false, side: THREE.DoubleSide });
  readonly glassHighlight = new THREE.MeshBasicMaterial({ name: 'Glass continuity reflection', color: '#c7dce0', transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
  readonly eyeWhite = new THREE.MeshStandardMaterial({ name: 'Eye white', color: '#f0f2ed', roughness: 0.32 });
  readonly iris = new THREE.MeshStandardMaterial({ name: 'Iris blue', color: '#1688d3', roughness: 0.22, emissive: '#1688d3', emissiveIntensity: 0.10 });
  readonly pupil = new THREE.MeshBasicMaterial({ name: 'Dark pupils', color: '#071018' });
  readonly catchlight = new THREE.MeshBasicMaterial({ name: 'Eye catchlights', color: '#ffffff' });
  readonly tipYellow = new THREE.MeshStandardMaterial({ name: 'Propeller safety yellow', color: '#f3ef1e', roughness: 0.45 });
  readonly navRed = new THREE.MeshStandardMaterial({ name: 'Red navigation lens', color: '#e33a2e', emissive: '#e33a2e', emissiveIntensity: 2.2, roughness: 0.2 });
  readonly blur = new THREE.MeshBasicMaterial({ name: 'Additive propeller disc', color: '#91a4ac', side: THREE.DoubleSide, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  private currentColor = '#ed870c';
  private disposed = false;

  constructor() {
    this.blur.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vPropellerUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPropellerUv = uv;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vPropellerUv;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 propellerPoint = (vPropellerUv - 0.5) * 2.0;
          float propellerRadius = length(propellerPoint);
          float innerFeather = smoothstep(0.25, 0.39, propellerRadius);
          float outerFeather = 1.0 - smoothstep(0.66, 1.0, propellerRadius);
          float wisps = 0.5 + 0.5 * sin(atan(propellerPoint.y, propellerPoint.x) * 9.0 + propellerRadius * 25.0);
          diffuseColor.a *= innerFeather * outerFeather * (0.15 + 0.23 * wisps);
        `);
    };
    this.blur.customProgramCacheKey = () => 'cropper-soft-propeller-blur-v1';
    try {
      const saved = globalThis.localStorage?.getItem(PAINT_STORAGE_KEY);
      if (saved && /^#[0-9a-f]{6}$/i.test(saved)) this.applyPaint(saved);
    } catch { /* Storage can be unavailable in privacy-restricted contexts. */ }
  }

  get paintColor(): string { return this.currentColor; }

  setPaintColor(hex: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    this.applyPaint(hex);
    try { globalThis.localStorage?.setItem(PAINT_STORAGE_KEY, this.currentColor); } catch { /* Painting remains available without storage. */ }
  }

  private applyPaint(hex: string): void {
    this.currentColor = hex.toLowerCase();
    this.primary.color.set(this.currentColor);
    if (this.currentColor === '#ed870c') {
      this.highlight.color.set('#ff9f1c');
      this.sheen.color.set('#ffc05f');
    } else {
      this.highlight.color.copy(this.primary.color).lerp(new THREE.Color('#ffffff'), 0.18);
      this.sheen.color.copy(this.primary.color).lerp(new THREE.Color('#ffffff'), 0.40);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const value of Object.values(this)) if (value instanceof THREE.Material) value.dispose();
  }
}
