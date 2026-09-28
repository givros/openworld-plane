import { ShaderChunk } from 'three';

const marker='cropperReceiverPlaneGradient';
const cascadeSelectionDirective='#define CROPPER_SELECT_CONTRIBUTING_CASCADES 1';
const pcfFunctions=/* glsl */`
// Derivatives are evaluated before any cascade selection or shadow branch.
// Solve dz = gradient.x * du + gradient.y * dv on the receiver triangle.
vec2 cropperReceiverPlaneGradient( vec4 coordinate ) {
  vec3 p = coordinate.xyz / coordinate.w;
  vec3 dx = dFdx( p ), dy = dFdy( p );
  float determinant = dx.x * dy.y - dx.y * dy.x;
  if ( abs( determinant ) < 1e-18 ) return vec2( 0.0 );
  return vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / determinant;
}

float cropperReceiverPlaneTap( sampler2DShadow shadowMap, vec2 mapSize, vec3 receiver, vec2 gradient, vec2 offset ) {
  vec2 texelPosition = ( receiver.xy + offset ) * mapSize - 0.5;
  vec2 base = ( floor( texelPosition ) + 0.5 ) / mapSize;
  vec2 fraction = fract( texelPosition );
  vec2 stepSize = 1.0 / mapSize;
  vec2 lower = 0.5 * stepSize, upper = 1.0 - lower;
  // Match ClampToEdge before evaluating the plane, including the fade border.
  vec2 uv00 = clamp( base, lower, upper );
  vec2 uv10 = clamp( base + vec2( stepSize.x, 0.0 ), lower, upper );
  vec2 uv01 = clamp( base + vec2( 0.0, stepSize.y ), lower, upper );
  vec2 uv11 = clamp( base + stepSize, lower, upper );
  // Preserve Three's bilinear four-comparison PCF kernel, but compare each
  // texel against the receiver plane at that texel, not the center depth.
  // Sampling texel centers prevents hardware interpolation from reintroducing
  // slope acne. No broad slope bias or contact-shadow detachment is needed.
  float a = textureGrad( shadowMap, vec3( uv00, receiver.z + dot( gradient, uv00 - receiver.xy ) ), vec2( 0.0 ), vec2( 0.0 ) );
  float b = textureGrad( shadowMap, vec3( uv10, receiver.z + dot( gradient, uv10 - receiver.xy ) ), vec2( 0.0 ), vec2( 0.0 ) );
  float c = textureGrad( shadowMap, vec3( uv01, receiver.z + dot( gradient, uv01 - receiver.xy ) ), vec2( 0.0 ), vec2( 0.0 ) );
  float d = textureGrad( shadowMap, vec3( uv11, receiver.z + dot( gradient, uv11 - receiver.xy ) ), vec2( 0.0 ), vec2( 0.0 ) );
  return mix( mix( a, b, fraction.x ), mix( c, d, fraction.x ), fraction.y );
}

float cropperReceiverPlaneShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, vec2 gradient ) {
  shadowCoord.xyz /= shadowCoord.w;
  #ifdef USE_REVERSED_DEPTH_BUFFER
    shadowCoord.z -= shadowBias;
    bool insideFarPlane = shadowCoord.z >= 0.0;
  #else
    shadowCoord.z += shadowBias;
    bool insideFarPlane = shadowCoord.z <= 1.0;
  #endif
  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0 && insideFarPlane;
  if ( !inFrustum ) return 1.0;
  float radius = shadowRadius / shadowMapSize.x;
  float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
  float shadow = (
    cropperReceiverPlaneTap( shadowMap, shadowMapSize, shadowCoord.xyz, gradient, vogelDiskSample( 0, 5, phi ) * radius ) +
    cropperReceiverPlaneTap( shadowMap, shadowMapSize, shadowCoord.xyz, gradient, vogelDiskSample( 1, 5, phi ) * radius ) +
    cropperReceiverPlaneTap( shadowMap, shadowMapSize, shadowCoord.xyz, gradient, vogelDiskSample( 2, 5, phi ) * radius ) +
    cropperReceiverPlaneTap( shadowMap, shadowMapSize, shadowCoord.xyz, gradient, vogelDiskSample( 3, 5, phi ) * radius ) +
    cropperReceiverPlaneTap( shadowMap, shadowMapSize, shadowCoord.xyz, gradient, vogelDiskSample( 4, 5, phi ) * radius )
  ) * 0.2;
  return mix( 1.0, shadow, shadowIntensity );
}
`;

/** Change before material compilation; existing materials must be recompiled. */
export function setReceiverPlaneCascadeSelection(enabled:boolean):void {
  ShaderChunk.lights_fragment_begin=ShaderChunk.lights_fragment_begin.replace(
    /#define CROPPER_SELECT_CONTRIBUTING_CASCADES [01]/,
    `#define CROPPER_SELECT_CONTRIBUTING_CASCADES ${enabled?1:0}`,
  );
}

/** Keep the full CSM/PCF kernel while evaluating its receiver depth correctly. */
export function installReceiverPlaneShadows():void {
  const pars=ShaderChunk.shadowmap_pars_fragment;
  if(!pars.includes(marker)){
    const insert='\t#elif defined( SHADOWMAP_TYPE_VSM )';
    if(!pars.includes(insert))throw new Error('The PCF shadow shader changed; receiver-plane integration must be reviewed.');
    ShaderChunk.shadowmap_pars_fragment=pars.replace(insert,pcfFunctions+'\n'+insert);
  }
  const lights=ShaderChunk.lights_fragment_begin;
  if(lights.includes(marker))return;
  const expression=/getShadow\( directionalShadowMap\[ i \], ([^\n]*?), vDirectionalShadowCoord\[ i \] \)/g;
  let replacements=0;
  const corrected=lights.replace(expression,(_call,parameters:string)=>{
    replacements++;
    return `CROPPER_DIRECTIONAL_SHADOW( directionalShadowMap[ i ], ${parameters}, vDirectionalShadowCoord[ i ], cropperShadowVisibility[ i ] )`;
  });
  if(replacements!==3)throw new Error(`Expected three directional shadow sites, found ${replacements}; review the CSM shader integration.`);
  ShaderChunk.lights_fragment_begin=/* glsl */`
${cascadeSelectionDirective}
#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
  #if defined( SHADOWMAP_TYPE_PCF )
    #define CROPPER_DIRECTIONAL_SHADOW( map, size, intensity, bias, radius, coordinate, visibility ) visibility
    vec2 cropperShadowGradient[ NUM_DIR_LIGHT_SHADOWS ];
    float cropperShadowVisibility[ NUM_DIR_LIGHT_SHADOWS ];
    #if CROPPER_SELECT_CONTRIBUTING_CASCADES == 1
    // Derivatives must precede every potentially divergent sample, including
    // other cascades' frustum exits. The filtering itself uses explicit LOD.
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      cropperShadowGradient[ i ] = cropperReceiverPlaneGradient( vDirectionalShadowCoord[ i ] );
    }
    #pragma unroll_loop_end
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      {
        // Keep an explicit scope: Three strips the for-loop braces while
        // unrolling, otherwise these local declarations collide per cascade.
        bool cropperSampleCascade = receiveShadow;
        #if defined( USE_CSM ) && defined( CSM_CASCADES ) && ( UNROLLED_LOOP_INDEX < CSM_CASCADES )
          float cropperCandidateDepth = vViewPosition.z / ( shadowFar - cameraNear );
          vec2 cropperCandidateCascade = CSM_cascades[ i ];
          #if defined( CSM_FADE )
            float cropperCandidateCenter = ( cropperCandidateCascade.x + cropperCandidateCascade.y ) / 2.0;
            float cropperCandidateEdge = cropperCandidateDepth < cropperCandidateCenter ? cropperCandidateCascade.x : cropperCandidateCascade.y;
            float cropperCandidateMargin = 0.25 * pow( cropperCandidateEdge, 2.0 );
            cropperSampleCascade = cropperSampleCascade && cropperCandidateDepth >= cropperCandidateCascade.x - cropperCandidateMargin / 2.0 &&
              ( cropperCandidateDepth < cropperCandidateCascade.y + cropperCandidateMargin / 2.0 || UNROLLED_LOOP_INDEX == CSM_CASCADES - 1 );
          #else
            cropperSampleCascade = cropperSampleCascade && cropperCandidateDepth >= cropperCandidateCascade.x && cropperCandidateDepth < cropperCandidateCascade.y;
          #endif
        #endif
        cropperShadowVisibility[ i ] = 1.0;
        if ( cropperSampleCascade ) {
          cropperShadowVisibility[ i ] = cropperReceiverPlaneShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity, directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ], cropperShadowGradient[ i ] );
        }
      }
    }
    #pragma unroll_loop_end
    #else
    // Retain the original path for controlled comparisons and fallback.
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      cropperShadowGradient[ i ] = cropperReceiverPlaneGradient( vDirectionalShadowCoord[ i ] );
      cropperShadowVisibility[ i ] = cropperReceiverPlaneShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity, directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ], cropperShadowGradient[ i ] );
    }
    #pragma unroll_loop_end
    #endif
  #else
    #define CROPPER_DIRECTIONAL_SHADOW( map, size, intensity, bias, radius, coordinate, gradient ) getShadow( map, size, intensity, bias, radius, coordinate )
  #endif
#endif
`+corrected+'\n#undef CROPPER_DIRECTIONAL_SHADOW\n';
}
