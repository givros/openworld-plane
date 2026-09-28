#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

function parseArguments(argv) {
  const args = { url: process.env.BASE_URL ?? 'http://127.0.0.1:5173', out: 'artifacts/canvas-inspection', mode: 'manual', width: 1440, height: 900, dpr: 1, flightSeconds: 0 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--url') args.url = argv[++i];
    else if (name === '--out') args.out = argv[++i];
    else if (name === '--mode') args.mode = argv[++i];
    else if (name === '--width') args.width = Number(argv[++i]);
    else if (name === '--height') args.height = Number(argv[++i]);
    else if (name === '--dpr') args.dpr = Number(argv[++i]);
    else if (name === '--flight-seconds') args.flightSeconds = Number(argv[++i]);
    else if (name === '--help' || name === '-h') {
      console.log('Usage: inspect-threejs-canvas.mjs [--url URL] [--out DIR] [--mode manual|inspection|autopilot] [--width 1440] [--height 900] [--dpr 2] [--flight-seconds 120]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${name}`);
  }
  if (!['manual', 'inspection', 'autopilot'].includes(args.mode)) throw new Error('Mode must be manual, inspection, or autopilot.');
  if (args.width < 900 || args.height < 600) throw new Error('Use a desktop viewport of at least 900×600.');
  if (!Number.isFinite(args.flightSeconds) || args.flightSeconds < 0) throw new Error('Flight duration must be a nonnegative number of seconds.');
  if (!Number.isFinite(args.dpr) || args.dpr < 1 || args.dpr > 3) throw new Error('DPR must be between 1 and 3.');
  return args;
}

function installedChromium() {
  if (process.env.BROWSER_EXECUTABLE) return process.env.BROWSER_EXECUTABLE;
  const directory = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '');
  if (!directory || !existsSync(directory)) return undefined;
  const candidates = readdirSync(directory).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const candidate of candidates) {
    for (const suffix of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const path = join(directory, candidate, suffix);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

function samplePixels(buffer) {
  const png = PNG.sync.read(buffer);
  const colors = new Set();
  const tiles = Array.from({ length: 16 }, () => new Set());
  let samples = 0, opaque = 0, min = 255, max = 0, sum = 0, sumSquares = 0;
  const stride = Math.max(1, Math.floor(png.width * png.height / 16384));
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset], g = png.data[offset + 1], b = png.data[offset + 2], a = png.data[offset + 3];
    const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const bucket = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
    samples++; if (a > 250) opaque++;
    min = Math.min(min, r, g, b); max = Math.max(max, r, g, b);
    sum += luminance; sumSquares += luminance * luminance; colors.add(bucket);
    const x = pixel % png.width, y = Math.floor(pixel / png.width);
    const tile = Math.min(3, Math.floor(y / png.height * 4)) * 4 + Math.min(3, Math.floor(x / png.width * 4));
    tiles[tile].add(bucket);
  }
  const mean = sum / samples;
  const variedTiles = tiles.filter(tile => tile.size > 4).length;
  return {
    ok: opaque / samples > 0.99 && colors.size > 35 && max - min > 80 && variedTiles >= 8,
    width: png.width, height: png.height, samples, opaquePixels: opaque,
    colorBuckets: colors.size, channelRange: max - min,
    meanLuminance: mean, luminanceDeviation: Math.sqrt(sumSquares / samples - mean * mean),
    variedTiles, tileColorBuckets: tiles.map(tile => tile.size),
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const out = resolve(args.out);
  await mkdir(out, { recursive: true });
  const messages = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  const flightSamples = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: installedChromium(),
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: args.width, height: args.height }, deviceScaleFactor: args.dpr });
    const page = await context.newPage();
    page.on('pageerror', error => messages.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || /WebGL.*(?:INVALID|error|lost)|THREE\.WebGLProgram.*Error/i.test(message.text())) messages.consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => messages.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
    await page.goto(args.url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForFunction(() => !!window.__AIRPLANE_EXPERIENCE__?.diagnostics?.renderer, null, { timeout: 30_000 });
    await page.locator('canvas').waitFor({ state: 'visible' });
    if (args.mode === 'manual') {
      await page.keyboard.press('Enter');
      await page.keyboard.down('w'); await page.keyboard.down('ArrowDown');
      await page.waitForFunction(() => !window.__AIRPLANE_EXPERIENCE__.state.grounded && window.__AIRPLANE_EXPERIENCE__.state.altitude > 7, null, { timeout: 45_000 });
      await page.keyboard.up('w'); await page.keyboard.up('ArrowDown');
      if (args.flightSeconds > 0) {
        let running = true;
        while (running) {
          const sample = await page.evaluate(() => {
            const api = window.__AIRPLANE_EXPERIENCE__, d = api.diagnostics, s = api.state;
            return { frame: d.frame, elapsed: s.elapsed, crashed: s.crashed, altitude: s.altitude, speed: s.speed,
              position: s.position, renderer: d.renderer, performance: d.performance,
              streaming: { center: d.world.centerChunkKey, slotReuses: d.world.slotReuses, slotCreations: d.world.slotCreations, loadedChunks: d.world.loadedChunks, droppedInstances: d.world.droppedInstances } };
          });
          flightSamples.push(sample);
          if (sample.crashed) throw new Error('The continuous manual flight ended in a crash.');
          running = sample.elapsed < args.flightSeconds;
          if (running) await page.waitForFunction(({ frame, duration }) => {
            const api = window.__AIRPLANE_EXPERIENCE__;
            return api.diagnostics.frame >= frame + 60 || api.state.elapsed >= duration || api.state.crashed;
          }, { frame: sample.frame, duration: args.flightSeconds }, { polling: 250, timeout: 20_000 });
        }
      }
    } else if (args.mode === 'autopilot') {
      await page.locator('#autopilot-button').click();
      await page.waitForFunction(() => window.__AIRPLANE_EXPERIENCE__.state.phase === 'scenic-outbound', null, { timeout: 60_000 });
    }
    const firstFrame = await page.evaluate(() => window.__AIRPLANE_EXPERIENCE__.diagnostics.frame);
    await page.waitForFunction(first => window.__AIRPLANE_EXPERIENCE__.diagnostics.frame >= first + 90, firstFrame, { timeout: 60_000 });
    const canvasBuffer = await page.locator('canvas').screenshot();
    const canvasPath = join(out, `${args.mode}-canvas.png`);
    const screenshotPath = join(out, `${args.mode}-desktop.png`);
    await writeFile(canvasPath, canvasBuffer);
    await page.screenshot({ path: screenshotPath });
    const scene = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2');
      const extension = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        state: window.__AIRPLANE_EXPERIENCE__.state,
        diagnostics: window.__AIRPLANE_EXPERIENCE__.diagnostics,
        drawingBuffer: canvas ? { width: canvas.width, height: canvas.height } : null,
        gpu: gl ? { version: gl.getParameter(gl.VERSION), renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) } : null,
      };
    });
    const pixels = samplePixels(canvasBuffer);
    const d = scene.diagnostics;
    const peak = { calls: d.renderer.calls, triangles: d.renderer.triangles, geometries: d.renderer.geometries, textures: d.renderer.textures };
    for (const sample of flightSamples) for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], sample.renderer[key]);
    const budgets = {
      drawCalls: peak.calls <= 260,
      triangles: peak.triangles <= 180000,
      geometries: peak.geometries <= 240,
      textures: peak.textures <= 16,
      dpr: d.renderer.dpr <= 1.35,
      nineChunks: d.world.loadedChunks === 9 && new Set(d.world.activeChunkKeys).size === 9 && flightSamples.every(sample => sample.streaming.loadedChunks === 9),
      noDroppedInstances: d.world.droppedInstances === 0 && flightSamples.every(sample => sample.streaming.droppedInstances === 0),
    };
    const hardware = scene.gpu ? !/swiftshader|llvmpipe|software/i.test(scene.gpu.renderer) : null;
    const report = {
      ok: pixels.ok && Object.values(budgets).every(Boolean) && Object.values(messages).every(list => list.length === 0),
      url: args.url, mode: args.mode, viewport: { width: args.width, height: args.height },
      screenshotPath, canvasPath, pixels, budgets,
      peakRenderer: peak,
      endurance: { requestedSeconds: args.flightSeconds, samples: flightSamples },
      hardwareAccelerated: hardware,
      performanceTarget: { medianFps: 55, p95FrameMs: 22, measured: d.performance, hardwareAccelerated: hardware },
      ...scene, ...messages,
    };
    const reportPath = join(out, `${args.mode}-report.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: report.ok, url: args.url, mode: args.mode, viewport: report.viewport,
      drawingBuffer: scene.drawingBuffer, rendererDpr: d.renderer.dpr,
      peakRenderer: peak, budgets, pixels, gpu: scene.gpu,
      performance: d.performance,
      endurance: { elapsed: scene.state.elapsed, samples: flightSamples.length, slotCreations: d.world.slotCreations, slotReuses: d.world.slotReuses, loadedChunks: d.world.loadedChunks, droppedInstances: d.world.droppedInstances },
      artifacts: { reportPath, screenshotPath, canvasPath }, ...messages,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
