// Private local-only desktop diagnostics. Never attaches to a user's browser.
// Basic materials are a measurement instrument, never a product quality mode.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const origin = process.env.GAME_URL ?? 'http://127.0.0.1:4180';
const output = path.resolve(process.env.FULL_WORLD_OUTPUT ?? process.env.PROFILE_ROOT ?? 'artifacts/full-world-20260928');
const biomes = (process.env.BIOMES ?? 'azure-port').split(',').filter(Boolean);
const distances = (process.env.DISTANCES ?? '6000').split(',').map(Number);
const detailSweep=process.env.DETAIL_SWEEP?process.env.DETAIL_SWEEP.split(',').map(Number):[null];
if(detailSweep.some(value=>value!==null&&(!Number.isFinite(value)||value<.5||value>12)))throw Error('Invalid detail sweep');
const flightMs = Number(process.env.FLIGHT_MS ?? 10000);
const viewport={width:Number(process.env.BENCH_WIDTH??1440),height:Number(process.env.BENCH_HEIGHT??900)};
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw Error('The full-world benchmark is local-only');
if (!distances.length || distances.some(value => !Number.isFinite(value) || value < 100 || value > 6000)) throw Error('DISTANCES must contain values between 100 and 6000');
if (!Number.isFinite(flightMs) || flightMs < 1000 || flightMs > 20000) throw Error('FLIGHT_MS must be between 1000 and 20000');
const report = {
  complete: false, timestamp: new Date().toISOString(), origin, viewport: [viewport.width,viewport.height], dpr: 1,
  residentPercent: 100, biomes, distances, flightMs, warmupSamples: 3, timedSamples: 6,
  diagnosticNote: 'The cheap-material case changes only diagnostic shading in a private browser. It retains submitted geometry, instance counts, MSAA, alpha textures and render-state policy. It is not a proposed quality reduction.',
  errors: [], networkFailures: [], contextLosses: [], rows: [],
};
await mkdir(output, { recursive: true });
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let browser, page, progressTimer, assetRequests = 0;

try {
  browser = await chromium.launch({ headless: true, args: [
    '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  ] });
  page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/environments/')) assetRequests++; });
  page.on('requestfailed', request => {
    if (!request.failure()?.errorText?.includes('ERR_ABORTED')) report.networkFailures.push({ url: request.url(), failure: request.failure() });
  });
  page.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() }); });
  page.on('response',async response=>{
    if(new URL(response.url()).pathname==='/environments/lod/manifest.json'&&response.ok()){
      const text=await response.text(),pack=JSON.parse(text);
      report.distancePack={manifestSha256:createHash('sha256').update(text).digest('hex'),buffer:pack.buffer,geometryCount:pack.geometries?.length};
    }
  });
  await page.exposeFunction('__reportFullWorldContextLoss', message => report.contextLosses.push(message));
  await page.route('**/assets/index-*.js', async route => {
    const response = await route.fetch(), source = await response.text();
    if (source.split('this.expose()').length !== 2 || !/\bMeshBasicMaterial\b/.test(source)) throw Error('Expected the unminified performance bundle with one application exposure point');
    report.bundleSha256 = createHash('sha256').update(source).digest('hex');
    await route.fulfill({ response, body: source.replace('this.expose()', '(window.__benchmarkGame=this,window.__benchmarkMeshBasicMaterial=MeshBasicMaterial,this.expose())') });
  });
  const query = new URLSearchParams({ review: '1', resident: '100', fragmentShadows: '1', cacheShadows: '1', pruneTraversal: '1', immutableWorld: '1', clearView: '1', view: String(distances[0]) });
  if(process.env.DETAIL_ERROR)query.set('detailError',process.env.DETAIL_ERROR);
  if(process.env.DETAIL_MODE)query.set('detail',process.env.DETAIL_MODE);
  if(process.env.BATCH_VISIBLE)query.set('batchVisible',process.env.BATCH_VISIBLE);
  if(process.env.COARSE_DETAIL)query.set('coarseDetail',process.env.COARSE_DETAIL);
  if(process.env.WIDE_SHADOW_DEPTH)query.set('wideShadowDepth',process.env.WIDE_SHADOW_DEPTH);
  if(process.env.TEMPORAL_BEAUTY)query.set('temporalBeauty',process.env.TEMPORAL_BEAUTY);
  if(process.env.WARM_BINDINGS)query.set('warmBindings',process.env.WARM_BINDINGS);
  if(process.env.EXACT_BEAUTY)query.set('exactBeauty',process.env.EXACT_BEAUTY);
  if(process.env.WARM_BINDINGS_DRAW)query.set('warmBindingsDraw',process.env.WARM_BINDINGS_DRAW);
  if(process.env.MIDDLE_SHADOW_CACHE)query.set('middleShadowCache',process.env.MIDDLE_SHADOW_CACHE);
  report.url = `${origin}/?${query}`;
  const startupStarted = Date.now();
  await page.goto(report.url, { timeout: 120000, waitUntil: 'domcontentloaded' });
  progressTimer = setInterval(async () => {
    try { console.log(JSON.stringify({ phase: 'startup', elapsedSeconds: Math.round((Date.now() - startupStarted) / 1000), loading: await page.locator('#loading p').first().textContent({ timeout: 1000 }) })); } catch { /* Loading UI has already closed. */ }
  }, 20000);
  await page.waitForFunction(() => window.__benchmarkGame?.startupReady && window.__benchmarkGame.world.isViewReady, null, { timeout: 600000 });
  clearInterval(progressTimer); progressTimer = undefined;
  report.startupMs = Date.now() - startupStarted;
  report.targetFps=Number(process.env.TARGET_FPS??0);
  await page.evaluate(target=>{window.__benchmarkTargetFps=target;},report.targetFps);
  report.startup = await page.evaluate(() => {
    const g = window.__benchmarkGame, api = window.__AIRPLANE_EXPERIENCE__, r = g.rendering.renderer, gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    window.__fullWorldRestore = { running: g.loop.running, review: g.review, reviewPose: g.reviewPose, viewDistance: g.viewDistance };
    g.loop.stop();g.loop.targetFps=Number(window.__benchmarkTargetFps??0); api.setReviewMode(true);
    const onLost = event => window.__reportFullWorldContextLoss({ statusMessage: event.statusMessage, time: performance.now() });
    r.domElement.addEventListener('webglcontextlost', onLost);
    window.__fullWorldRemoveContextListener = () => r.domElement.removeEventListener('webglcontextlost', onLost);
    return { stats: api.getStreamingStats(), bindingPreparation:g.rendering.residentBindingPreparation, fog: g.rendering.scene.fog !== null,
      hardware: { browser: navigator.userAgent, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        msaaSamples: gl.getParameter(gl.SAMPLES), contextAttributes: gl.getContextAttributes(), dpr: r.getPixelRatio(),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], gpuTimers: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
        multiDraw: !!gl.getExtension('WEBGL_multi_draw'), depth: g.rendering.depthStatus } };
  });
  if (/swiftshader|llvmpipe|software/i.test(report.startup.hardware.gpu)) throw Error('Software rendering is not a valid hardware performance result');
  if (report.startup.fog) throw Error('Scene fog is still enabled; refusing to describe this as a fog-free benchmark');
  const resident = report.startup.stats.streaming;
  if (resident.totalChunks !== 422 || resident.pinnedChunks !== 422 || resident.preparedResidentChunks !== 422 || !resident.preparationComplete) {
    throw Error(`Expected all 422 sectors prepared and pinned: ${JSON.stringify(resident)}`);
  }
  if (!report.startup.stats.startup.gpu) throw Error('The requested GPU preparation did not run');
  console.log(JSON.stringify({ phase: 'ready', startupMs: report.startupMs, hardware: report.startup.hardware, pinnedChunks: resident.pinnedChunks }));
  await save();

  await page.evaluate(enabled=>{window.__profileComponents=enabled;},process.env.PROFILE_COMPONENTS==='1');
  await page.evaluate(() => {
    const summarize = values => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      return { count: sorted.length, median: sorted[Math.floor(sorted.length * .5)] ?? null,
        p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null,
        mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null, max: sorted.at(-1) ?? null };
    };
    window.__fullWorldMeasurePasses = async mode => {
      const g = window.__benchmarkGame, rendering = g.rendering, renderer = rendering.renderer, gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const original = { shadow: renderer.shadowMap.render, direct: renderer.renderBufferDirect, running: g.loop.running,
        passes: structuredClone(rendering.passes) };
      g.loop.stop();
      const cheap = mode === 'cheap-beauty', skipShadows = mode !== 'full-frame';
      const cameraMatrix = rendering.camera.matrixWorld.toArray(), projection = rendering.camera.projectionMatrix.toArray();
      const aircraftMatrix = g.aircraft.root.matrixWorld.toArray();
      const diagnostics = { eligibleCalls: 0, retainedCustomCalls: 0, retainedDisplacementCalls: 0, materialCount: 0 };
      const materials = new Map(), samples = [], warmups = [];
      let inShadows = false, calls = 0, geometrySignature = 2166136261;
      const hash = value => { geometrySignature = Math.imul(geometrySignature ^ (Number(value) | 0), 16777619) >>> 0; };
      const basicFor = material => {
        let basic = materials.get(material);
        if (!basic) {
          basic = new window.__benchmarkMeshBasicMaterial();
          basic.name = 'PRIVATE DIAGNOSTIC ONLY';
          for (const key of ['map', 'alphaMap', 'alphaTest', 'alphaHash', 'alphaToCoverage', 'opacity', 'transparent', 'vertexColors',
            'depthTest', 'depthWrite', 'depthFunc', 'colorWrite', 'blending', 'blendSrc', 'blendDst', 'blendEquation',
            'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha', 'blendAlpha', 'premultipliedAlpha', 'dithering',
            'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'clipIntersection', 'clipShadows', 'clippingPlanes',
            'stencilWrite', 'stencilWriteMask', 'stencilFunc', 'stencilRef', 'stencilFuncMask', 'stencilFail', 'stencilZFail', 'stencilZPass',
            'visible', 'wireframe', 'wireframeLinewidth', 'precision', 'toneMapped', 'forceSinglePass']) {
            if (key in material) basic[key] = material[key];
          }
          if (material.color) basic.color.copy(material.color);
          if (material.blendColor) basic.blendColor.copy(material.blendColor);
          basic.fog = false;
          materials.set(material, basic); diagnostics.materialCount = materials.size;
        }
        // Three can temporarily switch the original material side for a
        // transparent two-pass draw. Follow that exact current state.
        basic.side = material.side;
        return basic;
      };
      renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
        if (!inShadows) {
          calls++; hash(geometry.id); hash(object.id); hash(object.isInstancedMesh ? object.count : 1);
          hash(geometry.drawRange.start); hash(geometry.drawRange.count); hash(group?.start ?? -1); hash(group?.count ?? -1);
          if (cheap && object.isMesh) {
            if (material.displacementMap) diagnostics.retainedDisplacementCalls++;
            else if (material.isMeshBasicMaterial || material.isMeshStandardMaterial || material.isMeshPhysicalMaterial || material.isMeshPhongMaterial || material.isMeshLambertMaterial) {
              diagnostics.eligibleCalls++; material = basicFor(material);
            } else diagnostics.retainedCustomCalls++;
          }
        }
        return original.direct.call(this, camera, scene, geometry, material, object, group);
      };
      const equal = (actual, expected) => actual.length === expected.length && actual.every((value, index) => value === expected[index]);
      const verifyFrozen = () => {
        if (!equal(rendering.camera.matrixWorld.elements, cameraMatrix) || !equal(rendering.camera.projectionMatrix.elements, projection) ||
            !equal(g.aircraft.root.matrixWorld.elements, aircraftMatrix)) throw Error(`${mode}: frozen pose changed`);
        if (rendering.scene.fog !== null || gl.isContextLost()) throw Error(`${mode}: fog enabled or WebGL context lost`);
      };
      try {
        for (let index = 0; index < 9; index++) {
          let shadowQuery = null, beautyQuery = null, queryActive = false, shadowCalls = 0;
          calls = 0; geometrySignature = 2166136261;
          const endQuery = () => { if (queryActive) { gl.endQuery(ext.TIME_ELAPSED_EXT); queryActive = false; } };
          renderer.shadowMap.render = function (...args) {
            if (++shadowCalls !== 1) throw Error('Expected one native shadow dispatch per complete frame');
            if (ext) { shadowQuery = gl.createQuery(); beautyQuery = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, shadowQuery); queryActive = true; }
            inShadows = true;
            try {
              if (!skipShadows) original.shadow.apply(this, args);
              else { rendering.passes.shadow.calls = 0; rendering.passes.shadow.triangles = 0; }
            } finally { inShadows = false; endQuery(); }
            if (ext) { gl.beginQuery(ext.TIME_ELAPSED_EXT, beautyQuery); queryActive = true; }
          };
          try {
            verifyFrozen();
            const started = performance.now();
            try { rendering.render(true); } finally { endQuery(); }
            const submissionMs = performance.now() - started;
            if (shadowCalls !== 1) throw Error('The native shadow dispatch wrapper was not invoked');
            verifyFrozen();
            const passes = structuredClone(rendering.passes);
            let timerStatus = ext ? 'pending' : 'unavailable', shadowGpuMs = null, beautyGpuMs = null;
            if (ext) {
              const deadline = performance.now() + 20000;
              while (!gl.getQueryParameter(beautyQuery, gl.QUERY_RESULT_AVAILABLE) && !gl.isContextLost() && performance.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 4));
              }
              if (gl.isContextLost()) throw Error('Context lost while waiting for GPU timestamps');
              const available = gl.getQueryParameter(beautyQuery, gl.QUERY_RESULT_AVAILABLE) && gl.getQueryParameter(shadowQuery, gl.QUERY_RESULT_AVAILABLE);
              timerStatus = gl.getParameter(ext.GPU_DISJOINT_EXT) ? 'disjoint' : !available ? 'timeout' : 'valid';
              if (timerStatus === 'valid') {
                shadowGpuMs = gl.getQueryParameter(shadowQuery, gl.QUERY_RESULT) / 1e6;
                beautyGpuMs = gl.getQueryParameter(beautyQuery, gl.QUERY_RESULT) / 1e6;
              }
            }
            const sample = { submissionMs, timerStatus, shadowGpuMs, beautyGpuMs,
              fullGpuMs: shadowGpuMs === null || beautyGpuMs === null ? null : shadowGpuMs + beautyGpuMs,
              passes, directBeautyCalls: calls, geometrySignature };
            (index < 3 ? warmups : samples).push(sample);
          } finally {
            endQuery(); if (shadowQuery) gl.deleteQuery(shadowQuery); if (beautyQuery) gl.deleteQuery(beautyQuery);
          }
        }
        return { mode, diagnosticOnly: cheap, shadowsReused: skipShadows, samples, warmups, diagnostics,
          cameraMatrix, projection, aircraftMatrix, msaaSamples: gl.getParameter(gl.SAMPLES),
          summary: { submissionMs: summarize(samples.map(sample => sample.submissionMs)),
            shadowGpuMs: summarize(samples.map(sample => sample.shadowGpuMs)), beautyGpuMs: summarize(samples.map(sample => sample.beautyGpuMs)),
            fullGpuMs: summarize(samples.map(sample => sample.fullGpuMs)) } };
      } finally {
        renderer.shadowMap.render = original.shadow; renderer.renderBufferDirect = original.direct;
        for (const material of materials.values()) material.dispose();
        for (const key of ['shadow', 'beauty', 'total']) Object.assign(rendering.passes[key], original.passes[key]);
        if (original.running) g.loop.start(); else g.loop.stop();
      }
    };
    window.__fullWorldFlight = async durationMs => {
      const g = window.__benchmarkGame, api = window.__AIRPLANE_EXPERIENCE__, rendering = g.rendering, gl = rendering.renderer.getContext();
      const original = { render: rendering.render, running: g.loop.running, review: g.review, reviewPose: g.reviewPose };
      const intervals = [], submissions = [], longTasks = [], operations = {}, restores = [];
      const components={};
      if(window.__profileComponents){
        const wrap=(object,key,label)=>{
          const originalMethod=object?.[key];if(typeof originalMethod!=='function')return;
          const item=components[label]??(components[label]={calls:0,totalMs:0,maxMs:0});
          object[key]=function(...args){const start=performance.now();try{return originalMethod.apply(this,args);}finally{const elapsed=performance.now()-start;item.calls++;item.totalMs+=elapsed;item.maxMs=Math.max(item.maxMs,elapsed);}};
          restores.push(()=>{object[key]=originalMethod;});
        };
        wrap(g,'syncPresentation','presentation');wrap(g.atmosphere,'prepareRender','atmosphere');
        wrap(rendering.instanceCulling,'prepare','cullingAdapter');wrap(rendering.instanceCulling?.culler,'prepare','cullingPrepare');
        wrap(rendering.instanceCulling?.culler,'auditSources','sourceAudit');
        wrap(rendering.instanceCulling?.culler,'renderShadowPasses','shadowDispatch');
        for(const [key,batcher]of rendering.selectedBatching?.batchers??[])wrap(batcher,'select',`batching:${key}`);
      }
      let previous = null, frames = 0;
      const before = api.getStreamingStats();
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration }); });
      observer.observe({ type: 'longtask' });
      for (const key of ['createBuffer', 'bufferData', 'bufferSubData', 'createVertexArray', 'compileShader', 'linkProgram', 'texImage2D', 'texSubImage2D']) {
        const method = gl[key]; operations[key] = 0;
        gl[key] = function (...args) { operations[key]++; return method.apply(this, args); };
        restores.push(() => { gl[key] = method; });
      }
      rendering.render = function (...args) {
        const started = performance.now();
        const result = original.render.apply(this, args), ended = performance.now();
        submissions.push(ended - started); if (previous !== null) intervals.push(ended - previous); previous = ended; frames++;
        return result;
      };
      const started = performance.now();
      try {
        g.reviewPose = false; api.setReviewMode(false); g.loop.start();
        await new Promise(resolve => setTimeout(resolve, durationMs));
        g.loop.stop();
        const elapsedMs = performance.now() - started;
        for (const entry of observer.takeRecords()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        if (gl.isContextLost()) throw Error('WebGL context lost during the full-quality flight');
        return { durationRequestedMs: durationMs, elapsedMs, frames, drawnFps: frames * 1000 / elapsedMs,
          frameMs: summarize(intervals), submissionMs: summarize(submissions), intervals, longTasks: longTasks.filter(entry => entry.startTime >= started),
          gpuOperations: operations, components, before, after: api.getStreamingStats(), fog: rendering.scene.fog !== null,
          passes: structuredClone(rendering.passes), selection: structuredClone(rendering.instanceCulling?.diagnostics),
          shadowCache: structuredClone(rendering.shadowCacheDiagnostics) };
      } finally {
        g.loop.stop(); rendering.render = original.render;
        for (const restore of restores.reverse()) restore();
        observer.disconnect(); api.setReviewMode(original.review); g.reviewPose = original.reviewPose;
        if (original.running) g.loop.start();
      }
    };
  });

  for (const detailError of detailSweep) for (const distance of distances) for (const biome of biomes) {
    const imageStem=`${biome}-${distance}${detailError===null?'':`-error-${detailError}`}`;
    console.log(JSON.stringify({ phase: 'setup', biome, distance }));
    await page.evaluate(({ distance, biome, detailError }) => {
      const g = window.__benchmarkGame, api = window.__AIRPLANE_EXPERIENCE__;
      g.loop.stop(); api.setReviewMode(true); api.setRenderDistance(distance); api.visitBiome(biome);
      if(detailError!==null){
        if(!g.rendering.distanceDetail)throw Error('Detail sweep requires the distance-detail controller');
        g.rendering.distanceDetail.pixelError=detailError;
        g.rendering.distanceDetail.statistics.pixelError=detailError;
        g.rendering.distanceDetail.states=new WeakMap();
        g.rendering.instanceCulling.culler.invalidateRenderGeometry();
      }
      api.setFlightState({ pitch: .025, bank: 0, verticalSpeed: 0, flightPathAngle: 0 });
      g.reviewPose = true;
    }, { distance, biome, detailError });
    await page.evaluate(async () => {
      const g = window.__benchmarkGame;
      g.syncPresentation(0, true); await g.world.whenReady(); g.syncPresentation(0, true); await g.world.whenReady();
    });
    await page.waitForFunction(() => window.__benchmarkGame.world.isViewReady && window.__benchmarkGame.world.streamingStats.loadingChunks === 0, null, { timeout: 300000 });
    const row = { biome, distance, detailError, cases: [] }; report.rows.push(row);
    row.setup = await page.evaluate(distance => {
      const g = window.__benchmarkGame, api = window.__AIRPLANE_EXPERIENCE__;
      g.syncPresentation(0, true); g.rendering.render(true);
      const stats = api.getStreamingStats();
      if (stats.viewDistance !== distance || g.rendering.scene.fog !== null) throw Error('The requested full-distance fog-free configuration is not active');
      const shadowCache=structuredClone(g.rendering.shadowCacheDiagnostics);
      if(Object.values(shadowCache?.cascades??{}).some(entry=>entry.reason==='light-limit'))throw Error('Configured shadow passes exceed cache capacity');
      return { streaming: stats, camera: api.diagnostics.camera, fog: false, shadowCache,distanceDetail: structuredClone(g.rendering.distanceDetail?.statistics),batching:structuredClone(g.rendering.batchingStatistics) };
    }, distance);
    await page.screenshot({ path: path.join(output, `${imageStem}-full-quality.png`) });
    for (const mode of (process.env.FROZEN_MODES??'full-frame,beauty,cheap-beauty').split(',')) {
      const result = await page.evaluate(mode => window.__fullWorldMeasurePasses(mode), mode);
      row.cases.push(result); await save();
      console.log(JSON.stringify({ phase: 'frozen', biome, distance, mode, summary: result.summary, beauty: result.samples[0]?.passes.beauty }));
    }
    const allSamples = row.cases.flatMap(result => result.samples);
    const reference = allSamples[0];
    row.geometryIdentical = allSamples.every(sample => sample.passes.beauty.calls === reference.passes.beauty.calls &&
      sample.passes.beauty.triangles === reference.passes.beauty.triangles && sample.directBeautyCalls === reference.directBeautyCalls && sample.geometrySignature === reference.geometrySignature);
    row.msaaIdentical = row.cases.every(result => result.msaaSamples === row.cases[0].msaaSamples);
    if (!row.geometryIdentical || !row.msaaIdentical) throw Error('Diagnostic shading changed submitted geometry, draw counts, triangle counts, or MSAA');
    // Diagnostic wrappers and materials have already been removed. Restore a
    // canonical full-quality draw and measure actual moving gameplay separately.
    await page.evaluate(() => { const g = window.__benchmarkGame; g.syncPresentation(0, true); g.rendering.render(true); });
    if(process.env.COMPARE_BATCHING==='1'){
      await page.screenshot({path:path.join(output,`${imageStem}-batching-on.png`)});
      await page.evaluate(()=>{
        const g=window.__benchmarkGame,culler=g.rendering.instanceCulling.culler;
        window.__batchingVisualRestore=culler.renderSelectedPass;culler.renderSelectedPass=undefined;
        g.rendering.render(true);
      });
      await page.screenshot({path:path.join(output,`${imageStem}-batching-off.png`)});
      await page.evaluate(()=>{
        const g=window.__benchmarkGame;g.rendering.instanceCulling.culler.renderSelectedPass=window.__batchingVisualRestore;
        delete window.__batchingVisualRestore;g.rendering.render(true);
      });
    }
    const requestsBefore = assetRequests;
    let profiler;
    if(process.env.PROFILE_CPU==='1'){
      profiler=await page.context().newCDPSession(page);await profiler.send('Profiler.enable');await profiler.send('Profiler.start');
    }
    row.flight = await page.evaluate(duration => window.__fullWorldFlight(duration), flightMs);
    if(profiler){
      const {profile}=await profiler.send('Profiler.stop');
      await writeFile(path.join(output,`${imageStem}.cpuprofile`),JSON.stringify(profile));
      await profiler.detach();
    }
    row.flight.assetRequests = assetRequests - requestsBefore;
    if (row.flight.fog || row.flight.after.streaming.pinnedChunks !== 422 || row.flight.after.streaming.preparedResidentChunks !== 422) throw Error('Flight did not retain the fog-free fully resident world');
    await page.screenshot({ path: path.join(output, `${imageStem}-flight-after.png`) });
    console.log(JSON.stringify({ phase: 'flight', biome, distance, fps: row.flight.drawnFps, frameMs: row.flight.frameMs, assetRequests: row.flight.assetRequests, gpuOperations: row.flight.gpuOperations }));
    await save();
  }
  report.complete = report.errors.length === 0 && report.networkFailures.length === 0 && report.contextLosses.length === 0;
  if (!report.complete) throw Error('Browser, network, or context errors occurred; inspect report.json');
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  clearInterval(progressTimer);
  if (page && !page.isClosed()) {
    try {
      await page.evaluate(() => {
        const g = window.__benchmarkGame, saved = window.__fullWorldRestore;
        if (g && saved) {
          g.loop.stop(); g.review = saved.review; g.reviewPose = saved.reviewPose;
          // Restore the control state without submitting an extra expensive frame.
          g.viewDistance = g.distanceController.setOverride(saved.viewDistance);
          if (saved.running) g.loop.start();
        }
        window.__fullWorldRemoveContextListener?.();
        delete window.__fullWorldMeasurePasses; delete window.__fullWorldFlight;
        delete window.__fullWorldRestore; delete window.__fullWorldRemoveContextListener;
      });
    } catch (error) { report.cleanupError = String(error); }
  }
  await save();
  await browser?.close();
}
