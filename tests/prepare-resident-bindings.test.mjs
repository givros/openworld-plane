import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { prepareResidentBindings } from '../src/core/prepareResidentBindings.ts';

function fixture(realDraw = false) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), parent = new THREE.Group();
  const environment = new THREE.Texture(), background = new THREE.Color('blue');
  scene.environment = environment; scene.background = background;
  const material = new THREE.MeshStandardMaterial(), geometry = new THREE.BoxGeometry();
  const mesh = new THREE.InstancedMesh(geometry, material, 4); mesh.receiveShadow = true; mesh.visible = false;
  const light = new THREE.DirectionalLight(), hiddenParent = new THREE.Group(), hiddenLight = new THREE.PointLight();
  hiddenParent.visible = false; hiddenParent.add(hiddenLight); parent.add(mesh, light); scene.add(parent, hiddenParent);
  const lightChild = new THREE.Mesh(geometry, material); light.add(lightChild);
  mesh.onBeforeRender = () => { throw new Error('Source callback must not run'); };
  scene.onBeforeRender = () => { throw new Error('Scene callback must not run'); };
  const originalSceneChildren = scene.children, originalLightChildren = light.children, before = mesh.onBeforeRender, sceneBefore = scene.onBeforeRender;
  const matrix = mesh.instanceMatrix, modelView = mesh.modelViewMatrix.clone();
  const currentTarget = new THREE.WebGLRenderTarget(8, 8);
  let target = currentTarget, face = 2, level = 1, viewport = new THREE.Vector4(1, 2, 3, 4), scissor = new THREE.Vector4(5, 6, 7, 8), scissorTest = true;
  let fail = false, wait = false, lost = false;
  const calls = [], events = [];
  const gl = { SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, WAIT_FAILED: 4, TIMEOUT_EXPIRED: 5,
    isContextLost: () => lost, fenceSync: () => (events.push('fence'), {}), flush: () => events.push('flush'),
    clientWaitSync: () => wait ? gl.TIMEOUT_EXPIRED : gl.ALREADY_SIGNALED, deleteSync: () => events.push('delete') };
  const nativeShadow = () => { throw new Error('Native shadow pass must not run'); };
  const renderer = { autoClear: true, sortObjects: true, xr: { enabled: true }, shadowMap: { render: nativeShadow, type: THREE.PCFShadowMap },
    info: { autoReset: true, render: { frame: 10, calls: 3, triangles: 4, lines: 5, points: 6 } },
    getContext: () => gl, getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => level,
    setRenderTarget(value, cubeFace = 0, mipLevel = 0) { target = value; face = cubeFace; level = mipLevel; },
    getViewport: value => value.copy(viewport), setViewport: value => { viewport = value.clone(); },
    getScissor: value => value.copy(scissor), setScissor: (value, y, width, height) => { scissor = typeof value === 'number' ? new THREE.Vector4(value, y, width, height) : value.clone(); },
    getScissorTest: () => scissorTest, setScissorTest: value => { scissorTest = value; },
    renderBufferDirect(cam, drawScene, geo, mat, object) {
      calls.push({ camera: cam, scene: drawScene, geometry: geo, material: mat, mesh: object, target, side: mat.side, receiveShadow: object.receiveShadow, count: object.count, range: { ...geo.drawRange } });
      assert.equal(object.count, realDraw ? 1 : 0); assert.equal(object.instanceMatrix, matrix);
      if (realDraw) { assert.equal(scissorTest, true); assert.deepEqual(scissor.toArray(), [0, 0, 0, 0]); }
    },
    render(drawScene, cam) {
      assert.equal(drawScene, scene); assert.equal(scene.environment, environment); assert.equal(scene.background, null);
      assert.equal(scene.matrixWorldAutoUpdate, false); assert.equal(cam.matrixWorldAutoUpdate, false);
      assert.deepEqual(scene.children, [light, mesh]); assert.equal(light.children.length, 0);
      assert.equal(mesh.visible, true); assert.equal(mesh.frustumCulled, false); assert.equal(mesh.count, realDraw ? 1 : 0);
      assert.equal(renderer.autoClear, false); assert.equal(renderer.xr.enabled, false); assert.equal(renderer.sortObjects, false);
      scene.onBeforeRender(); mesh.onBeforeRender(); renderer.shadowMap.render();
      if (realDraw) { scissor.set(0, 0, 8, 8); scissorTest = false; } // Simulate a render-target state transition.
      renderer.renderBufferDirect(cam, scene, mesh.geometry, mesh.material, mesh, null);
      mesh.modelViewMatrix.makeTranslation(100, 200, 300);
      renderer.info.render.frame++; renderer.info.render.calls++;
      if (fail) throw new Error('Binding draw failed');
    },
  };
  const direct = renderer.renderBufferDirect;
  const verify = () => {
    assert.equal(scene.children, originalSceneChildren); assert.equal(light.children, originalLightChildren);
    assert.equal(mesh.parent, parent); assert.equal(light.parent, parent); assert.equal(lightChild.parent, light);
    assert.equal(scene.environment, environment); assert.equal(scene.background, background); assert.equal(scene.matrixWorldAutoUpdate, true);
    assert.equal(scene.onBeforeRender, sceneBefore); assert.equal(mesh.onBeforeRender, before);
    assert.equal(mesh.material, material); assert.equal(mesh.count, 4); assert.equal(mesh.visible, false); assert.equal(mesh.frustumCulled, true);
    assert.equal(mesh.instanceMatrix, matrix); assert.ok(mesh.modelViewMatrix.equals(modelView)); assert.equal(camera.matrixWorldAutoUpdate, true);
    assert.equal(renderer.autoClear, true); assert.equal(renderer.sortObjects, true); assert.equal(renderer.xr.enabled, true);
    assert.equal(renderer.shadowMap.render, nativeShadow); assert.equal(renderer.renderBufferDirect, direct); assert.equal(renderer.info.autoReset, true);
    assert.equal(target, currentTarget); assert.equal(face, 2); assert.equal(level, 1);
    assert.deepEqual(viewport.toArray(), [1, 2, 3, 4]); assert.deepEqual(scissor.toArray(), [5, 6, 7, 8]); assert.equal(scissorTest, true);
    const { frame, ...counts } = renderer.info.render; assert.deepEqual(counts, { calls: 3, triangles: 4, lines: 5, points: 6 }); assert.ok(frame >= 10);
  };
  return { scene, camera, mesh, material, geometry, light, renderer, calls, events, verify,
    fail: () => { fail = true; }, wait: () => { wait = true; }, lose: () => { lost = true; } };
}

test('actual lit program binding retains real scene lights, environment and instance identity with zero instances', async () => {
  const f = fixture(); let disposed = 0;
  f.geometry.addEventListener('dispose', () => disposed++); f.material.addEventListener('dispose', () => disposed++);
  const result = await prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh, f.mesh], new AbortController().signal, () => f.verify());
  assert.equal(result.beautyBindings, 1); assert.equal(result.total, 1); assert.equal(result.stage, 'complete');
  assert.equal(f.calls[0].material, f.material); assert.equal(f.calls[0].mesh, f.mesh); assert.equal(f.calls[0].receiveShadow, true);
  assert.equal(disposed, 0); assert.deepEqual(f.events, ['fence', 'flush', 'delete']); f.verify();
});

test('explicit solid depth material binds with actual shadow camera, target and null scene, then restores material state', async () => {
  const f = fixture(), depth = new THREE.MeshDepthMaterial(); f.mesh.customDepthMaterial = depth; f.mesh.castShadow = true;
  depth.side = THREE.FrontSide;
  f.light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
  const result = await prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal, undefined, { shadowCamera: f.light.shadow.camera });
  assert.equal(result.shadowBindings, 1); assert.equal(result.unsupportedShadows, 0);
  assert.equal(f.calls[1].material, depth); assert.equal(f.calls[1].camera, f.light.shadow.camera);
  assert.equal(f.calls[1].target, f.light.shadow.map); assert.equal(f.calls[1].scene, null); assert.equal(f.calls[1].side, THREE.BackSide);
  assert.equal(depth.side, THREE.FrontSide); assert.equal(f.light.shadow.camera.matrixWorldAutoUpdate, true); f.verify();
});

test('native private depth variants are reported unsupported instead of warming an approximate substitute', async () => {
  const f = fixture(); f.mesh.castShadow = true;
  const result = await prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal, undefined, { shadowCamera: f.light.shadow.camera });
  assert.equal(result.beautyBindings, 1); assert.equal(result.shadowBindings, 0); assert.equal(result.unsupportedShadows, 1); f.verify();
});

test('render failures restore every borrowed live scene and renderer field', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal), /Binding draw failed/);
  f.verify(); assert.equal(f.events.length, 0);
});

test('asynchronous cancellation deletes completion fence and exposes only restored state', async () => {
  const f = fixture(), controller = new AbortController(); f.wait();
  const pending = prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], controller.signal, () => f.verify());
  setTimeout(() => controller.abort(), 2);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(f.events.includes('delete')); f.verify();
});

test('context loss and transparent inputs reject before altering the live scene', async () => {
  const f = fixture(); f.lose();
  await assert.rejects(prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal), /context was lost/); f.verify();
  const other = fixture(); other.material.transparent = true;
  await assert.rejects(prepareResidentBindings(other.renderer, other.scene, other.camera, [other.mesh], new AbortController().signal), /opaque single-material/); other.verify();
});

test('optional real draw retains full original geometry range and driver state while scissoring every sample', async () => {
  const f = fixture(true), range = f.geometry.drawRange, positions = f.geometry.attributes.position.array.slice(), matrices = f.mesh.instanceMatrix.array.slice();
  f.geometry.setDrawRange(3, 30);
  const version = f.mesh.instanceMatrix.version, index = f.geometry.index;
  const target = f.renderer.getRenderTarget();
  const result = await prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal, () => f.verify(), { realDraw: true });
  assert.equal(result.realDraws, 1); assert.equal(f.calls[0].target, target); assert.equal(f.calls[0].material, f.material);
  assert.equal(f.calls[0].count, 1); assert.deepEqual(f.calls[0].range, { start: 3, count: 30 });
  assert.equal(f.geometry.drawRange, range); assert.deepEqual(range, { start: 3, count: 30 });
  assert.equal(f.geometry.index, index); assert.equal(f.mesh.instanceMatrix.version, version);
  assert.deepEqual(f.geometry.attributes.position.array, positions); assert.deepEqual(f.mesh.instanceMatrix.array, matrices); f.verify();
});

test('real beauty and custom depth draws both restore scissor, count and direct wrapper after failure', async () => {
  const f = fixture(true); f.mesh.castShadow = true; f.mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
  f.light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
  const result = await prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal, undefined, { realDraw: true, shadowCamera: f.light.shadow.camera });
  assert.equal(result.realDraws, 2); assert.equal(f.calls[1].scene, null); assert.equal(f.calls[1].target, f.light.shadow.map); f.verify();
  f.fail();
  await assert.rejects(prepareResidentBindings(f.renderer, f.scene, f.camera, [f.mesh], new AbortController().signal, undefined, { realDraw: true }), /Binding draw failed/);
  f.verify();
});
