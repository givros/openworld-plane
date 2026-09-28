import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { collectSourcePaths, packageSourceAssets } from '../scripts/package-source-assets.mjs';
import { restoreProjectAssets, validateRelativePath } from '../scripts/restore-project-assets.mjs';

const silent = () => {};
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, data = Buffer.from('runtime geometry bytes')) {
  const root = await mkdtemp(path.join(tmpdir(), 'plane-asset-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'repository-assets/runtime');
  await mkdir(path.join(archive, 'files'), { recursive: true });
  const compressed = gzipSync(data);
  await writeFile(path.join(archive, 'files/geometry.gz'), compressed);
  const manifest = { version: 1, compression: 'gzip', entries: [{ path: 'environments/geometry.bin', bytes: data.length, sha256: digest(data), gzipBytes: compressed.length, gzipSha256: digest(compressed), packedPath: 'files/geometry.gz' }] };
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify(manifest));
  return { root, data, archive, manifest };
}

test('runtime and multipart source archives restore exact bytes and reuse matching assets', async t => {
  const { root, data } = await fixture(t);
  const sourcePath = 'artifacts/four-horizons/azure-port/Scene.blend';
  const source = randomBytes(48_000);
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), source);
  const packed = await packageSourceAssets({ root, paths: [sourcePath], partBytes: 2048, log: silent });
  assert.equal(packed.files, 1);
  const manifestPath = path.join(root, 'repository-assets/source/manifest.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifest);
  assert.ok(manifest.entries[0].parts.length > 1);
  assert.ok(manifest.entries[0].parts.every(part => part.bytes <= 2048));
  await packageSourceAssets({ root, paths: [sourcePath], partBytes: 2048, log: silent });
  assert.equal(await readFile(manifestPath, 'utf8'), originalManifest, 'unchanged archive stays deterministic');
  await rm(path.join(root, sourcePath));
  assert.equal((await restoreProjectAssets({ root, log: silent })).restored, 1);
  await assert.rejects(readFile(path.join(root, sourcePath)), { code: 'ENOENT' });
  const result = await restoreProjectAssets({ root, all: true, log: silent });
  assert.deepEqual(result, { restored: 1, verified: 1, bytes: source.length + data.length });
  assert.deepEqual(await readFile(path.join(root, sourcePath)), source);
  assert.deepEqual(await readFile(path.join(root, 'public/environments/geometry.bin')), data);
});

test('changed local assets are preserved unless force is explicitly requested', async t => {
  const { root, data } = await fixture(t);
  await restoreProjectAssets({ root, log: silent });
  const filename = path.join(root, 'public/environments/geometry.bin');
  const changed = Buffer.from('user-edited asset');
  await writeFile(filename, changed);
  await assert.rejects(restoreProjectAssets({ root, log: silent }), /Refusing to overwrite a changed local asset/);
  assert.deepEqual(await readFile(filename), changed);
  await restoreProjectAssets({ root, force: true, log: silent });
  assert.deepEqual(await readFile(filename), data);
});

test('compressed or restored checksum mismatch never publishes a partial asset', async t => {
  const { root, archive, manifest } = await fixture(t);
  manifest.entries[0].gzipSha256 = '0'.repeat(64);
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreProjectAssets({ root, log: silent }), /Compressed part checksum mismatch/);
  assert.deepEqual(await readdir(path.join(root, 'public/environments')), []);
  manifest.entries[0].gzipSha256 = digest(await readFile(path.join(archive, 'files/geometry.gz')));
  manifest.entries[0].sha256 = '1'.repeat(64);
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreProjectAssets({ root, log: silent }), /Restored asset checksum mismatch/);
  assert.deepEqual(await readdir(path.join(root, 'public/environments')), []);
});

test('multipart corruption fails before publishing the original source path', async t => {
  const { root } = await fixture(t);
  const relative = 'artifacts/four-horizons/Scene.blend';
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), randomBytes(8000));
  await packageSourceAssets({ root, paths: [relative], partBytes: 1024, log: silent });
  const manifestFile = path.join(root, 'repository-assets/source/manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.entries[0].parts.at(-1).sha256 = '0'.repeat(64);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await rm(path.join(root, relative));
  await assert.rejects(restoreProjectAssets({ root, all: true, log: silent }), /Compressed part checksum mismatch/);
  assert.deepEqual(await readdir(path.dirname(path.join(root, relative))), []);
});

test('archive paths cannot escape their roots or overwrite source code', async t => {
  for (const value of ['../outside', '/absolute', 'C:/outside', 'safe/../outside', 'safe\\outside', 'safe//file', 'safe/file.', 'safe/file ', 'safe/file\0']) {
    assert.throws(() => validateRelativePath(value), /Unsafe archive path/);
  }
  const { root, archive, manifest } = await fixture(t);
  manifest.entries[0].packedPath = '../../outside.gz';
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreProjectAssets({ root, log: silent }), /Unsafe archive path/);
  await assert.rejects(packageSourceAssets({ root, paths: ['src/Game.ts'], log: silent }), /outside public\/artifacts/);
});

test('symlinked output directories are rejected', async t => {
  const { root } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'plane-asset-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreProjectAssets({ root, log: silent }), /Symlink archive path/);
  assert.deepEqual(await readdir(outside), []);
});

test('current-project selection keeps editable source assets and excludes checkpoints and logs', async t => {
  const { root } = await fixture(t);
  const paths = ['public/environments/azure-port.glb', 'public/environments/stream/data.bin', 'artifacts/four-horizons/scene_spec.json', 'artifacts/four-horizons/azure-port/source.blend', 'artifacts/four-horizons/azure-port/checkpoints/old.blend', 'artifacts/four-horizons/azure-port/render.log', 'artifacts/four-horizons/scripts/build.py', 'artifacts/four-horizons/scripts/__pycache__/build.pyc', 'artifacts/distance-detail-20260928/REPORT.md', 'artifacts/full-world-20260928/report.json'];
  for (const relative of paths) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), 'asset'); }
  assert.deepEqual(await collectSourcePaths(root), [paths[0], paths[2], paths[3], paths[6], paths[8], paths[9]].sort());
});
