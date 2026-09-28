import * as THREE from 'three';

/** Same native depth for directional shadow cameras, without a redundant write
 * to gl_FragDepth that prevents early depth rejection on dense overlapping meshes.
 * Perspective beauty rendering retains logarithmic depth and all its precision.
 */
export function createOrthographicShadowDepth(): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial();
  material.name = 'Exact orthographic shadow depth';
  material.onBeforeCompile = shader => {
    const include = '#include <logdepthbuf_fragment>';
    if (!shader.fragmentShader.includes(include)) throw new Error('Review orthographic shadow shader integration after the Three.js update');
    shader.fragmentShader = shader.fragmentShader.replace(include, '');
  };
  material.customProgramCacheKey = () => 'exact-orthographic-shadow-depth-v1';
  return material;
}

export function supportsOrthographicShadowDepth(source: THREE.Mesh): boolean {
  if (source.customDepthMaterial) return false;
  const materials = Array.isArray(source.material) ? source.material : [source.material];
  return materials.every(material => {
    const surface = material as THREE.MeshStandardMaterial;
    return !material.transparent && material.opacity === 1 && material.alphaTest === 0 &&
      !material.alphaHash && !material.alphaToCoverage && !material.clippingPlanes?.length &&
      !surface.displacementMap && !surface.alphaMap && !surface.map;
  });
}
