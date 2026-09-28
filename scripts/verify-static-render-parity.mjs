// Private desktop browser only; never attaches to an interactive user browser.
// Unchanged legacy rerenders exhibited eight pixels differing by one 8-bit level.
// Retain the strict measurements and bound that observed rendering noise tightly.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve(process.env.STATIC_PARITY_DIR ?? 'artifacts/static-render-20260928/parity');
const origin = process.env.GAME_URL ?? 'http://127.0.0.1:4180';
const biomes = (process.env.STATIC_PARITY_BIOMES ?? 'verdant-airfield,azure-port,alpine-lake,sunstone-oasis').split(',').filter(Boolean);
const residentPercent = Number(process.env.RESIDENT_PERCENT ?? 0);
if (!Number.isFinite(residentPercent) || residentPercent < 0 || residentPercent > 100) throw Error('RESIDENT_PERCENT must be between 0 and 100');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw Error('Parity verification is local-only');
const steps = [
  { name: 'initial', offset: [0, 0, 0], yaw: 0 },
  { name: 'translation', offset: [13, 0, 18], yaw: 0 },
  { name: 'turn', offset: [13, 0, 18], yaw: .32 },
  { name: 'sector-arrival', offset: [180, 0, 130], yaw: .32 },
  { name: 'return', offset: [0, 0, 0], yaw: 0 },
];
const report = {
  complete: false, timestamp: new Date().toISOString(), origin,
  viewport: [1440, 900], dpr: 1, viewDistance: 600, residentPercent, biomes,
  tolerance: { maxChannelDiff: 1, maxChangedPixelFraction: .00001,
    reason: 'Unchanged legacy control rerenders differed by one level on eight pixels; no asset or shader changes.' },
  errors: [], networkFailures: [], warmups: [], checks: [],
};
await mkdir(output, { recursive: true });
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const browser = await chromium.launch({ headless: true, args: [
  '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', error => report.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
page.on('requestfailed', request => {
  if (!request.failure()?.errorText?.includes('ERR_ABORTED')) report.networkFailures.push({ url: request.url(), failure: request.failure() });
});
page.on('response', response => {
  if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() });
});
await page.route('**/assets/index-*.js', async route => {
  const response = await route.fetch(), source = await response.text();
  if (source.split('this.expose()').length !== 2) throw Error('Expected one application exposure point');
  report.bundleSha256 = createHash('sha256').update(source).digest('hex');
  await route.fulfill({ response, body: source.replace('this.expose()', '(window.__benchmarkGame=this,this.expose())') });
});

async function settle() {
  await page.evaluate(async () => {
    const g = window.__benchmarkGame;
    g.syncPresentation(0, true); await g.world.whenReady();
    g.syncPresentation(0, true); await g.world.whenReady();
  });
  await page.waitForFunction(() => {
    const world = window.__benchmarkGame.world;
    return world.isViewReady && world.streamingStats.loadingChunks === 0;
  }, null, { timeout: 300000 });
  await page.evaluate(() => window.__benchmarkGame.syncPresentation(0, true));
}

async function warmup(biome) {
  const result = await page.evaluate(() => {
    const g = window.__benchmarkGame, history = [];
    g.syncPresentation(0, true);
    for (let attempt = 0; attempt < 8; attempt++) {
      g.rendering.render(true);
      const cache = structuredClone(g.rendering.shadowCacheDiagnostics);
      history.push(cache);
      if ([2, 3].every(index => cache?.cascades[index]?.cached === true &&
          cache.cascades[index].fallback === false && cache.cascades[index].reusedTexels > 0)) {
        return { ready: true, attempts: attempt + 1, history };
      }
    }
    return { ready: false, attempts: history.length, history };
  });
  report.warmups.push({ biome, ...result });
  if (!result.ready) throw Error(`Deferred shadow cache did not become active at ${biome}`);
}

async function check(biome, step) {
  await settle();
  const result = await page.evaluate(() => {
    const g = window.__benchmarkGame, rendering = g.rendering, renderer = rendering.renderer;
    const gl = renderer.getContext(), culler = rendering.instanceCulling.culler, cache = rendering.shadowCache;
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    if (!cache || !culler.enabled) throw Error('Both exact visibility and the shadow cache must be active');
    if (typeof culler.compactRenderLists !== 'boolean' || typeof culler.staticStreamLeasesEnabled !== 'boolean') {
      throw Error('Missing real culler optimization switches; refusing to test ineffective ad-hoc properties');
    }
    g.syncPresentation(0, true);
    const cameraMatrix = rendering.camera.matrixWorld.toArray();
    const projection = rendering.camera.projectionMatrix.toArray();
    const aircraftMatrix = g.aircraft.root.matrixWorld.toArray();
    const original = {
      compact: culler.compactRenderLists, leases: culler.staticStreamLeasesEnabled,
      withShadowRegion: culler.withShadowRegion,
    };
    const frames = [], images = {}, selectedRegions = [];
    // Observe the actual native shadow submission after region selection. In
    // particular, a caster with no beauty draw can still affect a visible pixel.
    culler.withShadowRegion = function (passIndex, frustum, callback) {
      return original.withShadowRegion.call(this, passIndex, frustum, () => {
        let batches = 0, instances = 0, offscreenBatches = 0, offscreenInstances = 0, frustumOnlyBatches = 0;
        for (const state of this.states) {
          const draw = state.draws[passIndex + 1], proxy = draw.region?.proxy;
          if (!proxy?.visible || proxy.count === 0) continue;
          batches++; instances += proxy.count;
          if (!state.draws[0].proxy.visible || state.draws[0].proxy.count === 0) {
            offscreenBatches++; offscreenInstances += proxy.count;
          }
          if (this.options.isFrustumOnlySource?.(state.descriptor.source)) frustumOnlyBatches++;
        }
        selectedRegions.push({ passIndex, batches, instances, offscreenBatches, offscreenInstances, frustumOnlyBatches });
        return callback();
      });
    };
    const read = () => {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.isContextLost()) throw Error('WebGL context was lost during parity capture');
      return pixels;
    };
    const draw = (name, enabled) => {
      culler.compactRenderLists = enabled; culler.staticStreamLeasesEnabled = enabled;
      selectedRegions.length = 0;
      // Enter the stable-lease path before capturing: the first prepare after
      // enabling intentionally performs a complete audit and is not the fast path.
      rendering.prepareWorldCulling();
      // All modes build fresh complete static shadows from this exact same
      // frozen world. An old cached image cannot conceal a missing caster.
      cache.invalidate(); rendering.render(true);
      const pixels = read(), diagnostics = structuredClone(rendering.shadowCacheDiagnostics);
      for (const index of [2, 3]) if (diagnostics?.cascades[index]?.cached !== true || diagnostics.cascades[index].fallback !== false) {
        throw Error(`${name}: deferred shadow cascade ${index} fell back to a different path`);
      }
      const same = (actual, expected) => actual.length === expected.length && actual.every((value, index) => value === expected[index]);
      if (!same(rendering.camera.matrixWorld.elements, cameraMatrix) || !same(rendering.camera.projectionMatrix.elements, projection) ||
          !same(g.aircraft.root.matrixWorld.elements, aircraftMatrix)) throw Error(`${name}: frozen pose changed`);
      let frustumOnlyBeautyBatches = 0;
      for (const state of culler.states) if (state.draws[0].proxy.visible && state.draws[0].proxy.count > 0 &&
          culler.options.isFrustumOnlySource?.(state.descriptor.source)) frustumOnlyBeautyBatches++;
      frames.push({ name, enabled, passes: structuredClone(rendering.passes),
        selections: structuredClone(culler.statistics), shadowRegions: structuredClone(selectedRegions),
        frustumOnlyBeautyBatches, shadowCache: diagnostics,
        staticStream: structuredClone(culler.staticLeaseStatistics),
      });
      if(enabled&&!(culler.staticLeaseStatistics.reusedSources>0))throw Error('Parity did not exercise stable static leases');
      return pixels;
    };
    const compare = (a, b) => {
      let changed = 0, changedChannels = 0, maxChannelDiff = 0, total = 0;
      for (let pixel = 0; pixel < a.length; pixel += 4) {
        let pixelChanged = false;
        for (let channel = 0; channel < 4; channel++) {
          const delta = Math.abs(a[pixel + channel] - b[pixel + channel]);
          total += delta; maxChannelDiff = Math.max(maxChannelDiff, delta);
          if (delta) { changedChannels++; pixelChanged = true; }
        }
        if (pixelChanged) changed++;
      }
      return { changedPixels: changed, changedChannels, maxChannelDiff, meanAbsoluteChannelError: total / a.length };
    };
    try {
      const legacy = draw('legacy', false), optimized = draw('optimized', true), restored = draw('legacy-restored', false);
      const forward = compare(legacy, optimized), reverse = compare(legacy, restored);
      const maxChangedPixels=Math.floor(width*height*.00001);
      const failed = forward.maxChannelDiff > 1 || reverse.maxChannelDiff > 1 ||
        forward.changedPixels>maxChangedPixels || reverse.changedPixels>maxChangedPixels;
      if (failed) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'), image = context.createImageData(width, height);
        for (const [name, pixels] of [['legacy', legacy], ['optimized', optimized], ['legacy-restored', restored], ['difference', null]]) {
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const input = (y * width + x) * 4, output = ((height - 1 - y) * width + x) * 4;
            for (let channel = 0; channel < 3; channel++) image.data[output + channel] = pixels ? pixels[input + channel] :
              Math.min(255, Math.max(Math.abs(legacy[input + channel] - optimized[input + channel]),
                Math.abs(legacy[input + channel] - restored[input + channel])) * 8);
            image.data[output + 3] = 255;
          }
          context.putImageData(image, 0, 0); images[name] = canvas.toDataURL('image/png').split(',')[1];
        }
      }
      return { width, height, pixels: width * height, forward, reverse, failed, frames, images,
        cameraMatrix, projection, aircraftMatrix, streaming: g.world.streamingStats };
    } finally {
      culler.withShadowRegion = original.withShadowRegion;
      culler.compactRenderLists = original.compact; culler.staticStreamLeasesEnabled = original.leases;
    }
  });
  const { images, ...metrics } = result;
  for (const [name, data] of Object.entries(images)) await writeFile(path.join(output, `${biome}-${step.name}-${name}.png`), Buffer.from(data, 'base64'));
  report.checks.push({ biome, step, ...metrics });
  await save();
  console.log(JSON.stringify({ biome, step: step.name, forward: result.forward, reverse: result.reverse, failed: result.failed }));
  if (result.failed) throw Error(`Pixel parity exceeded measured control noise at ${biome}/${step.name}`);
}

try {
  const query = new URLSearchParams({ review: '1', fragmentShadows: '1', cacheShadows: '1', pruneTraversal: '1', immutableWorld: '1', clearView: '1', view: '600' });
  if (residentPercent) query.set('resident', String(residentPercent));
  report.url = `${origin}/?${query}`;
  await page.goto(report.url, { timeout: 120000 });
  await page.waitForFunction(() => window.__benchmarkGame?.startupReady && window.__benchmarkGame.world.isViewReady, null, { timeout: 360000 });
  report.startup = await page.evaluate(() => {
    const g = window.__benchmarkGame, api = window.__AIRPLANE_EXPERIENCE__, culler = g.rendering.instanceCulling.culler;
    g.loop.stop(); api.setReviewMode(true); api.setRenderDistance(600);
    if (typeof culler.compactRenderLists !== 'boolean' || typeof culler.staticStreamLeasesEnabled !== 'boolean') throw Error('Missing optimization switches');
    const gl = g.rendering.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { stats: api.getStreamingStats(), browser: navigator.userAgent,
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      msaaSamples: gl.getParameter(gl.SAMPLES), switches: { compact: culler.compactRenderLists, leases: culler.staticStreamLeasesEnabled } };
  });
  for (const biome of biomes) {
    await page.evaluate(biome => {
      const g = window.__benchmarkGame;
      window.__AIRPLANE_EXPERIENCE__.visitBiome(biome); g.reviewPose = true;
      window.__staticParityCamera = g.rendering.camera.position.clone();
      window.__staticParityForward = g.rendering.camera.getWorldDirection(g.rendering.camera.position.clone());
    }, biome);
    await settle(); await warmup(biome);
    for (const step of steps) {
      await page.evaluate(step => {
        const g = window.__benchmarkGame;
        const p = window.__staticParityCamera.clone().add({ x: step.offset[0], y: step.offset[1], z: step.offset[2] });
        const d = window.__staticParityForward.clone(), x = d.x, z = d.z;
        d.x = x * Math.cos(step.yaw) + z * Math.sin(step.yaw); d.z = z * Math.cos(step.yaw) - x * Math.sin(step.yaw);
        g.rendering.camera.position.copy(p); g.rendering.camera.lookAt(p.clone().addScaledVector(d, 100));
        g.rendering.camera.fov = 48; g.rendering.camera.updateProjectionMatrix();
      }, step);
      await check(biome, step);
    }
    await page.screenshot({ path: path.join(output, `${biome}-end.png`) });
  }
  const frames = report.checks.flatMap(check => check.frames);
  const regions = frames.flatMap(frame => frame.shadowRegions);
  report.coverage = {
    checks: report.checks.length, comparedFrames: frames.length,
    ordinaryBeautyObserved: frames.some(frame => frame.frustumOnlyBeautyBatches > 0),
    deferredOffscreenCastersObserved: regions.some(region => region.passIndex >= 2 && region.offscreenInstances > 0),
    deferredOrdinaryCastersObserved: regions.some(region => region.passIndex >= 2 && region.frustumOnlyBatches > 0),
  };
  if (!report.coverage.ordinaryBeautyObserved || !report.coverage.deferredOffscreenCastersObserved || !report.coverage.deferredOrdinaryCastersObserved) {
    throw Error(`The selected poses did not exercise required ordinary/deferred caster coverage: ${JSON.stringify(report.coverage)}`);
  }
  if (report.errors.length || report.networkFailures.length) throw Error('Browser or network errors occurred; inspect report.json');
  report.complete = true;
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await save();
  await browser.close();
}
