import test from 'node:test';
import assert from 'node:assert/strict';
import { affineBounds, buildBoundsBVH, triangleBounds, outwardFloat32, LEAF_BIT } from '../scripts/target-30fps/exact-bvh.mjs';

test('exact visibility BVH preserves every source triangle and conservatively encloses leaf and child bounds', () => {
  const positions = new Float32Array(300 * 9), indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i * 23.27) * (i % 3 === 1 ? 4 : 40);
  // A degenerate source triangle must remain represented too.
  positions.fill(0, 0, 9);
  const bounds = triangleBounds(positions, indices), bvh = buildBoundsBVH(bounds, { indexBase: 17, leafBase: 29 });
  const f = new Float32Array(bvh.nodes), u = new Uint32Array(bvh.nodes), found = [];
  function visit(globalNode) {
    const n = globalNode - 17, b = n * 8;
    assert.ok(n >= 0 && n < bvh.nodeCount);
    if (u[b + 7] & LEAF_BIT) {
      const start = u[b + 3] - 29, count = u[b + 7] & ~LEAF_BIT;
      assert.ok(count >= 1 && count <= 8);
      for (let i = start; i < start + count; i++) {
        const id = bvh.order[i]; found.push(id);
        for (let a = 0; a < 3; a++) {
          assert.ok(f[b + a] <= bounds[id * 6 + a]);
          assert.ok(f[b + a + 4] >= bounds[id * 6 + a + 3]);
        }
      }
    } else {
      for (const child of [u[b + 3], u[b + 7]]) {
        const c = (child - 17) * 8;
        for (let a = 0; a < 3; a++) {
          assert.ok(f[b + a] <= f[c + a]); assert.ok(f[b + a + 4] >= f[c + a + 4]);
        }
        visit(child);
      }
    }
  }
  visit(bvh.root);
  assert.deepEqual(found.sort((a, b) => a - b), Array.from({ length: 300 }, (_, i) => i));
});

test('exact visibility BVH slab rejection has the same nearest triangle as exhaustive double-sided intersections', () => {
  const positions = new Float32Array(90 * 9), indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  for (let t = 0; t < 90; t++) {
    const x = Math.sin(t * 1.37) * 15, y = Math.cos(t * 2.3) * 15, z = 1 + (t % 8) * 2;
    positions.set([x, y, z, x + 4, y, z, x, y + 4, z], t * 9);
  }
  const bvh = buildBoundsBVH(triangleBounds(positions, indices)), f = new Float32Array(bvh.nodes), u = new Uint32Array(bvh.nodes);
  const hitTriangle = (id, ox, oy) => {
    const p = id * 9, x = positions[p], y = positions[p + 1], ax = positions[p + 3] - x, ay = positions[p + 7] - y;
    const a = (ox - x) / ax, b = (oy - y) / ay;
    return a >= 0 && b >= 0 && a + b <= 1 ? positions[p + 2] : Infinity;
  };
  for (let ray = 0; ray < 900; ray++) {
    const ox = Math.sin(ray * 3.173) * 20, oy = Math.cos(ray * 2.973) * 20;
    let reference = Infinity, accelerated = Infinity;
    for (let t = 0; t < 90; t++) reference = Math.min(reference, hitTriangle(t, ox, oy));
    const stack = [bvh.root];
    while (stack.length) {
      const b = stack.pop() * 8;
      if (ox < f[b] || ox > f[b + 4] || oy < f[b + 1] || oy > f[b + 5] || f[b + 2] > accelerated || f[b + 6] < 0) continue;
      if (u[b + 7] & LEAF_BIT) {
        const count = u[b + 7] & ~LEAF_BIT;
        for (let i = u[b + 3]; i < u[b + 3] + count; i++) accelerated = Math.min(accelerated, hitTriangle(bvh.order[i], ox, oy));
      } else stack.push(u[b + 3], u[b + 7]);
    }
    assert.equal(accelerated, reference);
  }
});

test('unquantized affine bounds include negative scale and shear, and float32 bounds always round outward', () => {
  for (const v of [0, -0, 1e-40, -1e-40, 1 / 3, -1 / 3, 1234.56789, -99999.99]) {
    assert.ok(outwardFloat32(v, false) <= v); assert.ok(outwardFloat32(v, true) >= v);
  }
  const local = [-1, -2, -3, 4, 5, 6], m = [2, .2, -.1, 0, .7, -3, .6, 0, .3, .8, 1.5, 0, 100, -40, 200, 1];
  const actual = affineBounds(local, m);
  for (let i = 0; i < 100; i++) {
    const x = local[0] + (local[3] - local[0]) * ((i * 17) % 101) / 101;
    const y = local[1] + (local[4] - local[1]) * ((i * 37) % 101) / 101;
    const z = local[2] + (local[5] - local[2]) * ((i * 47) % 101) / 101;
    for (let a = 0; a < 3; a++) {
      const v = m[a] * x + m[a + 4] * y + m[a + 8] * z + m[a + 12];
      assert.ok(v >= actual[a] && v <= actual[a + 3]);
    }
  }
});
