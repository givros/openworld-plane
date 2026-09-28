import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.env.MSAA_OUTPUT ?? 'artifacts/four-horizons/target-30fps/webgl-msaa-calibration';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent('<canvas width="1440" height="900"></canvas>');
  const report = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2', { antialias: true, alpha: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_debug_renderer_info'), hardware = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    if (gl.getParameter(gl.SAMPLES) !== 4) throw new Error('Expected actual default-framebuffer 4xMSAA');
    const compile = (type, source) => { const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)); return shader; };
    const vertex = compile(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
    const fragment = compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.);}');
    const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program); const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const location = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, 1440, 900); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.DITHER); gl.enable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 1);
    const pixel = new Uint8Array(4), vertices = new Float32Array(12);
    function coverage(px, py, x, y) {
      gl.scissor(px, py, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const left = px / 720 - 1, right = (px + x) / 720 - 1, bottom = py / 450 - 1, top = (py + y) / 450 - 1;
      vertices.set([left, bottom, right, bottom, right, top, left, bottom, right, top, left, top]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW); gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return pixel[0];
    }
    const thresholds = [0, ...Array.from({ length: 16 }, (_, i) => (i + .5) / 16), 1], probes = [];
    for (const [x, y] of [[720, 450], [101, 99], [1000, 700], [1377, 832]]) {
      const raw = thresholds.map(ty => thresholds.map(tx => coverage(x, y, tx, ty)));
      const levels = [...new Set(raw.flat())].sort((a, b) => a - b);
      if (levels.length !== 5 || levels[0] !== 0 || levels[4] !== 255) throw new Error(`Unexpected coverage resolve levels: ${levels}`);
      const counts = raw.map(row => row.map(value => levels.indexOf(value))), occupied = [];
      for (let j = 1; j < thresholds.length; j++) for (let i = 1; i < thresholds.length; i++) {
        const count = counts[j][i] - counts[j][i - 1] - counts[j - 1][i] + counts[j - 1][i - 1];
        if (count) occupied.push({ count, x: [thresholds[i - 1], thresholds[i]], y: [thresholds[j - 1], thresholds[j]] });
      }
      if (occupied.length !== 4 || occupied.some(cell => cell.count !== 1)) throw new Error('Joint coverage distribution is not four distinct samples');
      const refined = occupied.map(cell => {
        let [loX, hiX] = cell.x, [loY, hiY] = cell.y;
        const lowerXCount = levels.indexOf(coverage(x, y, loX, 1)), lowerYCount = levels.indexOf(coverage(x, y, 1, loY));
        for (let n = 0; n < 8; n++) { const middle = (loX + hiX) / 2; if (levels.indexOf(coverage(x, y, middle, 1)) > lowerXCount) hiX = middle; else loX = middle; }
        for (let n = 0; n < 8; n++) { const middle = (loY + hiY) / 2; if (levels.indexOf(coverage(x, y, 1, middle)) > lowerYCount) hiY = middle; else loY = middle; }
        const bottomLeft = [(cell.x[0] + cell.x[1]) / 2, (cell.y[0] + cell.y[1]) / 2];
        return { coarseBounds: cell, thresholdTransitionBounds: { x: [loX, hiX], y: [loY, hiY] }, bottomLeftGrid16: bottomLeft, topLeftGrid16: [bottomLeft[0], 1 - bottomLeft[1]] };
      });
      probes.push({ pixelBottomLeft: [x, y], levels, counts, samples: refined });
    }
    const glError = gl.getError();
    gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { hardware, framebuffer: { width: 1440, height: 900, samples: 4, alpha: false }, thresholds, probes, glError,
      scope: 'Measured joint default-framebuffer sample coverage via actual subpixel rectangle rasterization and resolved readPixels. Coordinates converted from WebGL bottom-left to native camera top-left. Grid16 centers are inferred within the measured transition bounds; edge transitions include raster fixed-point snapping.' };
  });
  await writeFile(`${output}/report.json`, JSON.stringify({ timestamp: new Date().toISOString(), ...report }, null, 2));
  console.log(JSON.stringify({ hardware: report.hardware, glError: report.glError, probes: report.probes.map(x => ({ pixel: x.pixelBottomLeft, levels: x.levels, samples: x.samples })) }, null, 2));
} finally { await browser.close(); }
