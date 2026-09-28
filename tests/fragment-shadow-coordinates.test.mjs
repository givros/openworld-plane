import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ShaderChunk, Matrix4, Vector3, Vector4 } from 'three';
import { CSMShader } from 'three/addons/csm/CSMShader.js';
import { installReceiverPlaneShadows, setReceiverPlaneCascadeSelection } from '../src/systems/ReceiverPlaneShadows.ts';
import { installFragmentShadowCoordinates } from '../src/systems/FragmentShadowCoordinates.ts';

const keys = ['shadowmap_pars_vertex', 'shadowmap_vertex', 'shadowmap_pars_fragment', 'lights_fragment_begin', 'shadowmask_pars_fragment'];
const snapshot = () => Object.fromEntries(keys.map(key => [key, ShaderChunk[key]]));
function withShaders(run) {
  const original = snapshot();
  try {
    ShaderChunk.lights_fragment_begin = CSMShader.lights_fragment_begin;
    installReceiverPlaneShadows();
    run();
  } finally { Object.assign(ShaderChunk, original); }
}

test('fragment coordinate installation is opt-in, guarded and idempotent', () => {
  withShaders(() => {
    assert.ok(ShaderChunk.shadowmap_pars_vertex.includes('varying vec4 vDirectionalShadowCoord'));
    installFragmentShadowCoordinates();
    const installed = snapshot();
    installFragmentShadowCoordinates();
    assert.deepEqual(snapshot(), installed);
    assert.ok(!ShaderChunk.shadowmap_pars_vertex.includes('varying vec4 vDirectionalShadowCoord'));
    assert.ok(!ShaderChunk.shadowmap_vertex.includes('directionalShadowMatrix[ i ] * shadowWorldPosition'));
    assert.ok(ShaderChunk.shadowmap_vertex.includes('vCropperShadowWorldNormal = shadowWorldNormal;'));
    assert.ok(ShaderChunk.shadowmap_pars_fragment.includes('uniform mat4 directionalShadowMatrix'));
    assert.ok(!/normalize\s*\(\s*vCropperShadowWorldNormal/.test(ShaderChunk.shadowmap_pars_fragment));
  });
});

test('all four coordinates are prepared before PCF derivatives and fallback directional sampling', () => {
  withShaders(() => {
    installFragmentShadowCoordinates();
    const lights = ShaderChunk.lights_fragment_begin;
    assert.ok(lights.indexOf('cropperPrepareDirectionalShadowCoordinates();') < lights.indexOf('cropperShadowGradient[ i ] ='));
    assert.ok(lights.indexOf('cropperPrepareDirectionalShadowCoordinates();') < lights.indexOf('CROPPER_DIRECTIONAL_SHADOW( directionalShadowMap'));
    setReceiverPlaneCascadeSelection(false);
    assert.ok(ShaderChunk.lights_fragment_begin.includes('cropperPrepareDirectionalShadowCoordinates();'));
    const program = readFileSync(new URL('../node_modules/three/src/renderers/webgl/WebGLProgram.js', import.meta.url), 'utf8');
    const implementation = program.slice(program.indexOf('const unrollLoopPattern ='), program.indexOf('//\n\nfunction generatePrecision'));
    assert.ok(implementation.startsWith('const unrollLoopPattern ='));
    const unroll = vm.runInNewContext(implementation + '\nunrollLoops');
    const shader = unroll(ShaderChunk.shadowmap_pars_fragment.replaceAll('NUM_DIR_LIGHT_SHADOWS', '4'));
    for (let i = 0; i < 4; i++) assert.ok(shader.includes(`vDirectionalShadowCoord[ ${i} ] = directionalShadowMatrix[ ${i} ] *`));
    assert.ok(!shader.includes('vDirectionalShadowCoord[ i ] ='));
  });
});

test('spot and point shadow paths remain native and ShadowMaterial also prepares directional coordinates', () => {
  withShaders(() => {
    const vertex = ShaderChunk.shadowmap_vertex;
    const point = vertex.slice(vertex.indexOf('#if NUM_POINT_LIGHT_SHADOWS > 0'));
    const spot = vertex.slice(vertex.indexOf('// spot lights can be evaluated'));
    installFragmentShadowCoordinates();
    assert.ok(ShaderChunk.shadowmap_vertex.endsWith(spot));
    assert.equal(ShaderChunk.shadowmap_vertex.slice(ShaderChunk.shadowmap_vertex.indexOf('#if NUM_POINT_LIGHT_SHADOWS > 0')), point);
    const mask = ShaderChunk.shadowmask_pars_fragment;
    assert.ok(mask.indexOf('cropperPrepareDirectionalShadowCoordinates();') > mask.indexOf('float getShadowMask()'));
    assert.ok(mask.indexOf('cropperPrepareDirectionalShadowCoordinates();') < mask.indexOf('getShadow( directionalShadowMap'));
  });
});

test('a replacement mismatch fails atomically and a fresh CSM lighting chunk can be reattached', () => {
  withShaders(() => {
    ShaderChunk.shadowmask_pars_fragment = 'changed upstream signature';
    const before = snapshot();
    assert.throws(installFragmentShadowCoordinates, /shadowmask_pars_fragment/);
    assert.deepEqual(snapshot(), before);
  });
  withShaders(() => {
    installFragmentShadowCoordinates();
    const vertex = ShaderChunk.shadowmap_vertex;
    ShaderChunk.lights_fragment_begin = CSMShader.lights_fragment_begin;
    installReceiverPlaneShadows();
    installFragmentShadowCoordinates();
    assert.equal(ShaderChunk.shadowmap_vertex, vertex);
    assert.equal(ShaderChunk.lights_fragment_begin.match(/cropperPrepareDirectionalShadowCoordinates\(\);/g).length, 1);
  });
});

test('biased affine shadow coordinates commute with perspective-correct interpolation without normal renormalization', () => {
  const positions = [new Vector3(1273, 18, -473), new Vector3(1275, 22, -468), new Vector3(1271, 20, -466)];
  const normals = [new Vector3(1, 2, 3).normalize(), new Vector3(-2, 4, 1).normalize(), new Vector3(2, 1, -1).normalize()];
  const barycentric = [.19, .34, .47], clipW = [13, 31, 57];
  const denominator = barycentric.reduce((sum, weight, i) => sum + weight / clipW[i], 0);
  const weights = barycentric.map((weight, i) => weight / clipW[i] / denominator);
  const interpolatedPosition = new Vector3(), interpolatedNormal = new Vector3();
  for (let i = 0; i < 3; i++) {
    interpolatedPosition.addScaledVector(positions[i], weights[i]);
    interpolatedNormal.addScaledVector(normals[i], weights[i]);
  }
  assert.ok(Math.abs(interpolatedNormal.length() - 1) > .05, 'The fixture detects accidental fragment normal renormalization');
  for (const bias of [.015, .05, .15, .45]) {
    const transform = new Matrix4().set(.002, .001, -.001, -1.2, -.001, .002, .001, .8, .0003, -.0002, .0004, .6, 0, 0, 0, 1);
    const original = new Vector4(0, 0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const point = positions[i].clone().addScaledVector(normals[i], bias);
      original.add(new Vector4(point.x, point.y, point.z, 1).applyMatrix4(transform).multiplyScalar(weights[i]));
    }
    const point = interpolatedPosition.clone().addScaledVector(interpolatedNormal, bias);
    const moved = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(transform);
    assert.ok(original.sub(moved).length() < 1e-12);
  }
});
