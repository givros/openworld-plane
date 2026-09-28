import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Game } from '../src/game/Game';

interface FlightSnapshot {
  mode: string; phase: string; position: { x: number; y: number; z: number };
  speed: number; altitude: number; pitch: number; bank: number; yaw: number;
  grounded: boolean; crashed: boolean; throttle: number; elapsed: number; takeoffs: number; landings: number;
}
interface DiagnosticsSnapshot {
  frame: number;
  controls: { throttle: number; pitch: number; roll: number; rudder: number; brake: boolean };
  renderer: { calls: number; triangles: number; geometries: number; textures: number; dpr: number };
  camera: { position: { x: number; y: number; z: number }; fov: number; preset?: string };
  aircraft: { paintColor: string };
  audio: { unlocked: boolean; state: string; muted: boolean; loopSources: number; masterGain: number; events: Record<string, number> };
  world: Game['diagnostics']['world'];
  fog?: { enabled: boolean };
  [key: string]: unknown;
}
interface ReviewAPI {
  startManual(): void; startAutopilot(): void; reset(): void;
  setReviewMode(enabled: boolean): void; setTimeScale(value: number): void;
  setPaintColor(hex: string): void;
  setFlightState(partial: Record<string, unknown>): void;
  setControls(partial: Record<string, unknown>): void;
  advance(seconds: number): void;
  reviewBiome(id: string, altitude?: number): void;
  visitBiome(id: string): void;
  dispose(): void;
  state: FlightSnapshot;
  diagnostics: DiagnosticsSnapshot;
}
type ReviewWindow = Window & { __AIRPLANE_EXPERIENCE__: ReviewAPI };
const BIOMES = ['verdant-airfield', 'azure-port', 'alpine-lake', 'sunstone-oasis'];
const DEG = Math.PI / 180;
const errors = new WeakMap<Page, string[]>();

async function snapshot(page: Page): Promise<FlightSnapshot> {
  return page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state);
}
async function diagnostics(page: Page): Promise<DiagnosticsSnapshot> {
  return page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.diagnostics);
}
async function renderedFrames(page: Page, count = 2): Promise<void> {
  const frame = (await diagnostics(page)).frame;
  await page.waitForFunction(({ frame, count }) => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.diagnostics.frame >= frame + count, { frame, count });
}
async function settleCamera(page: Page): Promise<void> {
  let previous = (await diagnostics(page)).camera.position;
  await expect.poll(async () => {
    await renderedFrames(page, 2);
    const next = (await diagnostics(page)).camera.position;
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z);
    previous = next;
    return distance;
  }, { timeout: 20_000, intervals: [50, 100, 150] }).toBeLessThan(0.012);
}
async function capture(page: Page, info: TestInfo, name: string): Promise<Buffer> {
  const directory = join('artifacts', 'screenshots');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${name}.png`);
  const buffer = await page.screenshot({ path: file });
  await info.attach(name, { path: file, contentType: 'image/png' });
  return buffer;
}
function assertWorldFidelity(d: DiagnosticsSnapshot): void {
  expect(d.renderer.calls, 'rendered draw calls').toBeGreaterThan(0);
  expect(d.renderer.triangles, 'rendered triangles').toBeGreaterThan(0);
  expect(d.renderer.dpr, 'native desktop DPR').toBeGreaterThanOrEqual(1);
  expect(d.world.loadedBiomes).toBe(4);
  expect(d.world.authoredBiomeCount).toBe(4);
  expect([...d.world.activeBiomeIds].sort()).toEqual([...BIOMES].sort());
  expect(d.world.trianglePreservation).toBe(true);
  expect(d.world.renderedTriangles).toBe(d.world.sourceTriangles);
  expect(d.world.sourceTriangles).toBeGreaterThan(0);
  expect(d.world.geometryCompression).toBe(false);
  expect(d.world.lod).toBe(false);
  expect(d.world.nativeDetail).toBe(true);
}
function canvasColors(buffer: Buffer): { buckets: number; range: number; opaque: number } {
  const png = PNG.sync.read(buffer);
  const buckets = new Set<number>();
  let low = 255, high = 0, opaque = 0;
  const step = Math.max(1, Math.floor(png.width * png.height / 8192));
  for (let pixel = 0; pixel < png.width * png.height; pixel += step) {
    const i = pixel * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    low = Math.min(low, r, g, b); high = Math.max(high, r, g, b);
    if (png.data[i + 3] > 250) opaque++;
    buckets.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4));
  }
  return { buckets: buckets.size, range: high - low, opaque };
}

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', error => messages.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' || /WebGL.*(?:INVALID|error|lost)|THREE\.WebGLProgram.*Error/i.test(message.text())) messages.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', request => messages.push(`network: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  await page.goto('/?review=1', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as ReviewWindow).__AIRPLANE_EXPERIENCE__?.diagnostics?.renderer, null, { timeout: 180_000 });
  await expect(page.locator('canvas')).toBeVisible();
  await renderedFrames(page, 3);
});
test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) {
    const report = await diagnostics(page).catch(() => null);
    await info.attach('diagnostics', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  }
  expect(errors.get(page) ?? [], 'browser, WebGL, and network errors').toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  test(`rendered aircraft and compact interface at ${viewport.width}×${viewport.height}`, async ({ page, browser }, info) => {
    await page.setViewportSize(viewport);
    await settleCamera(page);
    await expect(page).toHaveTitle(/CROPPER SEVEN/i);
    await expect(page.locator('h1')).toContainText('CROPPER SEVEN');
    await expect(page.locator('#manual-button')).toBeVisible();
    await expect(page.locator('#autopilot-button')).toBeVisible();
    const size = await page.locator('canvas').evaluate(canvas => ({ width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height }));
    expect(size.width).toBeGreaterThanOrEqual(viewport.width);
    expect(size.height).toBeGreaterThanOrEqual(viewport.height);
    const pixels = canvasColors(await page.locator('canvas').screenshot());
    expect(pixels.buckets).toBeGreaterThan(35);
    expect(pixels.range).toBeGreaterThan(80);
    expect(pixels.opaque).toBeGreaterThan(4000);
    for (const selector of ['.brand', '.utility', '.start-panel', '.location', '.camera-presets']) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds, selector).not.toBeNull();
      expect(bounds!.x, selector).toBeGreaterThanOrEqual(0);
      expect(bounds!.y, selector).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width, selector).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds!.y + bounds!.height, selector).toBeLessThanOrEqual(viewport.height + 1);
    }
    assertWorldFidelity(await diagnostics(page));
    await capture(page, info, `inspection-${viewport.width}x${viewport.height}`);
    await page.locator('#manual-button').click();
    await expect(page.locator('.start-panel')).toBeHidden();
    await expect(page.locator('.telemetry')).toBeVisible();
    await expect(page.locator('.cinematic-timeline')).toBeHidden();
    await expect(page.locator('#reset-button')).toBeVisible();
    await capture(page, info, `manual-ready-${viewport.width}x${viewport.height}`);
    if (viewport.width === 1440) {
      const retinaContext = await browser.newContext({ viewport, deviceScaleFactor: 2 });
      const retina = await retinaContext.newPage();
      const retinaErrors: string[] = [];
      retina.on('pageerror', error => retinaErrors.push(error.message));
      retina.on('console', message => { if (message.type() === 'error') retinaErrors.push(message.text()); });
      try {
        await retina.goto(new URL('/?review=1', page.url()).href, { waitUntil: 'networkidle' });
        await retina.waitForFunction(() => !!(window as ReviewWindow).__AIRPLANE_EXPERIENCE__?.diagnostics?.renderer, null, { timeout: 180_000 });
        await renderedFrames(retina, 3);
        expect((await diagnostics(retina)).renderer.dpr).toBe(2);
        const buffer = await retina.locator('canvas').evaluate(canvas => ({ width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height }));
        expect(buffer).toEqual({ width: 2880, height: 1800 });
        assertWorldFidelity(await diagnostics(retina));
        await capture(retina, info, 'inspection-1440x900-native-dpr');
        expect(retinaErrors).toEqual([]);
      } finally { await retinaContext.close(); }
    }
  });
}

test('paint persistence, sound, fullscreen, and four inspection cameras', async ({ page }, info) => {
  await page.locator('#paint-button').click();
  await page.getByRole('button', { name: 'Aero blue', exact: true }).click();
  await expect(page.locator('#paint-readout')).toHaveText('#3479A8');
  expect((await diagnostics(page)).aircraft.paintColor).toBe('#3479a8');
  expect(await page.evaluate(() => localStorage.getItem('cropper-seven-aircraft-paint'))).toBe('#3479a8');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as ReviewWindow).__AIRPLANE_EXPERIENCE__);
  await page.locator('#paint-button').click();
  await expect(page.locator('#custom-paint')).toHaveValue('#3479a8');
  await page.locator('#custom-paint').fill('#a84731');
  await expect(page.locator('#paint-readout')).toHaveText('#A84731');
  expect((await diagnostics(page)).aircraft.paintColor).toBe('#a84731');
  expect(await page.evaluate(() => localStorage.getItem('cropper-seven-aircraft-paint'))).toBe('#a84731');
  await page.getByRole('button', { name: 'Crop orange', exact: true }).click();
  await page.locator('#paint-button').click();
  await page.locator('#sound-button').click();
  await expect(page.locator('#sound-button')).toHaveAttribute('aria-label', 'Enable sound');
  await expect(page.locator('#sound-button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await diagnostics(page)).audio.state).toBe('running');
  expect((await diagnostics(page)).audio.unlocked).toBe(true);
  expect((await diagnostics(page)).audio.muted).toBe(true);
  expect((await diagnostics(page)).audio.loopSources).toBe(4);
  await expect.poll(async () => (await diagnostics(page)).audio.masterGain).toBeLessThan(0.002);
  await page.locator('#sound-button').click();
  await expect(page.locator('#sound-button')).toHaveAttribute('aria-label', 'Mute sound');
  expect((await diagnostics(page)).audio.muted).toBe(false);
  await expect.poll(async () => (await diagnostics(page)).audio.masterGain).toBeGreaterThan(0.7);
  const fullscreenAvailable = await page.evaluate(() => document.fullscreenEnabled);
  if (fullscreenAvailable) {
    await page.locator('#fullscreen-button').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'app');
    await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', 'Exit fullscreen');
    await page.keyboard.press('f');
    await page.waitForFunction(() => document.fullscreenElement === null);
    await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', 'Enter fullscreen');
    await expect(page.locator('canvas')).toBeFocused();
  } else await expect(page.locator('#fullscreen-button')).toBeHidden();
  const positions = [];
  for (const [index, name] of ['front', 'side', 'rear', 'above'].entries()) {
    await page.keyboard.press(String(index + 1));
    await expect(page.locator(`[data-camera="${index}"]`)).toHaveClass(/selected/);
    await settleCamera(page);
    positions.push((await diagnostics(page)).camera.position);
    await capture(page, info, `aircraft-${name}`);
  }
  for (let i = 1; i < positions.length; i++) {
    expect(Math.hypot(positions[i].x - positions[i - 1].x, positions[i].y - positions[i - 1].y, positions[i].z - positions[i - 1].z)).toBeGreaterThan(2);
  }
});

test('real keyboard power, takeoff, bank directions, nose control, and blur clearing', async ({ page }, info) => {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.mode === 'manual');
  await page.keyboard.down('w');
  await page.keyboard.down('ArrowDown');
  await page.waitForFunction(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.speed > 9);
  await capture(page, info, 'ground-roll');
  await page.waitForFunction(() => !(window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.grounded, null, { timeout: 30_000 });
  const lift = await snapshot(page);
  expect(lift.speed).toBeGreaterThanOrEqual(29);
  expect(lift.throttle).toBeGreaterThanOrEqual(0.5);
  expect(lift.pitch).toBeGreaterThan(5 * DEG);
  await page.waitForFunction(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.altitude > 16);
  await page.keyboard.up('w');
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.bank < -0.23);
  await page.keyboard.up('ArrowLeft');
  expect(await page.locator('#attitude-horizon').evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--attitude-bank')))).toBeLessThan(0);
  await capture(page, info, 'left-bank');
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.bank > 0.23);
  await page.keyboard.up('ArrowRight');
  expect(await page.locator('#attitude-horizon').evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--attitude-bank')))).toBeGreaterThan(0);
  await capture(page, info, 'right-bank');
  const beforePitch = (await snapshot(page)).pitch;
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(before => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.state.pitch < before - 0.045, beforePitch);
  await page.keyboard.up('ArrowUp');
  expect((await snapshot(page)).crashed).toBe(false);
  await page.keyboard.down('w');
  await page.keyboard.down('ArrowDown');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const controls = (await diagnostics(page)).controls;
  expect(controls).toEqual({ throttle: 0, pitch: 0, roll: 0, rudder: 0, brake: false });
  await page.keyboard.up('w');
  await page.keyboard.up('ArrowDown');
  await page.keyboard.press('r');
  await expect(page.locator('#manual-button')).toBeVisible();
});

test('landing, braking, re-takeoff, touch-and-go, and terminal impact in the rendered game', async ({ page }, info) => {
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.startManual(); api.setReviewMode(true);
    api.setFlightState({ position: { x: 0, y: 0.7, z: -100 }, grounded: false, speed: 33, throttle: 0.1, pitch: 0.06981317, bank: 0, yaw: 0, flightPathAngle: -0.05235988, verticalSpeed: -1.727 });
    api.advance(0.9);
  });
  let state = await snapshot(page);
  expect(state.crashed).toBe(false);
  expect(state.grounded).toBe(true);
  expect(state.landings).toBe(1);
  await capture(page, info, 'landing');
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.setControls({ throttle: -1, brake: true }); api.advance(6);
  });
  state = await snapshot(page);
  expect(state.speed).toBe(0);
  expect(state.phase).toBe('manual-ready');
  await expect(page.locator('#flight-alert')).toContainText('ADD POWER TO TAKE OFF AGAIN');
  await capture(page, info, 'full-stop');
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.setControls({ throttle: 1, pitch: 1, brake: false });
    // advance renders the full world once per call, while still integrating
    // physics at 1/120 s internally. Check liftoff within 0.25 s over the same
    // ten-second limit without forcing hundreds of unobserved GPU frames.
    for (let i = 0; i < 40 && api.state.grounded; i++) api.advance(0.25);
    api.setControls({ throttle: 0, pitch: 0 });
  });
  state = await snapshot(page);
  expect(state.grounded).toBe(false);
  expect(state.crashed).toBe(false);
  expect(state.takeoffs).toBe(1);
  await capture(page, info, 're-takeoff');
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.reset(); api.startManual(); api.setReviewMode(true);
    api.setFlightState({ position: { x: 0, y: 0.69, z: -80 }, grounded: false, speed: 36, throttle: 0.82, pitch: 0.13962634, bank: 0, yaw: 0, flightPathAngle: -0.04363323 });
    api.advance(1 / 120); api.setControls({ pitch: 1 }); api.advance(0.175);
  });
  expect((await snapshot(page)).grounded).toBe(true);
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.advance(0.5));
  expect((await snapshot(page)).grounded).toBe(false);
  await capture(page, info, 'touch-and-go');
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.reset(); api.startManual(); api.setReviewMode(true);
    api.setFlightState({ position: { x: 0, y: 0.08, z: -80 }, grounded: false, speed: 39, throttle: 0.3, pitch: 0, bank: 0, yaw: 0, flightPathAngle: -0.2443461 });
    api.advance(0.1); api.setControls({ pitch: 1, throttle: 1 }); api.advance(2);
  });
  expect((await snapshot(page)).phase).toBe('crashed');
  await expect(page.locator('#flight-alert')).toContainText('PRESS R TO RESET');
  await page.keyboard.press('r');
  expect((await snapshot(page)).crashed).toBe(false);
});

test('the complete cinematic reaches all key views and finishes without looping', async ({ page }, info) => {
  await page.locator('#autopilot-button').click();
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.setReviewMode(true));
  await expect(page.locator('.cinematic-timeline')).toBeVisible();
  const shots = [[12, 'cinematic-liftoff'], [21, 'cinematic-scenic'], [40.5, 'cinematic-final'], [42.2, 'cinematic-touchdown'], [48, 'cinematic-rollout'], [55.2, 'cinematic-finale']] as const;
  for (const [time, name] of shots) {
    await page.evaluate(time => {
      const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
      api.advance(Math.max(0, time - api.state.elapsed));
    }, time);
    await capture(page, info, name);
  }
  const state = await snapshot(page);
  expect(state.phase).toBe('complete');
  expect(state.elapsed).toBeCloseTo(55.2, 5);
  expect(state.speed).toBe(0);
  expect(state.position.z).toBeCloseTo(104, 5);
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.advance(20));
  expect((await snapshot(page)).phase).toBe('complete');
  await expect(page.locator('#flight-alert')).toContainText('FLIGHT COMPLETE');
});

test('the four destination buttons start a controllable flight in each new biome', async ({ page }, info) => {
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.setReviewMode(true));
  for (const id of BIOMES) {
    await page.locator(`[data-biome="${id}"]`).click();
    await renderedFrames(page, 2);
    const d = await diagnostics(page), state = await snapshot(page);
    expect(state.mode).toBe('manual');
    expect(state.grounded).toBe(false);
    expect(state.crashed).toBe(false);
    expect(state.altitude).toBeGreaterThanOrEqual(80);
    expect(d.world.currentBiomeId).toBe(id);
    await expect(page.locator('#biome-name')).toHaveText(d.world.biomes.find(biome => biome.id === id)!.label.toUpperCase());
    assertWorldFidelity(d);
    await capture(page, info, `destination-${id}`);
  }
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.advance(1));
  await page.keyboard.up('ArrowRight');
  expect((await snapshot(page)).bank).toBeGreaterThan(0.1);
});

test('all four authored biomes render their landmarks at fixed full detail', async ({ page }, info) => {
  test.setTimeout(240_000);
  const reports: Record<string, DiagnosticsSnapshot> = {};
  for (const id of BIOMES) {
    await page.evaluate(id => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.reviewBiome(id, 70), id);
    await settleCamera(page);
    const d = await diagnostics(page);
    expect(d.world.currentBiomeId).toBe(id);
    assertWorldFidelity(d);
    expect(d.world.biomes.find(biome => biome.id === id)!.landmark.length).toBeGreaterThan(5);
    reports[id] = d;
    const viewport = page.viewportSize()!;
    expect(await page.locator('canvas').boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    // The canvas covers the viewport, so the captured page has exactly the
    // same visible pixels as an element screenshot, including the HUD overlay.
    // Reuse that frame instead of waiting for a second element-stability cycle.
    const pixels = canvasColors(await capture(page, info, `${id}-low`));
    expect(pixels.buckets, id).toBeGreaterThan(25);
    await page.evaluate(id => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.reviewBiome(id, 240), id);
    await renderedFrames(page, 2);
    assertWorldFidelity(await diagnostics(page));
    await capture(page, info, `${id}-high`);
  }
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.reviewBiome('alpine-lake', 700);
  });
  await renderedFrames(page, 2);
  await capture(page, info, 'high-altitude-horizon');
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/biome-diagnostics.json', JSON.stringify(reports, null, 2));
  await info.attach('biome-diagnostics', { path: 'artifacts/biome-diagnostics.json', contentType: 'application/json' });
});

test('an unavailable environment shows a readable error before flight controls start', async ({ page }) => {
  await page.route('**/environments/azure-port.glb', route => route.fulfill({ status: 404, body: 'Missing environment fixture' }));
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#loading')).toContainText('THE WORLD COULD NOT LOAD');
  await expect(page.locator('#loading')).toContainText('azure-port.glb');
  await expect(page.locator('#flight-ui')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.__AIRPLANE_EXPERIENCE__)).toBe('undefined');
  const captured = errors.get(page) ?? [];
  expect(captured.some(message => message.includes('azure-port.glb'))).toBe(true);
  // The deliberately injected missing-file report is the expected outcome.
  errors.set(page, captured.filter(message => !message.includes('azure-port.glb') && !message.includes('404')));
});

test('biome visits and connected ground crossings retain all authored resources', async ({ page }, info) => {
  test.setTimeout(240_000);
  // Warm every region before comparing GPU allocations at an identical view.
  for (const id of BIOMES) {
    await page.evaluate(id => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.reviewBiome(id, 100), id);
    await renderedFrames(page, 2);
  }
  const before = await diagnostics(page);
  await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    api.startManual(); api.setReviewMode(true);
    api.setFlightState({ position: { x: 799, y: 300, z: 0 }, grounded: false, speed: 40, pitch: 0, bank: 0, yaw: Math.PI / 2 });
  });
  await renderedFrames(page, 2);
  expect((await diagnostics(page)).world.currentBiomeId).toBe('verdant-airfield');
  await capture(page, info, 'biome-connection-before');
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.setFlightState({ position: { x: 801, y: 300, z: 0 } }));
  await renderedFrames(page, 2);
  const crossed = await diagnostics(page);
  expect(crossed.world.currentBiomeId).toBe('azure-port');
  expect(crossed.world.resourceIdentities).toEqual(before.world.resourceIdentities);
  expect(crossed.world.renderedTriangles).toBe(before.world.renderedTriangles);
  await capture(page, info, 'biome-connection-after');
  await page.evaluate(() => (window as ReviewWindow).__AIRPLANE_EXPERIENCE__.reviewBiome('sunstone-oasis', 100));
  await renderedFrames(page, 2);
  const warmed = await diagnostics(page);
  await page.evaluate(ids => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    for (let i = 0; i < 100; i++) api.visitBiome(ids[i % ids.length]);
    api.reviewBiome('sunstone-oasis', 100);
  }, BIOMES);
  await renderedFrames(page, 2);
  const final = await diagnostics(page);
  expect(final.world.resourceIdentities).toEqual(warmed.world.resourceIdentities);
  expect(final.world.renderedTriangles).toBe(warmed.world.renderedTriangles);
  expect(final.renderer.geometries).toBe(warmed.renderer.geometries);
  expect(final.renderer.textures).toBe(warmed.renderer.textures);
  assertWorldFidelity(final);
  await info.attach('biome-visit-resources', { body: JSON.stringify({ before: warmed.renderer, after: final.renderer, quality: { nativeDpr: final.renderer.dpr, geometryCompression: false, lod: false }, visits: 100 }, null, 2), contentType: 'application/json' });
  await capture(page, info, 'world-after-100-visits');
});

test('review mutation hooks are absent from the normal player URL', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as ReviewWindow).__AIRPLANE_EXPERIENCE__);
  const hooks = await page.evaluate(() => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    return { reviewBiome: typeof api.reviewBiome, setFlightState: typeof api.setFlightState, advance: typeof api.advance, setControls: typeof api.setControls };
  });
  expect(hooks).toEqual({ reviewBiome: 'undefined', setFlightState: 'undefined', advance: 'undefined', setControls: 'undefined' });
});

test('disposing a running game twice releases its UI, controls, and animation loop', async ({ page }) => {
  await page.locator('#manual-button').click();
  await page.keyboard.down('w');
  const result = await page.evaluate(async () => {
    const api = (window as ReviewWindow).__AIRPLANE_EXPERIENCE__;
    const frame = api.diagnostics.frame;
    api.dispose(); api.dispose();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      frameBefore: frame, frameAfter: api.diagnostics.frame,
      canvasCount: document.querySelectorAll('canvas').length,
      uiPresent: !!document.querySelector('#flight-ui'),
      controls: api.diagnostics.controls,
      audio: api.diagnostics.audio,
    };
  });
  expect(result.frameAfter).toBe(result.frameBefore);
  expect(result.canvasCount).toBe(0);
  expect(result.uiPresent).toBe(false);
  expect(result.controls).toEqual({ throttle: 0, pitch: 0, roll: 0, rudder: 0, brake: false });
  expect(result.audio.loopSources).toBe(0);
  await page.keyboard.up('w');
});
