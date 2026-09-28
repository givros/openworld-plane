import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

const output = process.env.RASTER_COMPARE_OUTPUT ?? 'artifacts/four-horizons/target-30fps/triangle-raster-instance-oracle';
const pairURL = process.env.RASTER_PAIR_URL ?? '/artifacts/four-horizons/target-30fps/native-dxr-corrected';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--js-flags=--max-old-space-size=8192'] });
const errors = [], rows = [], images = [], comparisons = [], captures = new Map();
let setup, inventory;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', message => { if (message.text().startsWith('RASTER ') && !message.text().startsWith('RASTER CANONICAL_READY')) console.log(message.text()); if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await page.goto('http://127.0.0.1:5173/raster-probe.html');
  await page.waitForFunction(() => window.rasterProbeModuleReady);
  await page.evaluate(async pairURL => {
    window.rasterProbe = await window.TriangleRasterProbe.create({ pairURL });
    await rasterProbe.setBlock(1);
    await rasterProbe.loadCanonicalWorld();
    const module = await import('/src/experiments/triangle-raster-instance-oracle.mjs');
    window.instanceOracle = await module.createCompleteInstanceOracle(rasterProbe);
  }, pairURL);
  setup = await page.evaluate(() => rasterProbe.summary());
  inventory = await page.evaluate(() => instanceOracle.inventory);
  console.log('ORACLE INVENTORY', JSON.stringify(inventory));
  for (const mode of ['canonical', 'native-instances', 'pulled-instances', 'selected']) {
    await page.evaluate(mode => instanceOracle.setMode(mode), mode);
    for (let frame = 0; frame < 2; frame++) {
      const row = { mode, frame, ...await page.evaluate(() => rasterProbe.frame()) };
      rows.push(row); console.log('ORACLE FRAME', JSON.stringify(row));
    }
    const capture = await page.evaluate(() => rasterProbe.capture());
    const bytes = Buffer.from(capture.png.split(',')[1], 'base64');
    await writeFile(`${output}/${mode}.png`, bytes); captures.set(mode, PNG.sync.read(bytes));
    images.push({ file: `${mode}.png`, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const [first, second] of [['canonical', 'native-instances'], ['native-instances', 'pulled-instances'], ['canonical', 'pulled-instances'], ['pulled-instances', 'selected']]) {
    const a = captures.get(first), b = captures.get(second), diff = new PNG({ width: a.width, height: a.height });
    let changed = 0, above8 = 0, above32 = 0, maximum = 0, total = 0;
    const pixels = a.width * a.height, histogram = new Uint32Array(256);
    for (let p = 0; p < pixels; p++) {
      let error = 0;
      for (let c = 0; c < 3; c++) { const delta = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); total += delta; error = Math.max(error, delta); diff.data[p * 4 + c] = Math.min(255, delta * 4); }
      diff.data[p * 4 + 3] = 255; histogram[error]++; changed += Number(error > 0); above8 += Number(error > 8); above32 += Number(error > 32); maximum = Math.max(maximum, error);
    }
    const name = `${first}-vs-${second}-x4.png`;
    await writeFile(`${output}/${name}`, PNG.sync.write(diff));
    comparisons.push({ first, second, pixels, changed, changedFraction: changed / pixels, above8, above32, maximum, meanAbsoluteRGB: total / (pixels * 3), histogram: Array.from(histogram), difference: name });
  }
  await page.evaluate(() => { instanceOracle.dispose(); rasterProbe.dispose(); });
  await writeFile(`${output}/report.json`, JSON.stringify({ timestamp: new Date().toISOString(), setup, inventory, rows, comparisons, images, errors,
    scope: 'Diagnostic beauty only, shadows disabled. Native-instances retains original GLB triangle order/materials/shaders and source object draw sorting; only complete placements absent from native nearest hits are removed. Pulled-instances draws the same complete placement set using the atlas shader and BVH triangle ordering. Selected is the sparse nearest-hit triangle list.' }, null, 2));
  console.log(JSON.stringify({ comparisons: comparisons.map(({ histogram, ...x }) => x), errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  errors.push(error.stack ?? String(error));
  await writeFile(`${output}/failure.json`, JSON.stringify({ setup, inventory, rows, errors }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { await browser.close(); }
