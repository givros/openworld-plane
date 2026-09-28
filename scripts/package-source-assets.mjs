import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, protectedPath, validateRelativePath } from './restore-project-assets.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultPartBytes = 32 * 1024 * 1024;

function excluded(name, allHistory) {
  return name.startsWith('.') || /\.log$/i.test(name) || /\.pyc$/i.test(name) ||
    ['__pycache__', 'playwright-report', 'test-results'].includes(name) || (!allHistory && name === 'checkpoints');
}

async function exists(filename) {
  try { await stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function collectSourcePaths(root, { allHistory = false } = {}) {
  const paths = new Set();
  async function collect(relative, recursive = true) {
    const directory = path.join(root, relative);
    if (!await exists(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded(entry.name, allHistory)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink source asset is not allowed: ${child}`);
      if (entry.isFile()) paths.add(child);
      else if (recursive && entry.isDirectory()) await collect(child);
    }
  }
  if (allHistory) {
    await collect('public');
    await collect('artifacts');
    const runtime = JSON.parse(await readFile(path.join(root, 'repository-assets/runtime/manifest.json'), 'utf8'));
    for (const entry of runtime.entries) paths.delete(`public/${entry.path}`);
  } else {
    if (await exists(path.join(root, 'public/environments'))) {
      for (const entry of await readdir(path.join(root, 'public/environments'), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.glb')) paths.add(`public/environments/${entry.name}`);
      }
    }
    await collect('artifacts/four-horizons', false);
    for (const directory of ['azure-port', 'verdant-airfield', 'alpine-lake', 'sunstone-oasis', 'scripts', 'references']) {
      await collect(`artifacts/four-horizons/${directory}`);
    }
    await collect('artifacts/distance-detail-20260928');
    await collect('artifacts/full-world-20260928');
  }
  return [...paths].sort();
}

async function packFile(root, outputRoot, relative, partBytes) {
  const source = await protectedPath(root, relative);
  const assetId = createHash('sha256').update(relative).digest('hex');
  const partDirectory = `files/${assetId}`;
  await protectedPath(outputRoot, `${partDirectory}/00000.gzpart`, { createParents: true });
  const parts = [];
  const rawHash = createHash('sha256');
  let bytes = 0, handle, currentPath, temporary, partHash, partSize = 0;
  async function finishPart() {
    if (!handle) return;
    await handle.close(); handle = undefined;
    await rename(temporary, path.join(outputRoot, currentPath));
    parts.push({ path: currentPath, bytes: partSize, sha256: partHash.digest('hex') });
    temporary = undefined;
  }
  async function append(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!handle) {
        currentPath = `${partDirectory}/${String(parts.length).padStart(5, '0')}.gzpart`;
        temporary = `${path.join(outputRoot, currentPath)}.${randomUUID()}.tmp`;
        handle = await open(temporary, 'wx');
        partHash = createHash('sha256'); partSize = 0;
      }
      const end = Math.min(chunk.length, offset + partBytes - partSize);
      const slice = chunk.subarray(offset, end);
      await handle.writeFile(slice);
      partHash.update(slice); partSize += slice.length; offset = end;
      if (partSize === partBytes) await finishPart();
    }
  }
  try {
    await pipeline(
      createReadStream(source),
      new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; rawHash.update(chunk); callback(null, chunk); } }),
      createGzip({ level: 6, chunkSize: 256 * 1024 }),
      new Writable({ write(chunk, encoding, callback) { append(chunk).then(() => callback(), callback); } }),
    );
    await finishPart();
    return { path: relative, bytes, sha256: rawHash.digest('hex'), gzipBytes: parts.reduce((sum, part) => sum + part.bytes, 0), parts };
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
  }
}

export async function packageSourceAssets({ root = projectRoot, paths, allHistory = false, partBytes = defaultPartBytes, log = console.log } = {}) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 64 || partBytes > defaultPartBytes) throw new Error('Invalid source archive part size');
  const outputRoot = await protectedPath(root, 'repository-assets/source', { createParents: true });
  await mkdir(outputRoot, { recursive: true });
  const prior = await exists(path.join(outputRoot, 'manifest.json'))
    ? JSON.parse(await readFile(path.join(outputRoot, 'manifest.json'), 'utf8')) : { entries: [] };
  const previous = new Map(prior.entries.map(entry => [entry.path, entry]));
  const pending = paths ?? await collectSourcePaths(root, { allHistory });
  const entries = [];
  for (const relative of [...new Set(pending)].sort()) {
    validateRelativePath(relative);
    if (!/^(public\/|artifacts\/)/.test(relative)) throw new Error(`Source asset is outside public/artifacts: ${relative}`);
    const known = previous.get(relative);
    let reuse = false;
    if (known) {
      const source = await hashFile(await protectedPath(root, relative));
      reuse = known.bytes === source.bytes && known.sha256 === source.sha256 && known.parts.every(part => part.bytes <= partBytes);
      if (reuse) for (const part of known.parts) {
        try {
          const actual = await hashFile(await protectedPath(outputRoot, part.path));
          if (actual.bytes !== part.bytes || actual.sha256 !== part.sha256) { reuse = false; break; }
        } catch { reuse = false; break; }
      }
    }
    const entry = reuse ? known : await packFile(root, outputRoot, relative, partBytes);
    entries.push(entry);
    log(`${reuse ? 'Verified' : 'Packaged'} ${entries.length}/${pending.length}: ${relative} (${entry.gzipBytes} compressed bytes)`);
    // A checkpoint is also a valid archive, so interrupted packaging can resume.
    const manifest = { version: 1, compression: 'gzip', partBytes, scope: allHistory ? 'all-history' : 'current-project', totalBytes: entries.reduce((sum, item) => sum + item.bytes, 0), totalGzipBytes: entries.reduce((sum, item) => sum + item.gzipBytes, 0), entries };
    const temporary = path.join(outputRoot, 'manifest.json.tmp');
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, path.join(outputRoot, 'manifest.json'));
  }
  const result = { files: entries.length, totalBytes: entries.reduce((sum, item) => sum + item.bytes, 0), totalGzipBytes: entries.reduce((sum, item) => sum + item.gzipBytes, 0) };
  log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--all-history')) throw new Error('Usage: node scripts/package-source-assets.mjs [--all-history]');
  await packageSourceAssets({ allHistory: args.includes('--all-history') });
}
