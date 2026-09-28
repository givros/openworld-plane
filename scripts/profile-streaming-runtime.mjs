// Production-loop cadence and loading evidence for the user-authorized finite view distance.
// No geometry/texture/AA/shadow setting is reduced by this harness.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withDeadline } from './environments/profile-timing.mjs';
import { finalWorldInputs } from './environments/runtime-validation-inputs.mjs';

function summarize(window) {
  const invalid = window.intervals.filter(value => !Number.isFinite(value) || value <= 0).length;
  const sorted = [...window.intervals].sort((a, b) => a - b);
  const percentile = fraction => invalid ? null : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  const p50 = percentile(.5), p95 = percentile(.95), sufficient = sorted.length >= 30 && invalid === 0 && window.coalescedRenderCallbacks === 0;
  const actualFps = window.elapsedMs > 0 ? window.renderedFrames * 1000 / window.elapsedMs : null;
  return {
    actualIntervals: sorted.length, actualRenderedFrames: window.renderedFrames, actualElapsedMs: window.elapsedMs,
    actualRenderedFps: actualFps, p50FrameMs: p50, p95FrameMs: p95,
    medianFps: p50 ? 1000 / p50 : null, p95BudgetEquivalentFps: p95 ? 1000 / p95 : null,
    intervalsOver33_333ms: sorted.filter(value => value > 1000 / 30).length,
    invalidIntervals: invalid, coalescedRenderCallbacks: window.coalescedRenderCallbacks,
    confidence: sufficient ? 'standard' : 'low: fewer than 30 rendered intervals or ambiguous/invalid samples',
    medianMeets30Fps: sufficient && p50 <= 1000 / 30,
    p95Meets30Fps: sufficient && p95 <= 1000 / 30,
    elapsedThroughputMeets30Fps: actualFps !== null && actualFps >= 30,
    targetMeets30Fps: sufficient && p95 <= 1000 / 30 && actualFps >= 30,
    slowFramesDiscarded: false, timeBoundReached: window.timeBoundReached, reason: window.reason,
  };
}

// CPU-only checks catch the important distinction between RAF wakeups and
// actual images when the game deliberately waits for visible chunks.
if (process.argv.includes('--self-test')) {
  const { strict: assert } = await import('node:assert');
  const fixture = { intervals: Array(60).fill(1000 / 60), renderedFrames: 61, elapsedMs: 1020, coalescedRenderCallbacks: 0 };
  assert.equal(summarize(fixture).targetMeets30Fps, true);
  assert.equal(summarize({ ...fixture, elapsedMs: 5000 }).targetMeets30Fps, false);
  assert.equal(summarize({ ...fixture, intervals: [...Array(55).fill(16), ...Array(5).fill(1500)] }).p95FrameMs, 1500);
  assert.equal(summarize({ ...fixture, intervals: [] }).confidence.startsWith('low:'), true);
  assert.equal(summarize({ ...fixture, coalescedRenderCallbacks: 1 }).targetMeets30Fps, false);
  assert.equal(summarize({ ...fixture, intervals: [...fixture.intervals, NaN] }).invalidIntervals, 1);
  console.log('Streaming profiler: 6 CPU checks passed; no browser or GPU started.');
  process.exit(0);
}

const origin = process.env.GAME_URL ?? 'http://127.0.0.1:4173';
const phase = process.env.PROFILE_PHASE ?? 'full';
if (!['gate', 'full'].includes(phase)) throw Error('PROFILE_PHASE must be gate or full');
const cameraMode = process.env.CAMERA_MODE ?? 'pilot';
if (!['pilot', 'review'].includes(cameraMode)) throw Error('CAMERA_MODE must be pilot or review');
const altitude = Number(process.env.ALTITUDE ?? (cameraMode === 'pilot' ? 80 : 120));
if (!Number.isFinite(altitude) || altitude < 10 || altitude > 1000) throw Error('ALTITUDE must be finite and between 10 and 1000m');
const tag = process.env.PROFILE_TAG ?? `streaming-${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (!/^[\w-]+$/.test(tag)) throw Error('PROFILE_TAG must be a filename-safe identifier');
const output = path.resolve('artifacts/four-horizons/streaming-performance', tag);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile('public/environments/world-manifest.json', 'utf8'));
const inputEvidence = await finalWorldInputs(manifest, { requireQuiet: true });
const distances = (process.env.DISTANCES ?? 'current').split(',').map(value => value === 'current' ? null : Number(value));
if (distances.some(value => value !== null && (!Number.isFinite(value) || value < 100 || value > 1200))) throw Error('DISTANCES must contain current or finite distances 100–1200m');
const wanted = process.env.BIOMES?.split(',') ?? manifest.biomes.map(biome => biome.id);
const biomes = wanted.map(id => { const biome = manifest.biomes.find(value => value.id === id); if (!biome) throw Error(`Unknown biome ${id}`); return biome; });
const bounds = phase === 'gate'
  ? { warmupFrames: 30, warmupMs: 4000, stationaryFrames: 90, stationaryMs: 5000, motionMs: 0, motionFrames: 0 }
  : { warmupFrames: 90, warmupMs: 10000, stationaryFrames: 360, stationaryMs: 15000, motionMs: 12000, motionFrames: 1500 };
const report = {
  timestamp: new Date().toISOString(), origin, phase, tag, inputEvidence, distances, bounds, cameraMode, altitude,
  scope: 'Actual production requestAnimationFrame cadence with finite-distance streaming. Stationary windows and real manual-flight routes keep normal atmosphere/aircraft/VFX updates and dynamic shadows. No gl.finish, direct draws, native renderer, frame filtering, adaptive DPR or LOD is used.',
  target: { fps: 30, frameBudgetMs: 1000 / 30, p95ToleranceMs: 0, minimumIntervals: 30 },
  sourceFiles: [], productionBundle: [], network: [], navigationEvents: [], expectedAborts: [], errors: [], rows: [], complete: false,
};
for (const file of ['src/game/Game.ts', 'src/core/Renderer.ts', 'src/core/RenderDistanceController.ts', 'src/core/FullDetailWorldCulling.ts', 'src/systems/Atmosphere.ts', 'src/systems/AtmosphereShader.ts', 'src/systems/PilotCamera.ts', 'src/world/FourBiomeWorld.ts', 'src/world/PassInstanceCuller.ts', 'src/world/SpatialWorldStream.ts', 'src/world/StreamResources.ts', 'src/world/WorldStreamTypes.ts']) {
  const bytes = await readFile(file); report.sourceFiles.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const file of ['public/environments/stream/manifest.json']) {
  const bytes = await readFile(file), pack = JSON.parse(bytes);
  report.sourceFiles.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  report.streamPack = { complete: pack.complete, cellSize: pack.cellSize, sourceManifestSha256: pack.sourceManifestSha256,
    sourceInputs: pack.sourceInputs, originalGltfPrimitives: pack.sourceObjects, placements: pack.placements,
    sourceTriangles: pack.triangles, uniqueTriangles: pack.uniqueTriangles, uniqueGeometries: pack.uniqueGeometries,
    renderBatches: pack.renderBatches, chunkCount: pack.chunks.length, invariants: pack.invariants };
  if (!pack.complete) throw Error('The streaming pack is incomplete');
}
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
let closing = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) report.navigationEvents.push({ url: frame.url(), time: Date.now() }); });
  page.on('pageerror', error => report.errors.push({ kind: 'runtime', message: error.message, time: Date.now() }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text(), time: Date.now() }); });
  page.on('requestfailed', request => {
    const failure=request.failure(),url=request.url();
    // A predicted cell can be evicted while its binary is still in flight.
    // Fetch cancellation is the intended live-streaming path, not a missing
    // asset, so keep it visible in the report without failing the gate.
    if(failure?.errorText==='net::ERR_ABORTED'&&url.includes('/environments/stream/')){
      report.expectedAborts.push({url,resourceType:request.resourceType(),time:Date.now()});
      return;
    }
    report.errors.push({ kind: closing ? 'shutdown-request' : 'request', url, resourceType: request.resourceType(), failure, time: Date.now() });
  });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Network.enable');
  const requests = new Map();
  cdp.on('Network.requestWillBeSent', event => requests.set(event.requestId, { url: event.request.url, started: event.timestamp, wallTime: event.wallTime, type: event.type }));
  cdp.on('Network.responseReceived', event => { const record = requests.get(event.requestId); if (record) Object.assign(record, { status: event.response.status, fromDiskCache: event.response.fromDiskCache ?? false, fromServiceWorker: event.response.fromServiceWorker ?? false }); });
  cdp.on('Network.loadingFinished', event => { const record = requests.get(event.requestId); if (record) report.network.push({ ...record, finished: event.timestamp, transferBytes: event.encodedDataLength }); requests.delete(event.requestId); });
  const start = performance.now(); await page.goto(`${origin}/?review=1`, { timeout: 120000 });
  await page.waitForFunction(() => typeof window.__AIRPLANE_EXPERIENCE__?.getStreamingStats === 'function', null, { timeout: 180000 });
  report.startupMs = performance.now() - start;
  report.browser = browser.version();
  const urls = await page.evaluate(() => Array.from(document.scripts).map(script => script.src).filter(Boolean));
  for (const url of urls) { const response = await page.request.get(url); const bytes = await response.body(); report.productionBundle.push({ url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  report.hardware = await page.evaluate(() => {
    const canvas = document.querySelector('#flight-canvas') ?? document.querySelector('canvas'); const gl = canvas.getContext('webgl2'); const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, dpr: devicePixelRatio, samples: gl.getParameter(gl.SAMPLES), depthBits: gl.getParameter(gl.DEPTH_BITS), context: gl.getContextAttributes(), glError: gl.getError() };
  });
  if (!/NVIDIA.*RTX 3080/i.test(report.hardware.renderer)) throw Error(`Expected RTX3080: ${report.hardware.renderer}`);
  if (report.hardware.width !== 1440 || report.hardware.height !== 900 || report.hardware.dpr !== 1 || report.hardware.samples !== 4 || !report.hardware.context.antialias) throw Error('Native1440×900 DPR1 with4×MSAA is required');
  // Install a measurement function only; the normal game loop remains the renderer.
  await page.evaluate(() => {
    window.__streamingProfileSample = ({ maxFrames, maxDurationMs, requireDuration = false, startMotion = false }) => new Promise(resolve => {
      const api = window.__AIRPLANE_EXPERIENCE__, started = performance.now(), intervals = [], rafIntervals = [], telemetry = [];
      const initialStats = structuredClone(api.getStreamingStats()), initialState = structuredClone(api.state);
      if (startMotion) api.setReviewMode(false);
      let previous = null, previousRendered = null, previousCounter = initialStats.renderedFrames, firstRendered = null;
      let raf = 0, timer = 0, lastTelemetry = -Infinity, done = false, coalescedRenderCallbacks = 0, notReadyRafSamples = 0;
      let waitStarted = initialStats.ready ? null : started, longestNotReadyMs = 0;
      const capture = (now, stats, force = false) => {
        if (!force && now - lastTelemetry < 500) return; lastTelemetry = now;
        telemetry.push({ elapsedMs: now - started, state: structuredClone(api.state), streaming: structuredClone(stats) });
      };
      capture(started, initialStats, true);
      const finish = reason => {
        if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(timer);
        const ended = performance.now(), finalStats = structuredClone(api.getStreamingStats());
        if (startMotion) api.setReviewMode(true);
        if (waitStarted !== null) longestNotReadyMs = Math.max(longestNotReadyMs, ended - waitStarted);
        capture(ended, finalStats, true);
        resolve({ intervals, rafIntervals, telemetry, initialStats, finalStats, initialState, finalState: structuredClone(api.state),
          renderedFrames: finalStats.renderedFrames - initialStats.renderedFrames, coalescedRenderCallbacks,
          frames: intervals.length, rafCallbacks: rafIntervals.length + (previous === null ? 0 : 1),
          elapsedMs: ended - started, notReadyRafSamples, longestNotReadyMs,
          timeToFirstRenderedFrameMs: firstRendered === null ? null : firstRendered - started,
          trailingNoRenderedFrameMs: previousRendered === null ? ended - started : ended - previousRendered,
          reason, timeBoundReached: reason === 'time-limit' });
      };
      const frame = timestamp => {
        if (done) return;
        const now = performance.now(), stats = api.getStreamingStats();
        if (previous !== null) rafIntervals.push(timestamp - previous);
        previous = timestamp;
        // Use completion observation time, rather than the RAF start timestamp,
        // so a slow current draw remains inside the measured interval.
        const newFrames = stats.renderedFrames - previousCounter;
        if (newFrames > 0) {
          if (newFrames !== 1) coalescedRenderCallbacks++;
          if (previousRendered !== null) intervals.push(now - previousRendered);
          firstRendered ??= now; previousRendered = now; previousCounter = stats.renderedFrames;
        } else if (newFrames < 0) coalescedRenderCallbacks++;
        if (!stats.ready) { notReadyRafSamples++; waitStarted ??= now; }
        else if (waitStarted !== null) { longestNotReadyMs = Math.max(longestNotReadyMs, now - waitStarted); waitStarted = null; }
        capture(now, stats);
        if (now - started >= maxDurationMs) finish('time-limit');
        else if (intervals.length >= maxFrames) finish(requireDuration ? 'safety-frame-limit' : 'frame-limit');
        else raf = requestAnimationFrame(frame);
      };
      timer = setTimeout(() => finish('time-limit'), maxDurationMs); raf = requestAnimationFrame(frame);
    });
  });
  const diagnostics = () => withDeadline(page.evaluate(() => window.__AIRPLANE_EXPERIENCE__.diagnostics), 30000, 'Scene diagnostics');
  const sample = options => withDeadline(page.evaluate(options => window.__streamingProfileSample(options), options), options.maxDurationMs + 20000, 'Bounded frame window');
  const waitForView = () => withDeadline(page.evaluate(() => new Promise(resolve => {
    const started = performance.now(), samples = [];
    const poll = () => {
      const stats = window.__AIRPLANE_EXPERIENCE__.getStreamingStats(), elapsedMs = performance.now() - started;
      samples.push({ elapsedMs, stats: structuredClone(stats) });
      if (stats.ready || elapsedMs >= 60000) resolve({ ready: stats.ready, elapsedMs, samples, timeBoundReached: !stats.ready });
      else setTimeout(poll, 500);
    };
    poll();
  })), 80000, 'Visible chunk readiness');
  const quality = (window, diagnostics) => ({
    native4xMsaa: report.hardware.samples === 4,
    dynamicShadowDrawsPresent: diagnostics.renderer.passes?.shadow.calls > 0 && diagnostics.renderer.passes?.shadow.triangles > 0,
    shadowMapSize: window.finalStats.shadowMapSize, shadowCascades: window.finalStats.shadowCascades,
    shadowSettingsPreserved: window.finalStats.shadowMapSize === 4096 && window.finalStats.shadowCascades === 4,
    depthMode: diagnostics.renderer.depthMode, sourceDensityReductionRequested: false, distanceReductionUserAuthorized: true,
    sampledBaseDistanceRange: [Math.min(...window.telemetry.map(item => item.streaming.viewDistance)), Math.max(...window.telemetry.map(item => item.streaming.viewDistance))],
    sampledCameraFarRange: [Math.min(...window.telemetry.map(item => item.streaming.cameraFar)), Math.max(...window.telemetry.map(item => item.streaming.cameraFar))],
  });
  for (const distance of distances) {
    await page.evaluate(distance => { const api = window.__AIRPLANE_EXPERIENCE__; if (!api.setRenderDistance) throw Error('Review API setRenderDistance(meters|null) is not yet available'); api.setRenderDistance(distance); }, distance);
    for (const biome of biomes) {
      const setupStarted = performance.now(), networkStart = report.network.length;
      await withDeadline(page.evaluate(({ id, cameraMode, altitude }) => {
        const api = window.__AIRPLANE_EXPERIENCE__;
        if (cameraMode === 'review') { api.reviewBiome(id, altitude); return; }
        api.setReviewMode(true); api.visitBiome(id);
        const state = api.state;
        api.setFlightState({ position: { ...state.position, y: state.position.y - state.altitude + altitude },
          speed: 45, throttle: .72, rpm: 2002, pitch: .025, bank: 0, verticalSpeed: 0, flightPathAngle: 0,
          angleOfAttack: .025, pitchRate: 0, rollRate: 0, yawRate: 0, grounded: false, crashed: false, phase: 'flight' });
      }, { id: biome.id, cameraMode, altitude }), 45000, `${biome.id} view setup`);
      const loading = await waitForView();
      const warmup = await sample({ maxFrames: bounds.warmupFrames, maxDurationMs: bounds.warmupMs });
      const before = await diagnostics();
      const setupAndWarmupMs = performance.now() - setupStarted;
      const stationary = await sample({ maxFrames: bounds.stationaryFrames, maxDurationMs: bounds.stationaryMs });
      const after = await diagnostics();
      const key = `${cameraMode}-${altitude}m-${distance ?? 'current'}-${biome.id}-stationary`;
      await page.screenshot({ path: path.join(output, `${key}.png`), timeout: 30000 });
      const row = { distanceRequested: distance, biome: biome.id, mode: 'stationary', cameraMode, requestedAltitude: altitude, setupAndWarmupMs, loading,
        warmup: { frames: warmup.frames, renderedFrames: warmup.renderedFrames, elapsedMs: warmup.elapsedMs, reason: warmup.reason },
        measurement: summarize(stationary), window: stationary, before, after, renderedFrameDelta: stationary.renderedFrames,
        screenshot: `${key}.png`, networkWindow: { firstRecord: networkStart, lastRecord: report.network.length }, quality: quality(stationary, after) };
      report.rows.push(row); await save(); console.log('STREAMING', JSON.stringify({ biome: biome.id, distance, mode: row.mode,
        ...row.measurement, passes: after.renderer.passes, residentTriangles: stationary.finalStats.streaming.residentTriangles,
        activeChunks: stationary.finalStats.streaming.activeChunks, cameraFar: stationary.finalStats.cameraFar,
        visiblePending: stationary.finalStats.streaming.visiblePending }));
      if (phase !== 'full') continue;
      // One starting state, then ordinary simulation and chase-camera updates.
      // No per-frame teleport, reviewCamera render or fixed-delta substitute.
      const route = await page.evaluate(({ id, altitude }) => {
        const api = window.__AIRPLANE_EXPERIENCE__; api.setReviewMode(true); api.visitBiome(id); api.setTimeScale(1);
        api.setControls({ throttle: 0, pitch: 0, roll: 0, rudder: 0, brake: false });
        const state = api.state;
        api.setFlightState({ position: { ...state.position, y: state.position.y - state.altitude + altitude },
          speed: 55, throttle: .8, rpm: 2240, pitch: .025, bank: 0, verticalSpeed: 0, flightPathAngle: 0, angleOfAttack: .025, pitchRate: 0, rollRate: 0, yawRate: 0, grounded: false, crashed: false, phase: 'flight' });
        return { initial: structuredClone(api.state), controls: { throttle: 0, pitch: 0, roll: 0, rudder: 0, brake: false }, requestedDurationMs: 12000, simulation: 'ordinary game manual-flight physics and camera, real wall-clock route; actual positions retained in telemetry' };
      }, { id: biome.id, altitude });
      const motionLoading = await waitForView();
      const motionBefore = await diagnostics();
      const motion = await sample({ maxFrames: bounds.motionFrames, maxDurationMs: bounds.motionMs, requireDuration: true, startMotion: true });
      const motionAfter = await diagnostics();
      const motionKey = `pilot-${altitude}m-${distance ?? 'current'}-${biome.id}-motion`;
      await page.screenshot({ path: path.join(output, `${motionKey}.png`), timeout: 30000 });
      const startPosition = motion.initialState.position, finalPosition = motion.finalState.position;
      const travelled = Math.hypot(finalPosition.x - startPosition.x, finalPosition.y - startPosition.y, finalPosition.z - startPosition.z);
      const motionRow = { distanceRequested: distance, biome: biome.id, mode: 'motion', route, loading: motionLoading,
        measurement: summarize(motion), window: motion, before: motionBefore, after: motionAfter, renderedFrameDelta: motion.renderedFrames,
        displacementMeters: travelled, movementVerified: travelled > 100 && !motion.finalState.crashed,
        screenshot: `${motionKey}.png`, quality: quality(motion, motionAfter) };
      report.rows.push(motionRow); await save(); console.log('STREAMING', JSON.stringify({ biome: biome.id, distance, mode: motionRow.mode,
        displacementMeters: travelled, ...motionRow.measurement, passes: motionAfter.renderer.passes,
        residentTriangles: motion.finalStats.streaming.residentTriangles, activeChunks: motion.finalStats.streaming.activeChunks,
        cameraFar: motion.finalStats.cameraFar, visiblePending: motion.finalStats.streaming.visiblePending }));
    }
  }
  report.expectedRows = distances.length * biomes.length * (phase === 'full' ? 2 : 1);
  report.complete = report.rows.length === report.expectedRows;
  report.assessment = { cadenceIsNotGpuTimestamp: true,
    allRowsMedianMeet30Fps: report.rows.every(row => row.measurement.medianMeets30Fps),
    allRowsP95Meet30Fps: report.rows.every(row => row.measurement.p95Meets30Fps),
    allRowsMeet30Fps: report.rows.every(row => row.measurement.targetMeets30Fps),
    allRowsSufficientSamples: report.rows.every(row => row.measurement.confidence === 'standard'),
    allViewsReadyBeforeSampling: report.rows.every(row => row.loading.ready),
    allMotionRoutesMoved: report.rows.filter(row => row.mode === 'motion').every(row => row.movementVerified),
    dynamicShadowsObservedAllRows: report.rows.every(row => row.quality.dynamicShadowDrawsPresent && row.quality.shadowSettingsPreserved),
    preloadContinuity: 'Inspect recorded streaming counters and actual positions; telemetry is not by itself proof that every visible chunk was available.' };
  if (!report.complete || !report.assessment.allRowsSufficientSamples || !report.assessment.allViewsReadyBeforeSampling || !report.assessment.allMotionRoutesMoved || !report.assessment.dynamicShadowsObservedAllRows || report.errors.some(error => ['runtime', 'console', 'request'].includes(error.kind))) process.exitCode = 1;
  // A measured target failure is preserved distinctly from a broken harness.
  if (!process.exitCode && process.env.REQUIRE_30_FPS === '1' && !report.assessment.allRowsMeet30Fps) process.exitCode = 2;
} catch (error) { report.errors.push({ kind: 'harness', message: error.stack ?? String(error) }); process.exitCode = 1; }
finally { closing = true; await browser.close(); report.finishedAt = new Date().toISOString(); await save(); }
