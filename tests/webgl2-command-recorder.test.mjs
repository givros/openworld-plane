import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGL2CommandRecorder } from '../src/experiments/WebGL2CommandRecorder.ts';

function fixture() {
  const calls = [], extensions = {}, parameters = new Map([[0x80a9, 4], [0x0d56, 24], [0x0d57, 0], [3317, 4]]);
  let next = 0;
  class FakeGL {
    constructor() { this.drawingBufferWidth = 1440; this.drawingBufferHeight = 900; this.drawingBufferColorSpace = 'srgb'; this.unpackColorSpace = 'srgb'; }
    getParameter(value) { calls.push(['getParameter', value]); return parameters.get(value) ?? null; }
    getContextAttributes() { return { alpha: false, depth: true, stencil: false, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: false }; }
    getExtension(name) { calls.push(['getExtension', name]); return extensions[name] ?? null; }
    getUniformLocation(program, name) { calls.push(['getUniformLocation', program, name]); return name === 'missing' ? null : { native: ++next }; }
    getAttribLocation(program, name) { calls.push(['getAttribLocation', program, name]); return name === 'position' ? 3 : -1; }
    getUniformBlockIndex(program, name) { calls.push(['getUniformBlockIndex', program, name]); return name === 'Camera' ? 2 : 0xffffffff; }
    pixelStorei(name, value) { calls.push(['pixelStorei', name, value]); parameters.set(name, value); }
    futureMutation(...args) { calls.push(['futureMutation', ...args]); }
  }
  const create = 'createBuffer createTexture createProgram createShader createFramebuffer createRenderbuffer createVertexArray createSampler createQuery createTransformFeedback fenceSync'.split(' ');
  const commands = 'shaderSource compileShader attachShader linkProgram useProgram bindBuffer bufferData bufferSubData deleteBuffer bindVertexArray enableVertexAttribArray vertexAttribPointer vertexAttribIPointer vertexAttribDivisor bindFramebuffer framebufferTexture2D bindRenderbuffer renderbufferStorageMultisample framebufferRenderbuffer bindTexture activeTexture texImage2D texSubImage2D texImage3D texSubImage3D uniform1f uniform1fv uniform3fv uniformMatrix4fv viewport clearColor clear drawElementsInstanced readPixels deleteTexture deleteProgram deleteShader flush'.split(' ');
  for (const name of create) Object.defineProperty(FakeGL.prototype, name, { configurable: true, writable: true, value(...args) { calls.push([name, ...args]); return { native: ++next }; } });
  for (const name of commands) Object.defineProperty(FakeGL.prototype, name, { configurable: true, writable: true, value(...args) { calls.push([name, ...args]); } });
  return { gl: new FakeGL(), calls, extensions, parameters, FakeGL };
}
const blobMap = async result => new Map(await Promise.all(result.blobs.map(async ({ id, blob }) => [id, new Uint8Array(await blob.arrayBuffer())])));

test('records native shader, handle identity, lookup evidence, VAO/FBO state and draw ordering without recording getters', async () => {
  const { gl, calls } = fixture(), recorder = new WebGL2CommandRecorder(gl);
  calls.length = 0;
  const shader = gl.createShader(35633), program = gl.createProgram();
  const source = '#version 300 es\n#define USE_SHADOWMAP\nlayout(location=3) in vec3 position;\nvoid main(){gl_Position=vec4(position,1.);}\n';
  gl.shaderSource(shader, source); gl.compileShader(shader); gl.attachShader(program, shader); gl.linkProgram(program);
  assert.equal(gl.getAttribLocation(program, 'position'), 3); assert.equal(gl.getUniformBlockIndex(program, 'Camera'), 2);
  const location = gl.getUniformLocation(program, 'modelViewMatrix'); assert.equal(gl.getUniformLocation(program, 'missing'), null);
  gl.getParameter(0x80a9);
  const vao = gl.createVertexArray(), buffer = gl.createBuffer(), framebuffer = gl.createFramebuffer(), texture = gl.createTexture();
  gl.bindVertexArray(vao); gl.bindBuffer(34962, buffer); gl.vertexAttribPointer(3, 3, 5126, false, 12, 0); gl.enableVertexAttribArray(3); gl.vertexAttribDivisor(3, 1);
  gl.bindFramebuffer(36160, framebuffer); gl.framebufferTexture2D(36160, 36064, 3553, texture, 0);
  recorder.beginFrame('stock-shader'); gl.useProgram(program); gl.uniformMatrix4fv(location, false, new Float32Array(16)); gl.viewport(0, 0, 1440, 900); gl.drawElementsInstanced(4, 12, 5125, 0, 9); recorder.endFrame();
  const { recording } = await recorder.exportRecording();
  assert.deepEqual(recording.commands.map(command => command.op), calls.filter(call => call[0] !== 'getParameter').map(call => call[0]));
  assert.equal(recording.commands.find(command => command.op === 'shaderSource').args[1], source);
  const uniform = recording.resources.find(resource => resource.object === 'UniformLocation');
  assert.deepEqual({ program: uniform.program, name: uniform.name, linkGeneration: uniform.linkGeneration }, { program: 2, name: 'modelViewMatrix', linkGeneration: 1 });
  assert.deepEqual(recording.commands.find(command => command.op === 'uniformMatrix4fv').args[0], { object: 'UniformLocation', id: uniform.id });
  assert.equal(recording.commands.find(command => command.op === 'getAttribLocation').result, 3);
  assert.equal(recording.commands.find(command => command.op === 'getUniformBlockIndex').result, 2);
  assert.deepEqual(recording.initialDrawingBuffer, { width: 1440, height: 900, samples: 4, depthBits: 24, stencilBits: 0 });
  assert.equal(recording.contextAttributes.antialias, true); assert.equal(recording.contextAttributes.stencil, false);
  assert.equal(recording.frames[0].label, 'stock-shader'); assert.equal(recording.commands.at(-1).frame, 1);
  assert.ok(Object.isFrozen(recording.commands.at(-1).args)); recorder.dispose();
});

test('snapshots exact typed subview bytes immediately, retaining WebGL2 element offsets and special scalar values', async () => {
  const { gl, calls } = fixture(), recorder = new WebGL2CommandRecorder(gl);
  const buffer = gl.createBuffer(); gl.bindBuffer(34962, buffer);
  const full = new Float32Array([99, 1.25, -0, 3.5, 88]), view = full.subarray(1, 4);
  gl.bufferData(34962, view, 35044, 1, 2); gl.bufferSubData(34962, 8, new DataView(full.buffer, 4, 8));
  gl.clearColor(-0, NaN, Infinity, -Infinity);
  assert.equal(calls.find(call => call[0] === 'bufferData')[2], view);
  full.fill(45);
  const result = await recorder.exportRecording(), blobs = await blobMap(result), command = result.recording.commands.find(row => row.op === 'bufferData');
  assert.deepEqual(command.args.slice(3), [1, 2]); assert.equal(command.args[1].byteLength, 12); assert.equal(command.args[1].type, 'Float32Array');
  assert.deepEqual(new Float32Array(blobs.get(command.args[1].blob).buffer), new Float32Array([1.25, -0, 3.5]));
  const dataView = result.recording.commands.find(row => row.op === 'bufferSubData').args[2]; assert.equal(dataView.type, 'DataView'); assert.equal(blobs.get(dataView.blob).length, 8);
  assert.deepEqual(result.recording.commands.at(-1).args, [{ number: '-0' }, { number: 'NaN' }, { number: 'Infinity' }, { number: '-Infinity' }]);
  recorder.dispose();
});

test('normalizes typed 2D and 3D texture overloads, pixel-store state and PBO offsets without altering original arguments', async () => {
  const { gl, calls } = fixture(), recorder = new WebGL2CommandRecorder(gl), pixels = new Uint8Array(96);
  gl.pixelStorei(3317, 1); gl.pixelStorei(3314, 6); gl.unpackColorSpace = 'display-p3';
  gl.texImage2D(3553, 2, 32856, 2, 3, 0, 6408, 5121, pixels, 8);
  gl.pixelStorei(3314, 0); gl.texSubImage3D(35866, 0, 4, 5, 6, 2, 3, 1, 6408, 5121, pixels, 12);
  gl.texImage3D(32879, 0, 32856, 2, 3, 4, 0, 6408, 5121, null);
  const pbo = gl.createBuffer(); gl.bindBuffer(35052, pbo); gl.texSubImage2D(3553, 0, 2, 4, 2, 3, 6408, 5121, 64);
  const result = await recorder.exportRecording(), uploads = result.recording.commands.filter(row => row.textureUpload).map(row => row.textureUpload);
  assert.deepEqual([uploads[0].width, uploads[0].height, uploads[0].depth, uploads[0].sourceElementOffset], [2, 3, 1, 8]);
  assert.equal(uploads[0].unpack['3314'], 6); assert.equal(uploads[0].unpack.unpackColorSpace, 'display-p3'); assert.equal(uploads[1].unpack['3314'], 0);
  assert.deepEqual([uploads[1].xoffset, uploads[1].yoffset, uploads[1].zoffset, uploads[1].sourceElementOffset], [4, 5, 6, 12]);
  assert.equal(uploads[2].sourceKind, 'null-allocation'); assert.equal(uploads[2].pixels, null);
  assert.equal(uploads[3].sourceKind, 'pixel-unpack-buffer-offset'); assert.equal(uploads[3].pixels, 64);
  assert.equal(calls.find(row => row[0] === 'texImage2D')[9], pixels); recorder.dispose(); assert.equal(gl.unpackColorSpace, 'display-p3');
});

test('captures exact RGBA8 DOM snapshots and explicit ImageBitmap creation policy', async () => {
  class ImageBitmap { constructor() { this.width = 2; this.height = 1; } }
  class ImageData { constructor() { this.width = 1; this.height = 1; this.data = new Uint8ClampedArray([1, 2, 3, 4]); this.colorSpace = 'srgb'; } }
  const { gl } = fixture(), rgba = new Uint8Array([1, 20, 30, 255, 4, 50, 60, 128]), requests = [];
  const recorder = new WebGL2CommandRecorder(gl, { captureImage(source, request) { requests.push(request); return { bytes: new Blob([rgba]), encoding: 'rgba8', width: source.width, height: source.height, rowOrigin: 'top-left', premultipliedAlpha: false, colorSpace: 'srgb', sourceCreation: { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' } }; } });
  gl.pixelStorei(37440, true); gl.texImage2D(3553, 0, 6408, 6408, 5121, new ImageBitmap());
  const imageData = new ImageData(); gl.texSubImage2D(3553, 0, 1, 0, 6408, 5121, imageData); rgba.fill(0); imageData.data.fill(0);
  const result = await recorder.exportRecording(), blobs = await blobMap(result), uploads = result.recording.commands.filter(row => row.textureUpload);
  assert.equal(requests.length, 1); assert.equal(requests[0].unpack['37440'], true);
  assert.deepEqual([uploads[0].textureUpload.width, uploads[0].textureUpload.height], [2, 1]);
  const image = uploads[0].args[5].image; assert.equal(image.type, 'rgba8'); assert.equal(image.sourceCreation.imageOrientation, 'flipY');
  assert.deepEqual([...blobs.get(image.blob)], [1, 20, 30, 255, 4, 50, 60, 128]);
  assert.deepEqual([...blobs.get(uploads[1].args[6].image.blob)], [1, 2, 3, 4]); recorder.dispose();
});

test('external immutable blob sink is awaited and exports raw references separately from command JSON', async () => {
  const { gl } = fixture(), writes = [], gates = [];
  const recorder = new WebGL2CommandRecorder(gl, { captureBlob(blob, info) { writes.push({ blob, info }); return new Promise(resolve => gates.push(() => resolve({ file: `resources/${info.id}.bin`, byteOffset: 0, sha256: 'fixture-digest' }))); } });
  const bytes = new Uint8Array([5, 6, 7]); gl.bufferData(34962, bytes, 35044); bytes.fill(0);
  let done = false; const pending = recorder.exportRecording().then(value => { done = true; return value; }); await Promise.resolve(); assert.equal(done, false);
  assert.deepEqual([...new Uint8Array(await writes[0].blob.arrayBuffer())], [5, 6, 7]); gates[0]();
  const result = await pending; assert.equal(result.blobs.length, 0); assert.equal(result.recording.blobs[0].reference.file, 'resources/b1.bin');
  assert.equal(JSON.stringify(result.recording).includes('base64'), false); assert.equal(writes[0].info.argument, 1); recorder.dispose();
});

test('stable resource IDs span frames, deletion and program relinking; dispose restores owned context and extension methods', async () => {
  const { gl, extensions } = fixture(), calls = [];
  extensions.WEBGL_multi_draw = { multiDrawElementsWEBGL(...args) { calls.push(args); } };
  const oldCreate = gl.createBuffer, oldExtension = extensions.WEBGL_multi_draw.multiDrawElementsWEBGL;
  const recorder = new WebGL2CommandRecorder(gl), buffer = gl.createBuffer(), program = gl.createProgram();
  gl.linkProgram(program); const first = gl.getUniformLocation(program, 't');
  recorder.beginFrame('one'); gl.bindBuffer(34962, buffer); gl.uniform1f(first, 1); recorder.endFrame();
  gl.linkProgram(program); const second = gl.getUniformLocation(program, 't');
  recorder.beginFrame('two'); gl.uniform1f(second, 2); gl.deleteBuffer(buffer); const replacement = gl.createBuffer(); gl.bindBuffer(34962, replacement);
  const extension = gl.getExtension('WEBGL_multi_draw'), counts = new Int32Array([3, 6]), offsets = new Int32Array([0, 12]);
  extension.multiDrawElementsWEBGL(4, counts, 0, 5125, offsets, 0, 2); counts.fill(0); recorder.endFrame(); gl.drawingBufferColorSpace = 'display-p3';
  const result = await recorder.exportRecording(), blobs = await blobMap(result), resource = result.recording.resources.find(row => row.object === 'Buffer');
  assert.ok(resource.deletedAt > resource.createdAt); assert.equal(result.recording.resources.filter(row => row.object === 'Buffer').length, 2);
  assert.deepEqual(result.recording.resources.filter(row => row.object === 'UniformLocation').map(row => row.linkGeneration), [1, 2]);
  const command = result.recording.commands.find(row => row.op.includes('multiDrawElements')); assert.equal(command.frame, 2); assert.deepEqual([...new Int32Array(blobs.get(command.args[1].blob).buffer)], [3, 6]);
  assert.equal(calls.length, 1); recorder.dispose(); assert.equal(gl.createBuffer, oldCreate); assert.equal(extension.multiDrawElementsWEBGL, oldExtension); assert.equal(gl.drawingBufferColorSpace, 'display-p3');
  assert.equal(Object.hasOwn(gl, 'createBuffer'), false); assert.equal(result.recording.frames.length, 2);
});

test('readPixels only records GPU buffer writes, while CPU readbacks remain unrecorded queries', async () => {
  const { gl, calls } = fixture(), recorder = new WebGL2CommandRecorder(gl);
  gl.readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4));
  const buffer = gl.createBuffer(); gl.bindBuffer(0x88eb, buffer); gl.readPixels(0, 0, 1, 1, 6408, 5121, 32);
  gl.bindBuffer(0x88eb, null); gl.readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4));
  const { recording } = await recorder.exportRecording(); assert.equal(calls.filter(row => row[0] === 'readPixels').length, 3); assert.deepEqual(recording.commands.filter(row => row.op === 'readPixels').map(row => row.args[6]), [32]); recorder.dispose();
});

test('fails before unsupported mutations and leaves unrelated contexts and subsequent wrappers untouched', async () => {
  const { gl, calls, FakeGL } = fixture(), other = new FakeGL(), original = other.futureMutation;
  const recorder = new WebGL2CommandRecorder(gl); assert.throws(() => gl.futureMutation(1), /Unsupported mutating/); assert.equal(calls.some(row => row[0] === 'futureMutation'), false);
  assert.equal(other.futureMutation, original); other.futureMutation(2); assert.equal(calls.at(-1)[1], 2);
  const laterWrapper = () => 'later owner'; gl.createBuffer = laterWrapper; recorder.dispose(); assert.equal(gl.createBuffer, laterWrapper); await assert.rejects(recorder.exportRecording(), /Unsupported mutating/);
});

test('rejects unregistered resources, missing DOM capture, concurrent shared buffers and capture reentrancy', () => {
  for (const [action, expected] of [
    [gl => gl.bindBuffer(34962, {}), /Unregistered GL object/],
    [gl => gl.texImage2D(3553, 0, 6408, 6408, 5121, { width: 1, height: 1 }), /needs captureImage/],
    [gl => gl.bufferData(34962, new Uint8Array(new SharedArrayBuffer(8)), 35044), /cannot be captured atomically/],
  ]) {
    const { gl, calls } = fixture(), recorder = new WebGL2CommandRecorder(gl); calls.length = 0; assert.throws(() => action(gl), expected); assert.equal(calls.length, 0); recorder.dispose();
  }
  const { gl, calls } = fixture(), recorder = new WebGL2CommandRecorder(gl, { captureBlob() { gl.unpackColorSpace = 'display-p3'; return { file: 'bad.bin' }; } });
  calls.length = 0; assert.throws(() => gl.bufferData(34962, new Uint8Array(1), 35044), /must not mutate/); assert.equal(calls.length, 0); assert.equal(gl.unpackColorSpace, 'srgb'); recorder.dispose();
});

test('failed asynchronous persistence and partial or resized frames cannot export a misleading complete recording', async () => {
  const first = fixture(), failed = new WebGL2CommandRecorder(first.gl, { captureBlob: () => Promise.reject(new Error('disk full')) });
  first.gl.bufferData(34962, new Uint8Array(2), 35044); await assert.rejects(failed.exportRecording(), /disk full/); failed.dispose();
  const second = fixture(), partial = new WebGL2CommandRecorder(second.gl); partial.beginFrame(); await assert.rejects(partial.exportRecording(), /End the frame/); partial.dispose(); await assert.rejects(partial.exportRecording(), /End the frame|incomplete frame/);
  const third = fixture(), resize = new WebGL2CommandRecorder(third.gl); resize.beginFrame(); third.gl.drawingBufferWidth = 12; assert.throws(() => resize.endFrame(), /resized inside a frame/); resize.dispose();
});

test('verified immutable large-buffer callback bypasses all Blob allocation and awaits verification before export', async () => {
  const { gl } = fixture(), source = new Float32Array(17 * 1024 * 1024), view = source.subarray(3, source.length - 3);
  view[0] = 12.5; view[view.length - 1] = -45.25;
  const OriginalBlob = globalThis.Blob; let verify, providerInput, providerInfo;
  const recorder = new WebGL2CommandRecorder(gl, { captureImmutableBuffer(input, info) { providerInput = input; providerInfo = info; return new Promise(resolve => { verify = () => resolve({ file: 'atlas/exact-float32.bin', byteOffset: input.byteOffset, sha256: 'verified-by-provider' }); }); }, captureBlob() { throw new Error('Blob sink must not be invoked'); } });
  try {
    globalThis.Blob = class { constructor() { throw new Error('No large Blob allocation is permitted'); } };
    gl.bufferData(34962, view, 35044, 4, 20);
  } finally { globalThis.Blob = OriginalBlob; }
  assert.equal(providerInput, view); assert.equal(providerInfo.byteLength, view.byteLength); assert.equal(providerInfo.type, 'Float32Array');
  let completed = false; const resultPromise = recorder.exportRecording().then(result => { completed = true; return result; }); await Promise.resolve(); assert.equal(completed, false);
  verify(); const result = await resultPromise; assert.equal(result.blobs.length, 0); assert.equal(result.recording.blobs[0].reference.byteOffset, 12);
  assert.deepEqual(result.recording.commands[0].args.slice(3), [4, 20]); assert.equal(result.recording.commands[0].args[1].byteLength, view.byteLength); recorder.dispose();
});

test('declining immutable provider retains immediate snapshot; unverifiable async references fail closed', async () => {
  const { gl } = fixture(), recorder = new WebGL2CommandRecorder(gl, { captureImmutableBuffer: () => undefined });
  const bytes = new Uint8Array([8, 9]); gl.bufferData(34962, bytes, 35044); bytes.fill(0); const result = await recorder.exportRecording(); assert.deepEqual([...new Uint8Array(await result.blobs[0].blob.arrayBuffer())], [8, 9]); assert.equal(result.recording.blobs[0].id, 'b1'); recorder.dispose();
  for (const value of [Promise.resolve(undefined), Promise.reject(new Error('SHA-256 mismatch'))]) {
    const item = fixture(), invalid = new WebGL2CommandRecorder(item.gl, { captureImmutableBuffer: () => value });
    item.gl.bufferData(34962, new Uint8Array(2), 35044); await assert.rejects(invalid.exportRecording(), /Invalid immutable blob|SHA-256 mismatch/); invalid.dispose();
  }
});
