import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = 'artifacts/four-horizons/target-30fps/native-render-capture';
const sink = JSON.parse(await readFile(path.join(root, 'session.json'), 'utf8'));
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--js-flags=--max-old-space-size=8192'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', message => { if (message.text().startsWith('RASTER ') || message.text().startsWith('CAPTURE ')) console.log(message.text()); if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173/raster-probe.html');
  await page.waitForFunction(() => window.rasterProbeModuleReady);
  const result = await page.evaluate(async sink => {
    const { WebGL2CommandRecorder } = await import('/src/experiments/WebGL2CommandRecorder.ts');
    const getContext = HTMLCanvasElement.prototype.getContext;
    // This context is isolated from the recorded renderer. Uploading the actual DOM
    // source and reading an RGBA8 framebuffer snapshots the browser's own decoder
    // without a Canvas2D alpha/color round trip.
    const auxiliary = document.createElement('canvas');
    const copyGL = getContext.call(auxiliary, 'webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!copyGL) throw new Error('Texture snapshot context unavailable');
    const imageCache = new WeakMap();
    const captureImage = (source, request) => {
      const key = JSON.stringify(request.unpack);
      const existing = imageCache.get(source);
      if (existing?.key === key) return existing.result;
      const width = source.naturalWidth ?? source.width, height = source.naturalHeight ?? source.height;
      const gl = copyGL, texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      // Capture source rows before the original command's explicit flip and
      // premultiply operations; the native player applies those recorded flags.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, request.unpack[String(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)] ?? gl.BROWSER_DEFAULT_WEBGL);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Texture snapshot framebuffer incomplete');
      const bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const error = gl.getError(); gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
      if (error) throw new Error(`Texture snapshot GL error ${error}`);
      const result = { bytes: new Blob([bytes]), encoding: 'rgba8', width, height, rowOrigin: 'top-left', premultipliedAlpha: false, colorSpace: 'srgb', sourceCreation: { method: 'Original DOM source uploaded unflipped to RGBA8 and read back through isolated WebGL2 context', sourceKind: source.constructor.name } };
      imageCache.set(source, { key, result });
      return result;
    };
    let recorder;
    const immutableAtlas = await (await fetch('/artifacts/four-horizons/target-30fps/native-render-capture/atlas/manifest.json')).json();
    const verified = new Map();
    const captureImmutableBuffer = (source) => {
      if (source.byteLength < 64 * 1024 * 1024) return undefined;
      const atlas = window.rasterProbe?.atlas;
      if (!atlas) throw new Error('Large immutable upload is outside the known source atlas');
      const candidates = [...atlas.floatTextures.map((texture, index) => [`float${index}`, texture.image.data]), ['integer', atlas.integerTexture.image.data]];
      const found = candidates.find(([, data]) => source.buffer === data.buffer && source.byteOffset === data.byteOffset && source.byteLength === data.byteLength);
      if (!found) throw new Error('Unknown large binary upload: refusing an unverified external reference');
      if (verified.has(found[0])) return verified.get(found[0]);
      const file = immutableAtlas.files.find(item => item.id === found[0]);
      if (!file || file.byteLength !== source.byteLength) throw new Error('Offline original atlas length mismatch');
      const check = (async () => {
        const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        for (let index = 0, offset = 0; offset < bytes.byteLength; index++, offset += immutableAtlas.chunkBytes) {
          const digest = await crypto.subtle.digest('SHA-256', bytes.subarray(offset, Math.min(offset + immutableAtlas.chunkBytes, bytes.byteLength)));
          const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
          if (hash !== file.chunks[index]) throw new Error(`Immutable native atlas differs: ${file.id} chunk ${index}`);
        }
        console.log(`CAPTURE verified external ${file.id} ${bytes.byteLength} bytes`);
        return { file: file.file, sha256: file.sha256 };
      })();
      verified.set(found[0], check);
      return check;
    };
    const headers = { 'X-Capture-Key': sink.token };
    let uploadedBytes = 0, uploadCount = 0;
    // Bundle small immutable snapshots, avoiding thousands of round trips.
    let uploadTail = Promise.resolve();
    let pending = [], pendingBytes = 0, flushScheduled = false;
    const flush = () => {
      if (!pending.length) return;
      const batch = pending; pending = []; pendingBytes = 0; flushScheduled = false;
      const name = batch[0].info.id, body = new Blob(batch.map(item => item.blob));
      uploadTail = uploadTail.then(async () => {
        const response = await fetch(`${sink.url}/blob/${name}`, { method: 'PUT', headers, body });
        if (!response.ok) throw new Error(`Capture batch upload ${name}: ${response.status}`);
        const reference = await response.json(); let offset = 0;
        for (const item of batch) { item.resolve({ file: reference.file, byteOffset: offset }); offset += item.blob.size; }
        uploadedBytes += body.size; uploadCount += batch.length;
      }).catch(error => { for (const item of batch) item.reject(error); throw error; });
    };
    const captureBlob = (blob, info) => {
      const result = new Promise((resolve, reject) => pending.push({ blob, info, resolve, reject }));
      pendingBytes += blob.size;
      if (pendingBytes >= 32 * 1024 * 1024) flush();
      else if (!flushScheduled) { flushScheduled = true; setTimeout(flush, 0); }
      return result;
    };
    HTMLCanvasElement.prototype.getContext = function (type, attributes) {
      const context = getContext.call(this, type, attributes);
      if (type === 'webgl2' && !recorder && context) {
        recorder = new WebGL2CommandRecorder(context, { captureBlob, captureImage, captureImmutableBuffer });
        window.renderRecorder = recorder;
        HTMLCanvasElement.prototype.getContext = getContext;
      }
      return context;
    };
    try {
      window.rasterProbe = await window.TriangleRasterProbe.create({ pairURL: '/artifacts/four-horizons/target-30fps/native-dxr-corrected' });
      await rasterProbe.setBlock(1);
      recorder.beginFrame('Full source original-triangle beauty, initialization frame');
      const first = await rasterProbe.frame();
      recorder.endFrame();
      recorder.beginFrame('Full source original-triangle beauty, resident frame');
      const resident = await rasterProbe.frame();
      recorder.endFrame();
      const screenshot = rasterProbe.capture();
      flush();
      const exported = await recorder.exportRecording();
      const response = await fetch(`${sink.url}/capture.json`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(exported.recording) });
      if (!response.ok) throw new Error(`Capture log upload: ${response.status}`);
      const summary = { first, resident, commandCount: exported.recording.commands.length, blobCount: exported.recording.blobs.length, uploadedBytes, uploadCount, frames: exported.recording.frames, screenshot, probe: rasterProbe.summary() };
      recorder.dispose(); rasterProbe.dispose();
      return summary;
    } finally { HTMLCanvasElement.prototype.getContext = getContext; }
  }, sink);
  const screenshot = Buffer.from(result.screenshot.png.split(',')[1], 'base64');
  await writeFile(path.join(root, 'browser.png'), screenshot);
  result.screenshot = { file: 'browser.png', glError: result.screenshot.glError };
  await writeFile(path.join(root, 'browser-report.json'), JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ commandCount: result.commandCount, blobCount: result.blobCount, uploadedBytes: result.uploadedBytes, errors }));
} catch (error) {
  await writeFile(path.join(root, 'capture-failure.json'), JSON.stringify({ message: error.stack ?? String(error), errors }, null, 2));
  throw error;
} finally { await browser.close(); }
