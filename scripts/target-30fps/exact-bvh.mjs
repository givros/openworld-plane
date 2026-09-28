// CPU-only, unquantized acceleration for the isolated exact-visibility experiment.
// Bounds use Float64 during construction and round outward when serialized.
const bitsBuffer = new ArrayBuffer(4);
const bitsFloat = new Float32Array(bitsBuffer);
const bitsUint = new Uint32Array(bitsBuffer);
export const LEAF_BIT = 0x80000000;
export const NODE_BYTES = 32;

export function outwardFloat32(value, upper) {
  if (!Number.isFinite(value)) throw new Error('Non-finite acceleration bound');
  bitsFloat[0] = value;
  const rounded = bitsFloat[0];
  if (!Number.isFinite(rounded)) throw new Error('Acceleration bound exceeds float32');
  // One extra ULP also covers a subsequent slab subtraction at a triangle plane.
  if (rounded === 0) return upper ? 1.401298464324817e-45 : -1.401298464324817e-45;
  bitsUint[0] += (rounded > 0) === upper ? 1 : -1;
  return bitsFloat[0];
}

const area = (x, y, z) => 2 * (x * y + x * z + y * z);

/** bounds: six Float64 components per primitive, min xyz followed by max xyz. */
export function buildBoundsBVH(bounds, { leafSize = 8, binCount = 12, indexBase = 0, leafBase = 0 } = {}) {
  if (bounds.length % 6) throw new Error('Incomplete primitive bounds');
  const count = bounds.length / 6;
  if (!count) throw new Error('Cannot build an empty hierarchy');
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  const storage = new ArrayBuffer(Math.max(1, count * 2 - 1) * NODE_BYTES);
  const f = new Float32Array(storage), u = new Uint32Array(storage);
  let nodeCount = 0, maxDepth = 0;
  // Construction visits children sequentially, so this scratch may be reused.
  const binBounds = new Float64Array(binCount * 6), binCounts = new Uint32Array(binCount);
  const rightAreas = new Float64Array(binCount), rightCounts = new Uint32Array(binCount);
  function visit(start, end, depth) {
    const node = nodeCount++, n = end - start, offset = node * 8;
    maxDepth = Math.max(maxDepth, depth);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    for (let j = start; j < end; j++) {
      const p = order[j] * 6;
      minX = Math.min(minX, bounds[p]); minY = Math.min(minY, bounds[p + 1]); minZ = Math.min(minZ, bounds[p + 2]);
      maxX = Math.max(maxX, bounds[p + 3]); maxY = Math.max(maxY, bounds[p + 4]); maxZ = Math.max(maxZ, bounds[p + 5]);
      const x = (bounds[p] + bounds[p + 3]) * .5, y = (bounds[p + 1] + bounds[p + 4]) * .5, z = (bounds[p + 2] + bounds[p + 5]) * .5;
      cminX = Math.min(cminX, x); cminY = Math.min(cminY, y); cminZ = Math.min(cminZ, z);
      cmaxX = Math.max(cmaxX, x); cmaxY = Math.max(cmaxY, y); cmaxZ = Math.max(cmaxZ, z);
    }
    for (const [axis, lo, hi] of [[0, minX, maxX], [1, minY, maxY], [2, minZ, maxZ]]) {
      f[offset + axis] = outwardFloat32(lo, false); f[offset + axis + 4] = outwardFloat32(hi, true);
    }
    if (n <= leafSize) {
      u[offset + 3] = leafBase + start; u[offset + 7] = (LEAF_BIT | n) >>> 0;
      return node + indexBase;
    }
    const centroidMin = [cminX, cminY, cminZ], centroidMax = [cmaxX, cmaxY, cmaxZ];
    let bestCost = Infinity, bestAxis = -1, bestSplit = -1;
    for (let axis = 0; axis < 3; axis++) {
      const extent = centroidMax[axis] - centroidMin[axis];
      if (!(extent > 0)) continue;
      binCounts.fill(0);
      for (let b = 0; b < binCount; b++) {
        binBounds.fill(Infinity, b * 6, b * 6 + 3); binBounds.fill(-Infinity, b * 6 + 3, b * 6 + 6);
      }
      const scale = binCount / extent;
      for (let j = start; j < end; j++) {
        const p = order[j] * 6;
        const b = Math.min(binCount - 1, Math.floor(((bounds[p + axis] + bounds[p + axis + 3]) * .5 - centroidMin[axis]) * scale));
        binCounts[b]++;
        for (let a = 0; a < 3; a++) {
          binBounds[b * 6 + a] = Math.min(binBounds[b * 6 + a], bounds[p + a]);
          binBounds[b * 6 + a + 3] = Math.max(binBounds[b * 6 + a + 3], bounds[p + a + 3]);
        }
      }
      let rminX = Infinity, rminY = Infinity, rminZ = Infinity, rmaxX = -Infinity, rmaxY = -Infinity, rmaxZ = -Infinity, rn = 0;
      for (let b = binCount - 1; b >= 0; b--) {
        const p = b * 6; rn += binCounts[b];
        rminX = Math.min(rminX, binBounds[p]); rminY = Math.min(rminY, binBounds[p + 1]); rminZ = Math.min(rminZ, binBounds[p + 2]);
        rmaxX = Math.max(rmaxX, binBounds[p + 3]); rmaxY = Math.max(rmaxY, binBounds[p + 4]); rmaxZ = Math.max(rmaxZ, binBounds[p + 5]);
        rightCounts[b] = rn; rightAreas[b] = rn ? area(rmaxX - rminX, rmaxY - rminY, rmaxZ - rminZ) : 0;
      }
      let lminX = Infinity, lminY = Infinity, lminZ = Infinity, lmaxX = -Infinity, lmaxY = -Infinity, lmaxZ = -Infinity, ln = 0;
      for (let b = 0; b < binCount - 1; b++) {
        const p = b * 6; ln += binCounts[b];
        lminX = Math.min(lminX, binBounds[p]); lminY = Math.min(lminY, binBounds[p + 1]); lminZ = Math.min(lminZ, binBounds[p + 2]);
        lmaxX = Math.max(lmaxX, binBounds[p + 3]); lmaxY = Math.max(lmaxY, binBounds[p + 4]); lmaxZ = Math.max(lmaxZ, binBounds[p + 5]);
        if (!ln || !rightCounts[b + 1]) continue;
        const cost = ln * area(lmaxX - lminX, lmaxY - lminY, lmaxZ - lminZ) + rightCounts[b + 1] * rightAreas[b + 1];
        if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = b; }
      }
    }
    let middle = start;
    if (bestAxis >= 0) {
      const split = centroidMin[bestAxis] + (bestSplit + 1) * (centroidMax[bestAxis] - centroidMin[bestAxis]) / binCount;
      for (let j = start; j < end; j++) {
        const p = order[j] * 6;
        if ((bounds[p + bestAxis] + bounds[p + bestAxis + 3]) * .5 < split) {
          const temporary = order[middle]; order[middle++] = order[j]; order[j] = temporary;
        }
      }
    }
    if (middle === start || middle === end || depth >= 60) middle = start + Math.floor(n / 2);
    u[offset + 3] = visit(start, middle, depth + 1);
    u[offset + 7] = visit(middle, end, depth + 1);
    return node + indexBase;
  }
  const root = visit(0, count, 0);
  return { nodes: storage.slice(0, nodeCount * NODE_BYTES), order, root, nodeCount, maxDepth, count };
}

export function triangleBounds(positions, indices) {
  const result = new Float64Array(indices.length * 2);
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    for (let axis = 0; axis < 3; axis++) {
      result[t * 6 + axis] = Math.min(positions[a + axis], positions[b + axis], positions[c + axis]);
      result[t * 6 + axis + 3] = Math.max(positions[a + axis], positions[b + axis], positions[c + axis]);
    }
  }
  return result;
}

export function affineBounds(localBounds, matrix) {
  const result = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let corner = 0; corner < 8; corner++) {
    const x = localBounds[corner & 1 ? 3 : 0], y = localBounds[corner & 2 ? 4 : 1], z = localBounds[corner & 4 ? 5 : 2];
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12];
      result[axis] = Math.min(result[axis], value); result[axis + 3] = Math.max(result[axis + 3], value);
    }
  }
  return result;
}
