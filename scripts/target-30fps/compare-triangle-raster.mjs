import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
const output = process.env.RASTER_COMPARE_OUTPUT ?? 'artifacts/four-horizons/target-30fps/triangle-raster-canonical';
const pairURL = process.env.RASTER_PAIR_URL ?? '/artifacts/four-horizons/target-30fps/native-dxr-corrected';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--js-flags=--max-old-space-size=8192'] });
const errors = [], captures = {}, rows = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let setup, canonical;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', message => { if (message.text().startsWith('RASTER ')) console.log(message.text()); if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await page.goto('http://127.0.0.1:5173/raster-probe.html'); await page.waitForFunction(() => window.rasterProbeModuleReady);
  await page.evaluate(async pairURL => { window.rasterProbe = await window.TriangleRasterProbe.create({ pairURL }); }, pairURL);
  setup = await page.evaluate(() => rasterProbe.summary());
  await page.evaluate(() => rasterProbe.setBlock(1));
  canonical = await page.evaluate(() => rasterProbe.loadCanonicalWorld());
  for (const mode of ['canonical', 'selected']) {
    await page.evaluate(mode => rasterProbe.setMode(mode), mode);
    for (let i = 0; i < 2; i++) { const frame = await page.evaluate(() => rasterProbe.frame()); rows.push({ mode, frame: i, ...frame }); console.log('COMPARE FRAME', mode, i, JSON.stringify(frame)); }
    for (let repeat = 0; repeat < 2; repeat++) {
      const capture = await page.evaluate(() => rasterProbe.capture()), name = `${mode}-${repeat}.png`;
      captures[name] = Buffer.from(capture.png.split(',')[1], 'base64'); await writeFile(`${output}/${name}`, captures[name]);
    }
  }
  const a = PNG.sync.read(captures['canonical-0.png']), b = PNG.sync.read(captures['selected-0.png']);
  const diff = new PNG({ width: a.width, height: a.height }), mask = new Uint8Array(a.width * a.height);
  const histogram = new Uint32Array(256); let absolute = 0, changed = 0, above8 = 0, above32 = 0, maximum = 0;
  for (let p = 0; p < mask.length; p++) {
    let error = 0;
    for (let c = 0; c < 3; c++) { const delta = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); absolute += delta; error = Math.max(error, delta); diff.data[p * 4 + c] = Math.min(255, delta * 4); }
    diff.data[p * 4 + 3] = 255; mask[p] = error; histogram[error]++; changed += Number(error > 0); above8 += Number(error > 8); above32 += Number(error > 32); maximum = Math.max(maximum, error);
  }
  await writeFile(`${output}/difference-x4.png`, PNG.sync.write(diff));
  const stability = Object.fromEntries(['canonical', 'selected'].map(mode => [mode, captures[`${mode}-0.png`].equals(captures[`${mode}-1.png`])]));
  const materialAttribution = new Map();
  const manifest = JSON.parse(await readFile('public/acceleration/visibility-world/attribute-manifest.json', 'utf8'));
  const batches = JSON.parse(await readFile(`public/acceleration/visibility-world/${manifest.sourceBatches}`, 'utf8'));
  const materialByInstance = new Uint32Array(manifest.placements); for (const batch of batches) materialByInstance.fill(batch.materialId, batch.sourceStart, batch.sourceStart + batch.count);
  const hitFile = `${pairURL.replace(/^\//, '')}/hits.bin`, hitBytes = await readFile(hitFile), hits = new Uint32Array(hitBytes.buffer, hitBytes.byteOffset, hitBytes.byteLength / 4);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const seen = new Set();
    for (let sample = 0; sample < 4; sample++) { const instance = hits[(p * 4 + sample) * 8]; if (instance !== 0xffffffff) seen.add(materialByInstance[instance]); }
    for (const id of seen) { const count = materialAttribution.get(id) ?? { id, name: manifest.materials[id].name, side: manifest.materials[id].side, polygonOffset: manifest.materials[id].polygonOffset, changedPixels: 0, above8Pixels: 0, summedMaximum: 0 }; count.changedPixels++; count.above8Pixels += Number(mask[p] > 8); count.summedMaximum += mask[p]; materialAttribution.set(id, count); }
  }
  const report = { timestamp: new Date().toISOString(), scope: 'Same-camera beauty-only comparison against production FourBiomeWorld.load GLB geometry, batching and source materials. Same Renderer/Atmosphere/PMREM/fog/4xMSAA/log-depth, shadows explicitly disabled in both modes.', setup, canonical, rows, stability,
    comparison: { pixels: mask.length, changedPixels: changed, changedFraction: changed / mask.length, above8Pixels: above8, above32Pixels: above32, maxChannelDifference: maximum, meanAbsoluteRGB: absolute / (mask.length * 3), maxChannelHistogram: Array.from(histogram) },
    materialAttribution: [...materialAttribution.values()].sort((a, b) => b.above8Pixels - a.above8Pixels), attributionScope: 'Materials of native nearest hits at changed pixels; several materials can be attributed to one MSAA pixel. This identifies affected surfaces, not the cause of each error.',
    images: Object.entries(captures).map(([file, bytes]) => ({ file, sha256: hash(bytes) })), errors };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stability, comparison: report.comparison, materials: report.materialAttribution.slice(0, 15), errors }, null, 2));
  await page.evaluate(() => rasterProbe.dispose());
  if (errors.length || !stability.canonical || !stability.selected) process.exitCode = 1;
} catch (error) { errors.push(error.stack ?? String(error)); await writeFile(`${output}/failure.json`, JSON.stringify({ setup, canonical, rows, errors }, null, 2)); console.error(error); process.exitCode = 1; }
finally { await browser.close(); }
