import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const output = process.env.RASTER_OUTPUT ?? 'artifacts/four-horizons/target-30fps/triangle-raster-beauty';
const blocks = (process.env.RASTER_BLOCKS ?? '1,8,32,64').split(',').map(Number);
const samples = Number(process.env.RASTER_SAMPLES ?? 5), warmups = Number(process.env.RASTER_WARMUPS ?? 3);
await mkdir(path.join(output, 'shaders'), { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--js-flags=--max-old-space-size=8192'] });
const errors = [], rows = [];
let page, summary;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', message => { if (message.text().startsWith('RASTER ')) console.log(message.text()); if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await page.goto('http://127.0.0.1:5173/raster-probe.html', { timeout: 60000 });
  await page.waitForFunction(() => window.rasterProbeModuleReady, null, { timeout: 60000 });
  await page.evaluate(async options => { window.rasterProbe = await window.TriangleRasterProbe.create(options); }, {
    datasetURL: process.env.RASTER_DATASET_URL ?? '/acceleration/visibility-world',
    pairURL: process.env.RASTER_PAIR_URL ?? '/artifacts/four-horizons/target-30fps/native-dxr-world',
  });
  summary = await page.evaluate(() => rasterProbe.summary());
  await writeFile(path.join(output, 'setup.json'), JSON.stringify(summary, null, 2));
  for (const block of blocks) {
    const setup = await page.evaluate(block => rasterProbe.setBlock(block), block), timings = [], warmupTimings = [];
    for (let i = 0; i < warmups + samples; i++) {
      const frame = await page.evaluate(() => rasterProbe.frame());
      if (i < warmups) warmupTimings.push(frame); else timings.push(frame);
      console.log('RASTER FRAME', block, i, JSON.stringify(frame));
    }
    const capture = await page.evaluate(() => rasterProbe.capture());
    const png = Buffer.from(capture.png.split(',')[1], 'base64');
    await writeFile(path.join(output, `blocks-${block}.png`), png);
    rows.push({ ...setup, warmupTimings, timings, screenshot: `blocks-${block}.png`, screenshotSha256: sha(png), captureGlError: capture.glError });
    await writeFile(path.join(output, 'partial.json'), JSON.stringify({ summary, rows, errors }, null, 2));
  }
  const shaders = await page.evaluate(() => rasterProbe.exportShaders()), shaderIndex = [];
  for (const shader of shaders) {
    const filename = `${String(shader.index).padStart(3, '0')}-${shader.type}${shader.pulled ? '-original-triangles' : ''}.glsl`;
    await writeFile(path.join(output, 'shaders', filename), shader.source);
    shaderIndex.push({ file: `shaders/${filename}`, type: shader.type, pulled: shader.pulled, bytes: Buffer.byteLength(shader.source), sha256: sha(shader.source) });
  }
  const files = ['src/experiments/VisibleTriangleRasterAdapter.ts', 'src/experiments/triangle-raster-probe.mjs', 'src/experiments/loadTriangleRasterDataset.mjs', 'scripts/target-30fps/profile-triangle-raster.mjs', 'public/acceleration/visibility-world/attribute-manifest.json'];
  const inputs = await Promise.all(files.map(async file => ({ file, sha256: sha(await readFile(file)) })));
  const report = { timestamp: new Date().toISOString(), summary, rows, shaderIndex, inputs, errors,
    scope: 'Actual RTX3080 WebGL2 full-dataset original-triangle beauty raster feasibility. Native PBR/PMREM/fog/log-depth/4xMSAA retained; shadows explicitly disabled only to isolate beauty cost. Not game FPS or appearance parity.' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await page.evaluate(() => rasterProbe.dispose());
  if (errors.length) process.exitCode = 1;
} catch (error) {
  errors.push(error.stack ?? String(error));
  let diagnostics = null;
  try { diagnostics = await page?.evaluate(() => ({ shaderErrors: window.rasterProbe?.shaderErrors, shaders: window.rasterProbe?.exportShaders() })); } catch {}
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ timestamp: new Date().toISOString(), summary, rows, errors, diagnostics }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { await browser.close(); }
