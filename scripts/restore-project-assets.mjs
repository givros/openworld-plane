import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const shaPattern = /^[a-f0-9]{64}$/;

export function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || /[\\:\0?#]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error(`Unsafe archive path: ${String(value)}`);
  }
  return value;
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Archive path escapes its root: ${target}`);
  }
}

export async function protectedPath(root, relative, { createParents = false } = {}) {
  validateRelativePath(relative);
  const canonicalRoot = await realpath(root);
  const destination = path.resolve(canonicalRoot, relative);
  assertInside(canonicalRoot, destination);
  const segments = relative.split('/');
  let current = canonicalRoot;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symlink archive path is not allowed: ${relative}`);
      assertInside(canonicalRoot, await realpath(current));
      if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`Archive parent is not a directory: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (createParents && index < segments.length - 1) await mkdir(current);
    }
  }
  return destination;
}

export async function hashFile(filename) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

function validateDigest(entry, label) {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !shaPattern.test(entry.sha256)) {
    throw new Error(`Invalid archive checksum metadata: ${label}`);
  }
}

async function* verifiedParts(archiveRoot, parts) {
  for (const part of parts) {
    validateDigest(part, part.path);
    const filename = await protectedPath(archiveRoot, part.path);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) {
      bytes += chunk.length;
      if (bytes > part.bytes) throw new Error(`Compressed part size mismatch: ${part.path}`);
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== part.bytes || hash.digest('hex') !== part.sha256) {
      throw new Error(`Compressed part checksum mismatch: ${part.path}`);
    }
  }
}

async function restoreEntry(root, archiveRoot, entry, relative, parts, force) {
  validateDigest(entry, relative);
  const destination = await protectedPath(root, relative, { createParents: true });
  try {
    if (!(await stat(destination)).isFile()) throw new Error(`Existing asset is not a file: ${relative}`);
    const existing = await hashFile(destination);
    if (existing.bytes === entry.bytes && existing.sha256 === entry.sha256) return 'verified';
    if (!force) throw new Error(`Refusing to overwrite a changed local asset: ${relative}. Preserve it first, or use --force explicitly.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const temporary = `${destination}.restore-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  const rawHash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      Readable.from(verifiedParts(archiveRoot, parts)),
      createGunzip(),
      new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.bytes) return callback(new Error(`Restored asset size mismatch: ${relative}`));
        rawHash.update(chunk);
        callback(null, chunk);
      } }),
      new Writable({ write(chunk, encoding, callback) {
        handle.writeFile(chunk).then(() => callback(), callback);
      } }),
    );
    if (bytes !== entry.bytes || rawHash.digest('hex') !== entry.sha256) throw new Error(`Restored asset checksum mismatch: ${relative}`);
    await handle.sync();
    await handle.close();
    // Recheck parent protection immediately before making the completed file visible.
    await protectedPath(root, relative);
    if (force) await rename(temporary, destination);
    else {
      // An atomic no-clobber publish also protects an asset created during decompression.
      try { await link(temporary, destination); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite an asset created during restoration: ${relative}`);
        throw error;
      }
    }
    return 'restored';
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export async function restoreProjectAssets({ root = projectRoot, all = false, force = false, log = console.log } = {}) {
  const archives = [{ directory: 'runtime', prefix: 'public/' }];
  if (all) archives.push({ directory: 'source', prefix: '' });
  const result = { restored: 0, verified: 0, bytes: 0 };
  const destinations = new Set();
  for (const archive of archives) {
    const archiveRoot = await protectedPath(root, `repository-assets/${archive.directory}`);
    const manifest = JSON.parse(await readFile(await protectedPath(archiveRoot, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || manifest.compression !== 'gzip' || !Array.isArray(manifest.entries)) {
      throw new Error(`Unsupported asset archive: ${archive.directory}`);
    }
    for (const entry of manifest.entries) {
      validateRelativePath(entry.path);
      const relative = `${archive.prefix}${entry.path}`;
      if (archive.directory === 'runtime' && !entry.path.startsWith('environments/')) throw new Error(`Runtime target is outside environments: ${entry.path}`);
      if (archive.directory === 'source' && !/^(public\/|artifacts\/)/.test(entry.path)) throw new Error(`Source target is outside source asset folders: ${entry.path}`);
      if (destinations.has(relative)) throw new Error(`Duplicate asset destination: ${relative}`);
      destinations.add(relative);
      const parts = archive.directory === 'runtime'
        ? [{ path: entry.packedPath, bytes: entry.gzipBytes, sha256: entry.gzipSha256 }]
        : entry.parts;
      if (!Array.isArray(parts) || !parts.length) throw new Error(`Missing archive parts: ${relative}`);
      const status = await restoreEntry(root, archiveRoot, entry, relative, parts, force);
      result[status]++;
      result.bytes += entry.bytes;
      if ((result.restored + result.verified) % 1000 === 0) log(`Checked ${result.restored + result.verified} project assets`);
    }
  }
  log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--all', '--force'].includes(arg))) throw new Error('Usage: node scripts/restore-project-assets.mjs [--all] [--force]');
  await restoreProjectAssets({ all: args.includes('--all'), force: args.includes('--force') });
}
