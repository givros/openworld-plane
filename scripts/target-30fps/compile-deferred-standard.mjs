// CPU-only node-code generation: no canvas, browser, device, or GPU allocation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as THREE from 'three/src/Three.WebGPU.js';
import { context, uniform, texture } from 'three/src/nodes/TSL.js';
import WGSLNodeBuilder from 'three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js';
import StandardNodeLibrary from 'three/src/renderers/webgpu/nodes/StandardNodeLibrary.js';
import LightsNode from 'three/src/nodes/lighting/LightsNode.js';
import { DeferredStandardMaterial, normalFromHitGradients } from './deferred-standard-material.mjs';

const destination = path.resolve('artifacts/four-horizons/target-30fps/deferred-shading');
fs.mkdirSync(destination, { recursive: true });
const hit = {
  positionView: uniform(new THREE.Vector3(11, 23, -127)).setName('hitPositionView'),
  positionWorld: uniform(new THREE.Vector3(101, 63, -527)).setName('hitPositionWorld'),
  normalView: uniform(new THREE.Vector3(0, 0.8, 0.6)).setName('hitNormalView'),
  color: uniform(new THREE.Color(0.7, 0.4, 0.2)).setName('hitColor'),
  roughness: uniform(0.65).setName('hitRoughness'),
  geometryRoughness: uniform(0.013).setName('hitGeometryRoughness'),
  metalness: uniform(0.15).setName('hitMetalness'),
  uv: uniform(new THREE.Vector2(0.25, 0.75)).setName('hitUV'),
  depth: uniform(0.72).setName('hitDepth'),
};
const normalMap = new THREE.DataTexture(new Uint8Array([128,128,255,255]), 1, 1);
normalMap.minFilter = normalMap.magFilter = THREE.LinearFilter;
const uvDx = uniform(new THREE.Vector2(0.013, 0.001)).setName('sameTriangleUvDx');
const uvDy = uniform(new THREE.Vector2(0.002, 0.017)).setName('sameTriangleUvDy');
const originalNormal = hit.normalView;
hit.normalView = normalFromHitGradients({
  normal: originalNormal,
  positionDx: uniform(new THREE.Vector3(0.2,0,0)).setName('sameTrianglePositionDx'),
  positionDy: uniform(new THREE.Vector3(0,0.3,0)).setName('sameTrianglePositionDy'),
  uvDx, uvDy,
  sampledNormal: texture(normalMap, hit.uv).grad(uvDx, uvDy),
  normalScale: uniform(new THREE.Vector2(0.4,0.4)).setName('sourceNormalScale'),
  frameSign: uniform(1).setName('sourceFaceDirection'),
});
const material = new DeferredStandardMaterial(hit);
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
const camera = new THREE.PerspectiveCamera(50, 1.6, 0.15, 16000);
const scene = new THREE.Scene();
const lights = [
  new THREE.AmbientLight('#ffe9d0', 0.08),
  new THREE.HemisphereLight('#c6e6f8', '#657158', 0.72),
  new THREE.DirectionalLight('#fff0c8', 2.6),
  new THREE.DirectionalLight('#c5e4f7', 0.24),
  new THREE.DirectionalLight('#ffd49a', 0.18),
];
scene.add(mesh, ...lights);
// Shape-only PMREM placeholder; no texels are sampled during CPU code generation.
const pmrem = new THREE.DataTexture(null, 768, 1024, THREE.RGBAFormat, THREE.HalfFloatType);
pmrem.isPMREMTexture = true;
pmrem.mapping = THREE.CubeUVReflectionMapping;
pmrem.minFilter = THREE.LinearFilter;
pmrem.magFilter = THREE.LinearFilter;
scene.environment = pmrem;
scene.environmentIntensity = 0.22;
scene.updateMatrixWorld(true);
const renderer = {
  library: new StandardNodeLibrary(), contextNode: context(),
  getRenderTarget: () => null, getMRT: () => null,
  getOutputRenderTarget: () => null,
  lighting: { createNode: nodes => new LightsNode().setLights(nodes) },
  shadowMap: { enabled: false }, depth: true,
  coordinateSystem: THREE.WebGPUCoordinateSystem,
  logarithmicDepthBuffer: false, reversedDepthBuffer: false,
  hasFeature: () => false, hasCompatibility: () => true,
  backend: {
    compatibilityMode: false,
    capabilities: { getUniformBufferLimit: () => 65536 },
    utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
  },
};

const builder = new WGSLNodeBuilder(mesh, renderer);
builder.camera = camera;
builder.scene = scene;
builder.lightsNode = new LightsNode().setLights(lights);
builder.environmentNode = texture(pmrem);
builder.build();
const shader = builder.fragmentShader;
fs.writeFileSync(path.join(destination, 'resolve.vert.wgsl'), builder.vertexShader);
fs.writeFileSync(path.join(destination, 'resolve.frag.wgsl'), shader);
assert.match(shader, /positionView = .*hitPositionView/);
assert.match(shader, /positionViewDirection = normalize\( \( - .*hitPositionView/);
assert.match(shader, /hitNormalView/);
assert.match(shader, /hitGeometryRoughness/);
assert.match(shader, /BRDF|Schlick|GGX/);
assert.match(shader, /roughnessToMip/);
assert.match(shader, /textureSampleGrad/);
assert.match(shader, /sameTriangleUvDx/);
assert.match(shader, /sameTriangleUvDy/);
assert.match(shader, /sourceNormalScale/);
assert.ok(shader.indexOf('positionView = ') < shader.indexOf('DiffuseColor = '));
assert.ok(!shader.includes('dpdx(') && !shader.includes('dpdy('));
fs.writeFileSync(path.join(destination, 'resolve.vert.wgsl'), builder.vertexShader);
fs.writeFileSync(path.join(destination, 'resolve.frag.wgsl'), shader);
const report = {
  generatedAt: new Date().toISOString(), threeRevision: THREE.REVISION,
  status: 'CPU_NODE_GENERATION_ONLY', gpuUsed: false,
  stockPhysicalLightingModel: true, stockEnvironmentNode: true, explicitNormalMapGradients: true,
  lightKinds: lights.map(light => light.type),
  assertions: ['hit view position precedes lighting', 'hit view direction precedes lighting', 'hit normal input', 'source-triangle geometric roughness input', 'stock physical BRDF emitted', 'stock PMREM lookup emitted', 'normal-map sampling uses supplied source-triangle gradients and normal scale', 'no cross-hit implicit derivatives'],
  fragmentSha256: crypto.createHash('sha256').update(shader).digest('hex'),
  limitations: ['WGSL has not been validated by a GPU driver', 'fixture uses uniform hit/gradient data and shape-only PMREM, not actual scene data', 'actual triangle-gradient reconstruction, custom CSM, encoded-space atmosphere, multisample visibility and original-raster comparison remain required'],
};
fs.writeFileSync(path.join(destination, 'compile-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
