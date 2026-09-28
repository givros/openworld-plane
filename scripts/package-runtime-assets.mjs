import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

// Package only the files used by the full-map runtime. Compression is lossless;
// original Blender exports, stream buffers, and manifests remain unchanged.
const root = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = await realpath(path.join(root, 'public'));
const outputRoot = path.join(root, 'repository-assets', 'runtime');
const maxFileBytes = 99 * 1024 * 1024;
const maxTotalBytes = 950_000_000;
const definitions = new Map();

function relativePath(url) {
  if (typeof url !== 'string') throw new Error('Runtime asset URL must be a string');
  const relative = url.replace(/^\//, '');
  if (!relative.startsWith('environments/') || relative.includes('\\') ||
      relative.split('/').some(part => !part || part === '.' || part === '..') ||
      /[?#:\0]/.test(relative)) throw new Error(`Unsafe runtime asset path: ${url}`);
  return relative;
}

async function sourcePath(relative) {
  const resolved = await realpath(path.join(publicRoot, relative));
  const inside = path.relative(publicRoot, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`Asset escapes public directory: ${relative}`);
  if (!(await stat(resolved)).isFile()) throw new Error(`Runtime asset is not a file: ${relative}`);
  return resolved;
}

function add(url, expected = {}) {
  const relative = relativePath(url);
  const prior = definitions.get(relative);
  for (const key of ['bytes', 'sha256']) {
    if (prior?.[key] !== undefined && expected[key] !== undefined && prior[key] !== expected[key])
      throw new Error(`Conflicting runtime asset metadata: ${relative} (${key})`);
  }
  definitions.set(relative, { ...prior, ...expected });
}

async function json(url) {
  add(url);
  return JSON.parse(await readFile(await sourcePath(relativePath(url)), 'utf8'));
}

const world = await json('/environments/world-manifest.json');
add(world.terrain.url);
const streams = await json('/environments/stream/manifest.json');
for (const chunk of streams.chunks) {
  const data = await json(chunk.url);
  add(data.matrices.url, { bytes: data.matrices.bytes, sha256: data.matrices.sha256 });
}
for (const entry of [...streams.geometries, ...streams.images])
  add(entry.url, { bytes: entry.bytes, sha256: entry.sha256 });
const shadows = await json('/environments/shadow-indices/manifest.json');
for (const entry of shadows.geometries)
  add(entry.url, { bytes: entry.bytes, sha256: entry.sha256 });
const detail = await json('/environments/lod/manifest.json');
const detailBuffer = detail.buffer ?? detail.indices;
add(detailBuffer.url, { bytes: detailBuffer.bytes, sha256: detailBuffer.sha256 });

await mkdir(outputRoot, { recursive: true });
const pending = [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
const entries = new Array(pending.length);
let next = 0, completed = 0;

async function pack(index) {
  const [relative, expected] = pending[index];
  const packedPath = `files/${relative}.gz`;
  const destination = path.join(outputRoot, packedPath);
  await mkdir(path.dirname(destination), { recursive: true });
  const rawHash = createHash('sha256'), gzipHash = createHash('sha256');
  let bytes = 0, gzipBytes = 0;
  await pipeline(
    createReadStream(await sourcePath(relative)),
    new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      rawHash.update(chunk);
      callback(null, chunk);
    } }),
    createGzip({ level: 6 }),
    new Transform({ transform(chunk, encoding, callback) {
      gzipBytes += chunk.length;
      if (gzipBytes > maxFileBytes) return callback(new Error(`Compressed asset exceeds 99 MiB: ${relative}`));
      gzipHash.update(chunk);
      callback(null, chunk);
    } }),
    createWriteStream(`${destination}.tmp`),
  );
  const sha256 = rawHash.digest('hex'), gzipSha256 = gzipHash.digest('hex');
  if (expected.bytes !== undefined && bytes !== expected.bytes) throw new Error(`Source size mismatch: ${relative}`);
  if (expected.sha256 !== undefined && sha256 !== expected.sha256) throw new Error(`Source hash mismatch: ${relative}`);
  await rename(`${destination}.tmp`, destination);
  entries[index] = { path: relative, bytes, sha256, gzipBytes, gzipSha256, packedPath };
  if (++completed % 1000 === 0) console.log(`Packaged ${completed}/${pending.length} runtime assets`);
}

await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < pending.length) await pack(next++);
}));
const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
const totalGzipBytes = entries.reduce((sum, entry) => sum + entry.gzipBytes, 0);
if (totalGzipBytes > maxTotalBytes) throw new Error(`Runtime assets exceed the Pages size budget: ${totalGzipBytes} bytes`);
const manifest = { version: 1, compression: 'gzip', totalBytes, totalGzipBytes, entries };
await writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const largest = entries.reduce((prior, entry) => entry.gzipBytes > prior.gzipBytes ? entry : prior);
console.log(JSON.stringify({ files: entries.length, totalBytes, totalGzipBytes, largest }, null, 2));
