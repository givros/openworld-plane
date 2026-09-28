import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { installAtmosphericFog } from '../src/systems/AtmosphereShader.ts';
import { OriginalTriangleAtlas, VisibleTriangleRasterAdapter, packedTextureShape, assembleVisibleTriangleShader } from '../src/experiments/VisibleTriangleRasterAdapter.ts';

function fixture({ triangles = 2, mirrored = false, instanced = true, colors = false, pages = false } = {}) {
  const positions = new Float32Array([-.25, -0, 0, 1.125, .25, .5, .375, 1.75, -.75]);
  const normal = new Float32Array([.6, .8, 0, 0, .6, .8, .8, 0, .6]);
  const indices = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) indices.set(t % 2 ? [2, 1, 0] : [0, 1, 2], t * 3);
  const matrix = new T.Matrix4().makeRotationY(.73).scale(new T.Vector3(1.3, .85, 1.9)).setPosition(12, 3, -7);
  if (mirrored) matrix.scale(new T.Vector3(-1, 1, 1));
  // Nonuniform rotated ancestor creates model shear. Native source.normalMatrix handles this.
  const model = new T.Matrix4().makeScale(2, 3, .7).multiply(matrix);
  const local = instanced ? new T.Matrix4().makeRotationZ(.29).scale(new T.Vector3(.65, 2, 1.8)).setPosition(2, -1, 3) : new T.Matrix4();
  const g = { vertexOffset: 0, vertexCount: 3, triangleOffset: 0, triangleCount: triangles, normal: { array: normal, itemSize: 3 } };
  if (colors) {
    g.uv = { array: new Float32Array([0, .25, .5, .75, 1, 1.125]), itemSize: 2 };
    g.color = { array: new Uint8Array([0, 255, 128, 255, 23, 45, 67, 89, 255, 254, 253, 252]), itemSize: 4, normalized: true };
    g.tangent = { array: new Float32Array([1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1]), itemSize: 4 };
  }
  const input = { positions, triangles: indices, geometries: [g], batches: [{ matrixWorld: model, instanced }], instances: [{ geometry: 0, batch: 0, material: 17, matrix: new Float32Array(local.elements) }], maxTextureSize: pages ? 4 : 16384, maxFloatPageBytes: pages ? 64 : undefined };
  const atlas = new OriginalTriangleAtlas(input), camera = new T.PerspectiveCamera(48, 1.6, .25, 5000);
  camera.position.set(13, 7, 24); camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
  atlas.prepareView(camera);
  return { input, atlas, camera, model, local, source: new T.MeshStandardMaterial({ vertexColors: colors }), options: { materialId: 17, capacity: 16, instanced, mirroredBatch: mirrored, vertexColorSize: colors ? 4 : 0, tangents: colors } };
}
function shader() { return { uniforms: T.UniformsUtils.clone(T.ShaderLib.standard.uniforms), vertexShader: T.ShaderLib.standard.vertexShader, fragmentShader: T.ShaderLib.standard.fragmentShader }; }
function resolveChunks(source) { return source.replace(/#include <([\w\d_]+)>/g, (_, name) => { assert.equal(typeof T.ShaderChunk[name], 'string', name); return resolveChunks(T.ShaderChunk[name]); }); }
function close(f, adapter) { adapter?.dispose(); f.atlas.dispose(); f.source.dispose(); }
function readScalar(atlas, offset) { return atlas.floatTextures[Math.floor(offset / atlas.floatPageScalars)].image.data[offset % atlas.floatPageScalars]; }

test('lossless sparse attributes cross Float32 page boundaries without changing original arrays', () => {
  const f = fixture({ pages: true, triangles: 1 });
  assert.equal(f.atlas.floatTextures.length, 3);
  for (const texture of f.atlas.floatTextures) {
    assert.ok(texture.image.data.byteLength <= 64);
    assert.equal(texture.internalFormat, 'RGBA32F'); assert.equal(texture.colorSpace, T.NoColorSpace);
    assert.equal(texture.minFilter, T.NearestFilter); assert.equal(texture.generateMipmaps, false);
  }
  for (let i = 0; i < f.input.positions.length; i++) assert.ok(Object.is(readScalar(f.atlas, i), f.input.positions[i]));
  const ref = f.atlas.reference(0, 0, 2);
  assert.deepEqual(ref.position.toArray(), Array.from(f.input.positions.subarray(6, 9)));
  const before = new Uint8Array(f.input.positions.buffer).slice();
  f.atlas.prepareView(f.camera);
  assert.deepEqual(new Uint8Array(f.input.positions.buffer), before);
  close(f);
});

test('canonical native model, instance and normal factors stay separate under nonuniform ancestor transforms', () => {
  const f = fixture(), reference = f.atlas.reference(0, 0, 0);
  const batch = f.atlas.batchTexture.image.data;
  const mv = new T.Matrix4().multiplyMatrices(f.camera.matrixWorldInverse, f.model), n = new T.Matrix3().getNormalMatrix(mv);
  assert.deepEqual(Array.from(batch.subarray(0, 16)), Array.from(new Float32Array(f.model.elements)));
  assert.deepEqual(Array.from(batch.subarray(16, 32)), Array.from(new Float32Array(mv.elements)));
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) assert.equal(batch[32 + c * 4 + r], Math.fround(n.elements[c * 3 + r]));
  const local = new T.Matrix4().fromArray(f.input.instances[0].matrix), e = local.elements;
  const expected = reference.normal.clone().divide(new T.Vector3(e[0] ** 2 + e[1] ** 2 + e[2] ** 2, e[4] ** 2 + e[5] ** 2 + e[6] ** 2, e[8] ** 2 + e[9] ** 2 + e[10] ** 2)).applyMatrix3(new T.Matrix3().setFromMatrix4(local));
  const uploadedNormal = new T.Matrix3();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) uploadedNormal.elements[c * 3 + r] = batch[32 + c * 4 + r];
  expected.applyMatrix3(uploadedNormal).normalize();
  assert.ok(reference.viewNormal.distanceTo(expected) < 1e-14);
  const position = reference.position.clone().applyMatrix4(local).applyMatrix4(new T.Matrix4().fromArray(batch, 16));
  assert.ok(reference.viewPosition.distanceTo(position) < 1e-14);
  assert.equal(f.atlas.prepareView(f.camera), false);
  f.camera.position.x += 1; f.camera.updateMatrixWorld(true);
  assert.equal(f.atlas.prepareView(f.camera), true);
  const revision = f.atlas.batchTexture.version;
  f.atlas.setBatchMatrix(0, f.model.clone().setPosition(1, 2, 3));
  assert.throws(() => f.atlas.assertPrepared(), /prepareView/);
  f.atlas.prepareView(f.camera); assert.equal(f.atlas.batchTexture.version, revision + 1);
  close(f);
});

test('normalized source colors preserve native Float32 shader values; absent UV streams remain sparse', () => {
  const f = fixture({ colors: true }), words = f.atlas.integerTexture.image.data;
  const g = f.atlas.geometryOffset * 4, color = words[g + 3];
  for (let i = 0; i < 12; i++) assert.equal(readScalar(f.atlas, color + i), Math.fround(f.input.geometries[0].color.array[i] / 255));
  assert.equal(words[g + 5], 0xffffffff); assert.equal(words[g + 6], 0xffffffff); assert.equal(words[g + 7], 0xffffffff);
  close(f);
});

test('references retain integer identity, reject duplicate or unrelated triangles atomically', () => {
  const f = fixture(), adapter = new VisibleTriangleRasterAdapter(f.atlas, f.source, f.options);
  adapter.setVisibleReferences(new Uint32Array([0, 1, 0, 0]));
  assert.deepEqual(adapter.identityAt(0), { instanceId: 0, triangleId: 1 });
  assert.equal(adapter.references.gpuType, T.IntType); assert.equal(adapter.mesh.geometry.instanceCount, 2);
  const before = adapter.references.array.slice();
  assert.throws(() => adapter.setVisibleReferences(new Uint32Array([0, 0, 0, 0])), /Duplicate/);
  assert.deepEqual(adapter.references.array, before); assert.equal(adapter.mesh.geometry.instanceCount, 2);
  assert.throws(() => adapter.setVisibleReferences(new Uint32Array([0, 2])), /outside/);
  adapter.setVisibleReferences(new Uint32Array()); assert.equal(adapter.mesh.geometry.instanceCount, 0);
  close(f, adapter);
});

test('1/8/32/64 blocks retain every original triangle and degenerate only out-of-range tail', () => {
  for (const block of [1, 8, 32, 64]) {
    const f = fixture({ triangles: 67 }), adapter = new VisibleTriangleRasterAdapter(f.atlas, f.source, { ...f.options, capacity: 67, trianglesPerReference: block });
    const pairs = new Uint32Array(Math.ceil(67 / block) * 2);
    for (let i = 0; i < pairs.length / 2; i++) pairs[i * 2 + 1] = i * block;
    adapter.setVisibleReferences(pairs);
    assert.equal(adapter.mesh.geometry.drawRange.count, block * 3);
    const original = new Set(); let padding = 0;
    for (let i = 0; i < pairs.length / 2; i++) for (let local = 0; local < block; local++) {
      const triangle = pairs[i * 2 + 1] + local;
      if (triangle < 67) {
        for (let c = 0; c < 3; c++) assert.equal(f.atlas.reference(0, triangle, c).vertexId, f.input.triangles[triangle * 3 + c]);
        original.add(triangle);
      } else {
        const a = f.atlas.reference(0, 66, 0), b = f.atlas.reference(0, 66, 0), c = f.atlas.reference(0, 66, 0);
        assert.equal(a.worldPosition.distanceTo(b.worldPosition), 0); assert.equal(b.worldPosition.distanceTo(c.worldPosition), 0); padding++;
      }
    }
    assert.equal(original.size, 67); assert.equal(padding, Math.ceil(67 / block) * block - 67);
    if (block > 1) assert.throws(() => adapter.setVisibleReferences(new Uint32Array([0, 1])), /not aligned/);
    close(f, adapter);
  }
});

test('material, winding and native shader signatures cannot be mixed in one draw', () => {
  const f = fixture({ mirrored: true }), wrong = new VisibleTriangleRasterAdapter(f.atlas, f.source, { ...f.options, mirroredBatch: false });
  assert.throws(() => wrong.setVisibleReferences(new Uint32Array([0, 0])), /winding/); wrong.dispose();
  const adapter = new VisibleTriangleRasterAdapter(f.atlas, f.source, f.options);
  adapter.setVisibleReferences(new Uint32Array([0, 0]));
  assert.ok(adapter.mesh.matrixWorld.determinant() < 0);
  assert.equal(adapter.mesh.frustumCulled, false); assert.equal(adapter.mesh.castShadow, false); assert.equal(adapter.mesh.receiveShadow, true);
  assert.throws(() => adapter.mesh.raycast(), /canonical/);
  close(f, adapter);
});

test('ordinary Mesh retains its native no-instancing normal path', () => {
  const f = fixture({ instanced: false }), adapter = new VisibleTriangleRasterAdapter(f.atlas, f.source, f.options), built = shader();
  adapter.setVisibleReferences(new Uint32Array([0, 1])); assembleVisibleTriangleShader(adapter, built);
  assert.doesNotMatch(built.vertexShader, /#define USE_INSTANCING\n/);
  const position = f.atlas.reference(0, 1, 0).position.clone().applyMatrix4(new T.Matrix4().fromArray(f.atlas.batchTexture.image.data, 16));
  assert.ok(position.distanceTo(f.atlas.reference(0, 1, 0).viewPosition) < 1e-14);
  close(f, adapter);
});

test('native CSM rebind registers the clone, preserves fog/fragment chunks and releases only that registration', () => {
  installAtmosphericFog();
  const f = fixture(), scene = new T.Scene(), csm = new CSM({ camera: f.camera, parent: scene, cascades: 4, maxFar: 6000 });
  csm.setupMaterial(f.source);
  const sourceHook = f.source.onBeforeCompile, native = shader(); f.source.onBeforeCompile(native, null);
  assert.throws(() => new VisibleTriangleRasterAdapter(f.atlas, f.source, f.options), /rebind/);
  const adapter = new VisibleTriangleRasterAdapter(f.atlas, f.source, { ...f.options, customHooksCompatible: true, configureClone(clone) { csm.setupMaterial(clone); return () => csm.shaders.delete(clone); } });
  const built = shader(), fragmentBefore = built.fragmentShader;
  assembleVisibleTriangleShader(adapter, built);
  assert.equal(csm.shaders.get(f.source), native); assert.equal(csm.shaders.get(adapter.mesh.material), built);
  assert.equal(f.source.onBeforeCompile, sourceHook); assert.equal(built.fragmentShader, fragmentBefore);
  assert.ok(built.uniforms.CSM_cascades); assert.equal(built.uniforms.exactFloatData0.value, f.atlas.floatTextures[0]);
  const expanded = resolveChunks(built.vertexShader), fragment = resolveChunks(built.fragmentShader);
  assert.doesNotMatch(expanded, /#include/); assert.doesNotMatch(fragment, /#include/);
  assert.ok(expanded.indexOf('exactLoadOriginalVertex();') < expanded.indexOf('vec3 objectNormal = vec3( normal );'));
  assert.match(expanded, /vAtmosphereWorld=\(modelMatrix\*atmosphereLocal\)\.xyz/);
  assert.match(expanded, /transformedNormal = normalMatrix \* transformedNormal/);
  assert.match(expanded, /shadowWorldPosition = worldPosition/);
  assert.match(fragment, /dFdx/); assert.match(fragment, /cropperSkyRadiance/);
  assert.equal(adapter.mesh.material.defines.CSM_CASCADES, 4);
  f.camera.near = .75; csm.updateFrustums();
  assert.equal(built.uniforms.cameraNear.value, .75); assert.equal(native.uniforms.cameraNear.value, .75);
  adapter.dispose(); assert.equal(csm.shaders.has(adapter.mesh.material), false); assert.equal(csm.shaders.has(f.source), true);
  f.atlas.dispose(); csm.dispose(); csm.remove(); f.source.dispose();
});

test('native instance color creates matching vertex/fragment varyings without changing original material flags', () => {
  const base = fixture();
  const input = { ...base.input, instances: [{ ...base.input.instances[0], color: new Float32Array([.2, .3, .4]) }] };
  base.atlas.dispose(); const atlas = new OriginalTriangleAtlas(input); atlas.prepareView(base.camera);
  const adapter = new VisibleTriangleRasterAdapter(atlas, base.source, { ...base.options, instanceColors: true });
  adapter.setVisibleReferences(new Uint32Array([0, 0]));
  const built = shader(); assembleVisibleTriangleShader(adapter, built);
  assert.match(built.vertexShader, /^#define USE_INSTANCING_COLOR/);
  assert.match(built.fragmentShader, /^#ifndef USE_COLOR/);
  assert.equal(base.source.vertexColors, false); assert.equal(adapter.mesh.material.vertexColors, false);
  adapter.dispose(); atlas.dispose(); base.source.dispose();
});

test('unsupported coverage/materials and undersized resource limits fail explicitly', () => {
  const f = fixture();
  for (const patch of [{ transparent: true }, { depthWrite: false }, { wireframe: true }, { alphaHash: true }, { alphaTest: .1 }]) {
    const material = f.source.clone(); Object.assign(material, patch);
    assert.throws(() => new VisibleTriangleRasterAdapter(f.atlas, material, f.options)); material.dispose();
  }
  assert.deepEqual(packedTextureShape(17, 3), { width: 3, height: 2 });
  assert.throws(() => packedTextureShape(37, 3), /capacity/);
  assert.throws(() => new OriginalTriangleAtlas({ ...f.input, maxFloatPageBytes: 16 }), /three texture pages/);
  assert.throws(() => new OriginalTriangleAtlas({ ...f.input, geometries: [] }), /one geometry owner/);
  close(f);
});

test('atlas ownership is explicit and disposal leaves source data/materials alive', () => {
  const f = fixture(), adapter = new VisibleTriangleRasterAdapter(f.atlas, f.source, f.options);
  let sourceDisposed = false, ownedDisposed = 0;
  f.source.addEventListener('dispose', () => { sourceDisposed = true; });
  for (const texture of [...f.atlas.floatTextures, f.atlas.integerTexture, f.atlas.batchTexture]) texture.addEventListener('dispose', () => { ownedDisposed++; });
  assert.throws(() => f.atlas.dispose(), /adapters/);
  adapter.dispose(); adapter.dispose(); assert.equal(adapter.references.array.length, 0); assert.equal(sourceDisposed, false);
  f.atlas.dispose(); f.atlas.dispose(); assert.equal(ownedDisposed, 3);
  assert.equal(f.atlas.floatTextures.length, 0); assert.equal(f.atlas.integerTexture.image.data.length, 0);
  assert.equal(f.input.positions.length, 9); assert.throws(() => f.atlas.prepareView(f.camera), /disposed/);
  f.source.dispose();
});
