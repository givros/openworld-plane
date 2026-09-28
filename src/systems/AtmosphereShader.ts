import { Color, ShaderChunk } from 'three';
const linear=(hex:string):string=>{const c=new Color(hex);return `vec3(${c.r.toFixed(7)},${c.g.toFixed(7)},${c.b.toFixed(7)})`;};
export const SKY_GLSL=`
vec3 cropperSkyRadiance(vec3 d){
  float h=d.y;
  vec3 horizon=${linear('#c4d9df')};
  vec3 c=mix(horizon,${linear('#82bfe3')},smoothstep(0.0,.35,h));
  c=mix(c,${linear('#3f86c3')},smoothstep(.3,1.0,h));
  c=mix(c,${linear('#e6d6ba')},smoothstep(0.0,.35,-h));
  float sunlight=max(0.0,dot(d,normalize(vec3(-.48,.58,-.65))));
  c=mix(c,${linear('#f4c58e')},pow(sunlight,8.0)*.22);
  c+=vec3(1.0,.77,.43)*pow(sunlight,96.0)*.22;
  c+=vec3(2.0,1.6,1.1)*smoothstep(.99955,.99985,sunlight);
  return c;
}`;
let installed=false;
/** The same sky radiance is used for distant terrain, props, windows and clouds. */
export function installAtmosphericFog():void {
  if(installed)return;installed=true;
  ShaderChunk.fog_pars_vertex=ShaderChunk.fog_pars_vertex.replace('varying float vFogDepth;','varying float vFogDepth;\nvarying vec3 vAtmosphereWorld;');
  ShaderChunk.fog_vertex=ShaderChunk.fog_vertex.replace('vFogDepth = - mvPosition.z;',`vFogDepth = -mvPosition.z;
    vec4 atmosphereLocal=vec4(transformed,1.0);
    #ifdef USE_INSTANCING
      atmosphereLocal=instanceMatrix*atmosphereLocal;
    #endif
    vAtmosphereWorld=(modelMatrix*atmosphereLocal).xyz;`);
  ShaderChunk.fog_pars_fragment=ShaderChunk.fog_pars_fragment.replace('varying float vFogDepth;',`varying float vFogDepth;\nvarying vec3 vAtmosphereWorld;\n${SKY_GLSL}`);
  ShaderChunk.fog_fragment=ShaderChunk.fog_fragment.replace('mix( gl_FragColor.rgb, fogColor, fogFactor )','mix(gl_FragColor.rgb, linearToOutputTexel(vec4(cropperSkyRadiance(normalize(vAtmosphereWorld-cameraPosition)),1.0)).rgb, fogFactor)');
  // Streaming uses a radial distance around the camera. Evaluate it per pixel
  // so large terrain/water triangles do not inherit distant-vertex fog, and
  // everything is fully faded before the same radial visibility boundary.
  ShaderChunk.fog_fragment=ShaderChunk.fog_fragment.replace('smoothstep( fogNear, fogFar, vFogDepth )','smoothstep( fogNear, fogFar, length(vAtmosphereWorld-cameraPosition) )');
}
