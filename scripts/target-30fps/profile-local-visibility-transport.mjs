import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Isolated local-only transport measurement. No world, rendering or user browser.
const sizes = [0, 4, 8, 16, 32].map(mib => mib * 1024 * 1024);
const buffers = new Map(sizes.map(size => [size, Buffer.alloc(size, 173)]));
const server = http.createServer((request, response) => {
  const size = Number(new URL(request.url, 'http://localhost').searchParams.get('size'));
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Local transport measurement</title>');
    return;
  }
  if (request.url.startsWith('/frame') && buffers.has(size)) {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Length': size, 'Cache-Control': 'no-store' });
      response.end(buffers.get(size));
    });
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(),
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(async sizes => {
    const rows = [], camera = new Float32Array(32);
    for (const bytes of sizes) {
      const times = [];
      for (let frame = 0; frame < 24; frame++) {
        const start = performance.now();
        const response = await fetch(`/frame?size=${bytes}`, { method: 'POST', body: camera });
        const frameData = await response.arrayBuffer();
        const data = new Uint8Array(frameData);
        if (frameData.byteLength !== bytes || (bytes && (data[0] !== 173 || data[bytes-1] !== 173)))
          throw new Error('Frame transport lost data');
        if (frame >= 4) times.push(performance.now() - start);
      }
      times.sort((a,b) => a-b);
      rows.push({ bytes, medianMs: times[Math.floor(times.length/2)], p95Ms: times[Math.ceil(times.length*.95)-1], samples: times.length });
    }
    return rows;
  }, sizes);
  const report = { timestamp: new Date().toISOString(), results,
    scope: 'Uncompressed local HTTP request and browser ArrayBuffer delivery only. Excludes native readback, rendering and GPU upload.' };
  await writeFile('artifacts/four-horizons/target-30fps/local-transport.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
