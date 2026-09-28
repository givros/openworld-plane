import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SelectedPassRendering } from '../src/core/SelectedPassRendering.ts';
import { registerDistanceDetailGeometry, distanceDetailLevels } from '../src/world/DistanceDetailGeometry.ts';

function fixture() {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const root = new THREE.Group(), low = new THREE.Group(), high = new THREE.Group();
  low.renderOrder = 2; high.renderOrder = 9;
  const meshes = [2, 3, 1].map((count, m) => {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(m * 10 + i, 0, 0));
    return mesh;
  });
  low.add(meshes[0], meshes[1]); high.add(meshes[2]); root.add(low, high);
  return { root, low, high, meshes, geometry, material, rendering: new SelectedPassRendering() };
}

test('selected pass keeps inherited order groups and restores canonical child arrays', () => {
  const f = fixture(), rootChildren = f.root.children, lowChildren = f.low.children, highChildren = f.high.children;
  const originalMatrices = f.meshes.map(mesh => mesh.instanceMatrix.array.slice());
  try {
    const result = f.rendering.render(f.root, f.meshes, 0, () => {
      assert.deepEqual(f.root.children, [f.low, f.high]);
      assert.deepEqual(f.root.children.map(group => group.renderOrder), [2, 9]);
      assert.equal(f.low.children.length, 1); assert.equal(f.high.children.length, 1);
      assert.equal(f.low.children[0].count, 5); assert.equal(f.high.children[0].count, 1);
      assert.notEqual(f.low.children[0], f.meshes[0]);
      assert.equal(f.meshes[0].parent, f.low); assert.equal(f.meshes[2].parent, f.high);
      return 'draw result';
    });
    assert.equal(result, 'draw result');
    assert.equal(f.root.children, rootChildren); assert.equal(f.low.children, lowChildren); assert.equal(f.high.children, highChildren);
    f.meshes.forEach((mesh, i) => assert.deepEqual(mesh.instanceMatrix.array, originalMatrices[i]));
  } finally { f.rendering.dispose(); }
});

test('render exceptions restore root and order-group child array identities', () => {
  const f = fixture(), rootChildren = f.root.children, lowChildren = f.low.children, highChildren = f.high.children;
  try {
    assert.throws(() => f.rendering.render(f.root, f.meshes, 0, () => { throw new Error('draw failed'); }), /draw failed/);
    assert.equal(f.root.children, rootChildren); assert.equal(f.low.children, lowChildren); assert.equal(f.high.children, highChildren);
    f.rendering.render(f.root, [], 0, () => assert.equal(f.root.children.length, 0));
    assert.equal(f.root.children, rootChildren);
  } finally { f.rendering.dispose(); }
});

test('nested shadow selection uses independent buffers and restores both passes after an error', () => {
  const beauty = fixture(), shadowRoot = new THREE.Group(), shadowGroup = new THREE.Group();
  shadowGroup.renderOrder = beauty.low.renderOrder; shadowRoot.add(shadowGroup);
  const shadowMesh = new THREE.InstancedMesh(beauty.geometry, beauty.material, 2);
  shadowMesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(120, 0, 0));
  shadowGroup.add(shadowMesh);
  const rootChildren = beauty.root.children, orderChildren = beauty.low.children;
  const shadowChildren = shadowRoot.children, shadowOrderChildren = shadowGroup.children;
  try {
    assert.throws(() => beauty.rendering.render(beauty.root, beauty.meshes, 0, () => {
      const beautyBatch = beauty.low.children[0], matrices = beautyBatch.instanceMatrix.array.slice();
      const activeBeautyChildren = beauty.low.children;
      assert.throws(() => beauty.rendering.render(shadowRoot, [shadowMesh], 1, () => {
        assert.notEqual(shadowGroup.children[0], beautyBatch);
        assert.notEqual(shadowGroup.children[0].instanceMatrix, beautyBatch.instanceMatrix);
        throw new Error('shadow failed');
      }), /shadow failed/);
      assert.equal(shadowRoot.children, shadowChildren); assert.equal(shadowGroup.children, shadowOrderChildren);
      assert.equal(beauty.low.children, activeBeautyChildren);
      assert.deepEqual(beautyBatch.instanceMatrix.array, matrices);
      throw new Error('beauty failed');
    }), /beauty failed/);
    assert.equal(beauty.root.children, rootChildren); assert.equal(beauty.low.children, orderChildren);
  } finally { beauty.rendering.dispose(); }
});

test('preparation includes every beauty LOD and shadow geometry without owning canonical buffers', () => {
  const f = fixture(), source = f.meshes[0];
  source.geometry.userData.sourceSha256 = 'fixture';
  const binary = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 2]).buffer;
  registerDistanceDetailGeometry(source.geometry, 17, {
    binary,
    definitions: new Map([[17, { geometryId: 17, sourceSha256: 'fixture', levels: [
      { level: 1, errorAbsolute: .05, triangles: 2, index: { byteOffset: 0, bytes: 24, count: 6, arrayType: 'Uint32Array' } },
      { level: 2, errorAbsolute: .1, triangles: 1, index: { byteOffset: 24, bytes: 12, count: 3, arrayType: 'Uint32Array' } },
    ] }]]),
  });
  source.matrixWorld.makeTranslation(7, 8, 9); source.castShadow = true; source.receiveShadow = true;
  source.setColorAt(0, new THREE.Color('red'));
  const levels = distanceDetailLevels(source.geometry), proxies = [];
  for (const pass of [0, 1]) {
    const proxy = new THREE.InstancedMesh(pass ? levels[1].geometry : source.geometry, source.material, 2);
    proxy.instanceColor = source.instanceColor.clone();
    proxy.userData = { canonicalSourceId: source.id, passIndex: pass };
    proxy.customDepthMaterial = new THREE.MeshDepthMaterial();
    f.low.add(proxy); proxies.push(proxy);
  }
  const region = proxies[1].clone(); region.userData.shadowRegionProxy = true; proxies.push(region);
  const sourceMatrix = source.instanceMatrix, sourceColor = source.instanceColor;
  const sourceArray = sourceMatrix.array.slice(), sourceVersion = sourceMatrix.version;
  const proxyArrays = proxies.map(proxy => proxy.instanceMatrix.array.slice());
  let sourceDisposals = 0, sharedDisposals = 0;
  source.addEventListener('dispose', () => sourceDisposals++);
  f.geometry.addEventListener('dispose', () => sharedDisposals++);
  f.material.addEventListener('dispose', () => sharedDisposals++);
  try {
    f.rendering.prepare([{ source, originalLayerMask: 4 }], proxies, true);
    const prepared = f.rendering.preparationMeshes();
    assert.equal(prepared.length, 4);
    assert.deepEqual(prepared.map(mesh => mesh.geometry), [source.geometry, levels[0].geometry, levels[1].geometry, levels[1].geometry]);
    for (const mesh of prepared) {
      assert.equal(mesh.instanceMatrix.count, 2); assert.equal(mesh.instanceColor.count, 2);
      assert.notEqual(mesh.instanceMatrix, sourceMatrix); assert.notEqual(mesh.instanceColor, sourceColor);
      assert.equal(mesh.layers.mask, 4); assert.deepEqual(mesh.matrixWorld.elements, source.matrixWorld.elements);
      proxies.forEach(proxy => assert.notEqual(mesh.instanceMatrix, proxy.instanceMatrix));
    }
    assert.equal(source.instanceMatrix, sourceMatrix); assert.equal(source.instanceColor, sourceColor);
    assert.deepEqual(source.instanceMatrix.array, sourceArray); assert.equal(sourceMatrix.version, sourceVersion);
    proxies.forEach((proxy, i) => assert.deepEqual(proxy.instanceMatrix.array, proxyArrays[i]));
    f.rendering.dispose();
    assert.equal(sourceDisposals, 0); assert.equal(sharedDisposals, 0);
  } finally { f.rendering.dispose(); }
});

test('unsupported nested source parents fail before replacing scene children', () => {
  const f = fixture(), nested = new THREE.Group();
  f.low.add(nested); nested.add(f.meshes[0]);
  const rootChildren = f.root.children, lowChildren = f.low.children;
  try {
    assert.throws(() => f.rendering.render(f.root, [f.meshes[0]], 0, () => assert.fail('must not draw')), /direct pass order groups/);
    assert.equal(f.root.children, rootChildren); assert.equal(f.low.children, lowChildren);
  } finally { f.rendering.dispose(); }
});

test('duplicate parent orders preserve distinct selected data through fallback and nested throws', () => {
  const f = fixture(), extra = new THREE.Group();
  extra.renderOrder = f.high.renderOrder;
  const extraMesh = new THREE.InstancedMesh(f.geometry, f.material, 1);
  extraMesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(80, 0, 0));
  extra.add(extraMesh); f.root.add(extra);
  // A direct root mesh and an order-zero child collide as well.
  const zero = new THREE.Group(), direct = new THREE.InstancedMesh(f.geometry, f.material, 1);
  const zeroMesh = new THREE.InstancedMesh(f.geometry, f.material, 1);
  direct.setMatrixAt(0, new THREE.Matrix4().makeTranslation(90, 0, 0));
  zeroMesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 0, 0));
  zero.add(zeroMesh); f.root.add(zero, direct);
  const selected = [...f.meshes, extraMesh, zeroMesh, direct];
  const rootChildren = f.root.children;
  const childArrays = [f.low, f.high, extra, zero].map(group => group.children);
  const shadowRoot = new THREE.Group(), shadowGroup = new THREE.Group();
  shadowRoot.add(shadowGroup);
  const shadowMesh = new THREE.InstancedMesh(f.geometry, f.material, 1); shadowGroup.add(shadowMesh);
  const shadowChildren = shadowRoot.children, shadowOrderChildren = shadowGroup.children;
  try {
    assert.throws(() => f.rendering.render(f.root, selected, 0, () => {
      assert.equal(f.high.children[0], f.meshes[2]); assert.equal(extra.children[0], extraMesh);
      assert.equal(zero.children[0], zeroMesh); assert.ok(f.root.children.includes(direct));
      assert.equal(extra.children[0].instanceMatrix.array[12], 80);
      assert.equal(zero.children[0].instanceMatrix.array[12], 100);
      assert.equal(direct.instanceMatrix.array[12], 90);
      const active = f.root.children;
      assert.throws(() => f.rendering.render(shadowRoot, [shadowMesh], 1, () => { throw new Error('nested collision shadow'); }), /nested collision shadow/);
      assert.equal(f.root.children, active);
      assert.equal(shadowRoot.children, shadowChildren); assert.equal(shadowGroup.children, shadowOrderChildren);
      throw new Error('collision beauty');
    }), /collision beauty/);
    assert.equal(f.root.children, rootChildren);
    [f.low, f.high, extra, zero].forEach((group, i) => assert.equal(group.children, childArrays[i]));
  } finally { f.rendering.dispose(); }
});

test('reused pass scratch tracks selection and parent changes, and same-pass reentrancy is safe', () => {
  const f = fixture(), originalRoot = f.root.children, originalLow = f.low.children, originalHigh = f.high.children;
  try {
    for (let frame = 0; frame < 2; frame++) f.rendering.render(f.root, f.meshes, 0, () => {
      assert.equal(f.low.children[0].count, 5); assert.equal(f.high.children[0].count, 1);
    });
    f.high.add(f.meshes[1]);
    f.rendering.render(f.root, f.meshes, 0, () => {
      const activeRoot = f.root.children, activeHigh = f.high.children, outerBatch = activeHigh[0];
      assert.equal(f.low.children[0].count, 2); assert.equal(outerBatch.count, 4);
      f.rendering.render(f.root, [f.meshes[1]], 0, () => {
        assert.equal(f.high.children[0], f.meshes[1]);
        assert.equal(outerBatch.count, 4);
      });
      assert.equal(f.root.children, activeRoot); assert.equal(f.high.children, activeHigh);
      assert.equal(outerBatch.count, 4);
    });
    assert.equal(f.root.children, originalRoot); assert.equal(f.low.children, originalLow); assert.equal(f.high.children, originalHigh);
    f.rendering.render(f.root, [f.meshes[2]], 0, () => {
      assert.deepEqual(f.root.children, [f.high]); assert.equal(f.high.children[0].count, 1);
    });
  } finally { f.rendering.dispose(); }
});

test('explicit pass revision reuses complete selection and invalidates on revised or undefined ownership', () => {
  const f = fixture(); f.rendering.dispose();
  let revision = 1, keyCalls = 0;
  f.rendering = new SelectedPassRendering(() => { keyCalls++; return undefined; }, pass => pass === 0 ? revision : undefined);
  const originalRoot = f.root.children, originalLow = f.low.children;
  try {
    let first;
    f.rendering.render(f.root, f.meshes, 0, () => { first = f.low.children[0]; });
    const initialCalls = keyCalls;
    f.rendering.render(f.root, f.meshes, 0, () => assert.equal(f.low.children[0], first));
    assert.equal(keyCalls, initialCalls); assert.equal(f.rendering.selectionCacheStatistics.reusedPasses, 1);
    f.meshes[1].count = 1; f.meshes[1].instanceMatrix.array[12] = 81; f.meshes[1].instanceMatrix.needsUpdate = true;
    revision++;
    f.rendering.render(f.root, f.meshes, 0, () => {
      assert.equal(f.low.children[0].count, 3); assert.equal(f.low.children[0].instanceMatrix.array[44], 81);
    });
    assert.ok(keyCalls > initialCalls);
    revision = undefined;
    f.meshes[0].onBeforeRender = () => {};
    f.rendering.render(f.root, f.meshes, 0, () => assert.equal(f.low.children[0], f.meshes[0]));
    const uncached = keyCalls;
    f.rendering.render(f.root, f.meshes, 0, () => {});
    assert.ok(keyCalls > uncached);
    assert.equal(f.root.children, originalRoot); assert.equal(f.low.children, originalLow);
  } finally { f.rendering.dispose(); }
});

test('cached pass restoration survives nested rendering and throws without aliasing batches', () => {
  const f = fixture(); f.rendering.dispose();
  f.rendering = new SelectedPassRendering(undefined, pass => pass === 0 ? 3 : undefined);
  const originalRoot = f.root.children, originalLow = f.low.children;
  try {
    f.rendering.render(f.root, f.meshes, 0, () => {});
    assert.throws(() => f.rendering.render(f.root, f.meshes, 0, () => {
      const outerRoot = f.root.children, outerLow = f.low.children, outerMesh = outerLow[0];
      f.rendering.render(f.root, [f.meshes[0]], 0, () => {
        assert.equal(f.low.children[0], f.meshes[0]); assert.equal(outerMesh.count, 5);
      });
      assert.equal(f.root.children, outerRoot); assert.equal(f.low.children, outerLow);
      throw new Error('cached draw failed');
    }), /cached draw failed/);
    assert.equal(f.root.children, originalRoot); assert.equal(f.low.children, originalLow);
    f.rendering.render(f.root, f.meshes, 0, () => assert.equal(f.low.children[0].count, 5));
    assert.equal(f.rendering.selectionCacheStatistics.reusedPasses, 2);
  } finally { f.rendering.dispose(); }
});
