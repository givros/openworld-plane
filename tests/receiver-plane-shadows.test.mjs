import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ShaderChunk } from 'three';
import { CSMShader } from 'three/addons/csm/CSMShader.js';
import { installReceiverPlaneShadows, setReceiverPlaneCascadeSelection } from '../src/systems/ReceiverPlaneShadows.ts';

function withInstalledShadows(run){
  const pars=ShaderChunk.shadowmap_pars_fragment,lights=ShaderChunk.lights_fragment_begin;
  try{
    ShaderChunk.lights_fragment_begin=CSMShader.lights_fragment_begin;
    installReceiverPlaneShadows();
    run();
  }finally{
    ShaderChunk.shadowmap_pars_fragment=pars;ShaderChunk.lights_fragment_begin=lights;
  }
}

test('cascade sampling locals keep independent scopes through the installed Three shader unroller',()=>{
  withInstalledShadows(()=>{
    // Exercise the actual installed compiler transformation. Its loop removal
    // caused duplicate declarations and missing materials in an earlier trial.
    const program=readFileSync(new URL('../node_modules/three/src/renderers/webgl/WebGLProgram.js',import.meta.url),'utf8');
    const implementation=program.slice(program.indexOf('const unrollLoopPattern ='),program.indexOf('//\n\nfunction generatePrecision'));
    assert.ok(implementation.startsWith('const unrollLoopPattern ='));
    const unroll=vm.runInNewContext(implementation+'\nunrollLoops');
    const shader=unroll(ShaderChunk.lights_fragment_begin.replaceAll('NUM_DIR_LIGHT_SHADOWS','4').replaceAll('NUM_DIR_LIGHTS','4'));
    const declarations=[...shader.matchAll(/bool cropperSampleCascade = receiveShadow;/g)];
    assert.equal(declarations.length,4);
    let nextScope=0;const scopes=[nextScope],declared=new Set();
    for(const token of shader.matchAll(/[{}]|bool cropperSampleCascade = receiveShadow;/g)){
      if(token[0]==='{')scopes.push(++nextScope);
      else if(token[0]==='}')scopes.pop();
      else{
        assert.ok(scopes.length>1,'A sampled cascade must keep its own braces after unrolling');
        assert.ok(!declared.has(scopes.at(-1)),'Cascade local is redefined in an existing scope');
        declared.add(scopes.at(-1));
      }
    }
    assert.equal(declared.size,4);
    const derivativeEnd=shader.indexOf('cropperShadowGradient[ 3 ] = cropperReceiverPlaneGradient');
    const firstSelection=shader.indexOf('bool cropperSampleCascade');
    assert.ok(derivativeEnd>=0&&derivativeEnd<firstSelection,'All gradients precede the first divergent sample');
  });
});

test('cascade-selection fallback changes only a compile-time directive and installation is idempotent',()=>{
  withInstalledShadows(()=>{
    setReceiverPlaneCascadeSelection(false);
    const baseline=ShaderChunk.lights_fragment_begin,pcf=ShaderChunk.shadowmap_pars_fragment;
    setReceiverPlaneCascadeSelection(true);
    assert.equal(ShaderChunk.lights_fragment_begin,baseline.replace('#define CROPPER_SELECT_CONTRIBUTING_CASCADES 0','#define CROPPER_SELECT_CONTRIBUTING_CASCADES 1'));
    assert.equal(ShaderChunk.shadowmap_pars_fragment,pcf,'PCF kernel is unchanged');
    installReceiverPlaneShadows();
    assert.ok(ShaderChunk.lights_fragment_begin.includes('#define CROPPER_SELECT_CONTRIBUTING_CASCADES 1'));
    setReceiverPlaneCascadeSelection(false);
    assert.equal(ShaderChunk.lights_fragment_begin,baseline);
  });
});

test('all three CSM directional shadow sites use the same resolved visibility',()=>{
  withInstalledShadows(()=>{
    const shader=ShaderChunk.lights_fragment_begin;
    assert.equal([...shader.matchAll(/CROPPER_DIRECTIONAL_SHADOW\( directionalShadowMap\[ i \]/g)].length,3);
    const kernel=ShaderChunk.shadowmap_pars_fragment.match(/float cropperReceiverPlaneShadow\([\s\S]*?\n}/)?.[0];
    assert.ok(kernel);
    assert.equal([...kernel.matchAll(/vogelDiskSample\( [0-4], 5, phi \) \* radius/g)].length,5);
    assert.equal([...ShaderChunk.shadowmap_pars_fragment.matchAll(/textureGrad\( shadowMap, vec3\( uv[01][01], receiver.z/g)].length,4);
  });
});

test('reversed receiver depth preserves the bias direction and far-plane rejection',()=>{
 withInstalledShadows(()=>{
  const kernel=ShaderChunk.shadowmap_pars_fragment.match(/float cropperReceiverPlaneShadow\([\s\S]*?\n}/)?.[0];
  assert.match(kernel,/#ifdef USE_REVERSED_DEPTH_BUFFER\s+shadowCoord\.z -= shadowBias;\s+bool insideFarPlane = shadowCoord\.z >= 0\.0;\s+#else\s+shadowCoord\.z \+= shadowBias;\s+bool insideFarPlane = shadowCoord\.z <= 1\.0;/);
  // Reflection z -> 1-z must keep the same plane sample and lit/shadow test.
  for(const z of [-.2,0,.3,1,1.2])for(const bias of [-.001,0,.001])for(const planeOffset of [-.02,0,.02]){
   const depth=z+bias+planeOffset,reversedDepth=1-z-bias-planeOffset;
   assert.ok(Math.abs(depth+reversedDepth-1)<1e-12);
   for(const stored of [.1,.5,.9])assert.equal(depth<=stored,reversedDepth>=1-stored);
   assert.equal(z+bias<=1,1-z-bias>=0);
  }
 });
});
