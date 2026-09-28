import { ShaderChunk } from 'three';

const prepareFunction = 'cropperPrepareDirectionalShadowCoordinates';
const prepareCall = `${prepareFunction}();`;
const directionalVarying = 'varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];';
const compactVaryings = `varying vec3 vCropperShadowWorldPosition;
varying vec3 vCropperShadowWorldNormal;`;
const directionalUniforms = 'uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];';
const vertexCoordinates = `#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {

			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;

		}
		#pragma unroll_loop_end`.replace(/\n[ \t]*\n/g, '\n');
const vertexPreparation = `vCropperShadowWorldPosition = worldPosition.xyz;
		vCropperShadowWorldNormal = shadowWorldNormal;`;
const fragmentPreparation = /* glsl */`

// Affine shadow transforms commute with perspective-correct interpolation.
// The normal was normalized at each vertex by inverseTransformDirection.
// Normalizing it again here would change the authored normal-bias interpolation.
void ${prepareFunction}() {
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] *
      vec4( vCropperShadowWorldPosition + vCropperShadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 1.0 );
  }
  #pragma unroll_loop_end
}
`;
const guardedPreparation = /* glsl */`
#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
  ${prepareCall}
#endif
`;

function replaceOnce(source: string, expected: string, replacement: string, chunk: string): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Review fragment shadow coordinates after the Three.js update (${chunk}).`);
  }
  return source.replace(expected, replacement);
}

/**
 * Opt-in experiment for dense exact-geometry scenes. Install after CSM and the
 * receiver-plane filter, before material compilation. The original normal bias,
 * shadow maps and filtering stay unchanged; only affine coordinate transforms
 * move from every vertex to every fragment. Spot and point coordinates are native.
 */
export function installFragmentShadowCoordinates(): void {
  let vertexPars = ShaderChunk.shadowmap_pars_vertex;
  let vertex = ShaderChunk.shadowmap_vertex;
  let fragmentPars = ShaderChunk.shadowmap_pars_fragment;
  let lights = ShaderChunk.lights_fragment_begin;
  let mask = ShaderChunk.shadowmask_pars_fragment;

  if (!fragmentPars.includes(`void ${prepareFunction}()`)) {
    vertexPars = replaceOnce(vertexPars, directionalVarying, compactVaryings, 'shadowmap_pars_vertex');
    vertex = replaceOnce(vertex, vertexCoordinates, vertexPreparation, 'shadowmap_vertex');
    fragmentPars = replaceOnce(fragmentPars, directionalVarying,
      `${compactVaryings}\nuniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];\nvec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];`,
      'shadowmap_pars_fragment');
    fragmentPars = replaceOnce(fragmentPars, directionalUniforms,
      directionalUniforms + fragmentPreparation, 'directional shadow uniforms');
  } else if (!vertexPars.includes(compactVaryings) || !vertex.includes(vertexPreparation)) {
    throw new Error('Fragment shadow coordinates are only partially installed; review shader integration.');
  }

  // CSM may replace this chunk when a fresh atmosphere is constructed. Reapply
  // the call without wrapping its derivatives in a cascade-dependent branch.
  if (!lights.includes(prepareCall)) lights = guardedPreparation + lights;
  // ShadowMaterial uses getShadowMask instead of lights_fragment_begin.
  if (!mask.includes(prepareCall)) mask = replaceOnce(mask,
    'float getShadowMask() {', `float getShadowMask() {\n${guardedPreparation}`, 'shadowmask_pars_fragment');

  // Commit only once every replacement has been validated.
  ShaderChunk.shadowmap_pars_vertex = vertexPars;
  ShaderChunk.shadowmap_vertex = vertex;
  ShaderChunk.shadowmap_pars_fragment = fragmentPars;
  ShaderChunk.lights_fragment_begin = lights;
  ShaderChunk.shadowmask_pars_fragment = mask;
}
