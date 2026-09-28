/** Isolated owned-context capture. Install before creating any Three resources. */
export type GLObjectKind = 'Buffer' | 'Texture' | 'Program' | 'Shader' | 'Framebuffer' | 'Renderbuffer' | 'VertexArray' | 'Sampler' | 'Query' | 'Sync' | 'TransformFeedback' | 'UniformLocation';
export interface GLObjectReference { readonly object: GLObjectKind; readonly id: number }
export interface BinaryReference { readonly blob: string; readonly type: string; readonly byteLength: number }
export type RecordedValue = null | boolean | number | string | readonly RecordedValue[] | { readonly [key: string]: RecordedValue };
export interface ExternalBlobReference { readonly file: string; readonly byteOffset?: number; readonly sha256?: string }
export interface RecordedBlob { readonly id: string; readonly byteLength: number; readonly reference?: ExternalBlobReference }
export interface CapturedTextureImage {
  /** Must represent this call's exact pixels, with the following encoding metadata. */
  readonly bytes: Blob;
  readonly encoding: 'rgba8' | 'png' | 'jpeg' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly rowOrigin: 'top-left' | 'bottom-left';
  readonly premultipliedAlpha: boolean;
  readonly colorSpace: string;
  /** ImageBitmap creation may already have applied flip/premultiply/conversion. */
  readonly sourceCreation?: Readonly<Record<string, RecordedValue>>;
}
export interface TextureCaptureRequest {
  readonly op: string;
  readonly sourceKind: string;
  readonly unpack: Readonly<Record<string, RecordedValue>>;
}
export interface WebGL2RecorderOptions {
  /**
   * Explicit immutable-resource fast path, called BEFORE allocating a Blob.
   * The provider must prove that the returned file range has exactly these view
   * bytes, and must keep the borrowed buffer immutable until its Promise settles.
   * A synchronous undefined declines the fast path and retains ordinary immediate
   * snapshots. A Promise must resolve to a verified reference, never undefined.
   */
  readonly captureImmutableBuffer?: (source: ArrayBuffer | ArrayBufferView, info: Readonly<{ id: string; byteLength: number; type: string; op: string; argument: number }>) => ExternalBlobReference | Promise<ExternalBlobReference> | undefined;
  /** Blob is immutable and already snapshots the source at the GL call. */
  readonly captureBlob?: (blob: Blob, info: Readonly<{ id: string; byteLength: number; op: string; argument: number }>) => ExternalBlobReference | Promise<ExternalBlobReference>;
  /** Required for ImageBitmap/image/canvas/video inputs; no implicit canvas/color conversion. */
  readonly captureImage?: (source: unknown, request: TextureCaptureRequest) => CapturedTextureImage;
}
export interface RecordedGLCommand {
  readonly seq: number;
  readonly frame: number | null;
  readonly op: string;
  readonly args: readonly RecordedValue[];
  readonly result?: RecordedValue;
  readonly textureUpload?: Readonly<Record<string, RecordedValue>>;
}
export interface RecordedGLFrame {
  readonly id: number;
  readonly label: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
}
export interface GLResourceRecord extends GLObjectReference {
  readonly createdAt: number;
  readonly deletedAt?: number;
  readonly program?: number;
  readonly name?: string;
  readonly linkGeneration?: number;
}
export interface WebGL2Recording {
  readonly version: 1;
  readonly commands: readonly RecordedGLCommand[];
  readonly resources: readonly GLResourceRecord[];
  readonly blobs: readonly RecordedBlob[];
  readonly frames: readonly RecordedGLFrame[];
  readonly contextAttributes: Readonly<Record<string, RecordedValue>> | null;
  readonly initialDrawingBuffer: Readonly<{ width: number; height: number; samples: number | null; depthBits: number | null; stencilBits: number | null }>;
}

type AnyFunction = (...args: any[]) => any;
type GLContextLike = Record<string, any>;
interface ResourceState { reference: GLObjectReference; createdAt: number; deletedAt?: number; program?: number; name?: string; linkGeneration?: number }
interface RestoreEntry { target: object; name: string; original?: PropertyDescriptor; installed: PropertyDescriptor }
interface ActiveFrame { id: number; label: string; firstSequence: number; width: number; height: number }

const READONLY = new Set(`checkFramebufferStatus clientWaitSync getActiveAttrib getActiveUniform getActiveUniformBlockName getActiveUniformBlockParameter getActiveUniforms getAttachedShaders getBufferParameter getBufferSubData getContextAttributes getError getFragDataLocation getFramebufferAttachmentParameter getIndexedParameter getInternalformatParameter getParameter getProgramInfoLog getProgramParameter getQuery getQueryParameter getRenderbufferParameter getSamplerParameter getShaderInfoLog getShaderParameter getShaderPrecisionFormat getShaderSource getSupportedExtensions getSyncParameter getTexParameter getTransformFeedbackVarying getUniform getUniformIndices getVertexAttrib getVertexAttribOffset isBuffer isContextLost isEnabled isFramebuffer isProgram isQuery isRenderbuffer isSampler isShader isSync isTexture isTransformFeedback isVertexArray`.split(' '));
const CORE_COMMANDS = new Set(`activeTexture attachShader beginQuery beginTransformFeedback bindAttribLocation bindBuffer bindBufferBase bindBufferRange bindFramebuffer bindRenderbuffer bindSampler bindTexture bindTransformFeedback bindVertexArray blendColor blendEquation blendEquationSeparate blendFunc blendFuncSeparate blitFramebuffer bufferData bufferSubData clear clearBufferfi clearBufferfv clearBufferiv clearBufferuiv clearColor clearDepth clearStencil colorMask compileShader compressedTexImage2D compressedTexImage3D compressedTexSubImage2D compressedTexSubImage3D copyBufferSubData copyTexImage2D copyTexSubImage2D copyTexSubImage3D createBuffer createFramebuffer createProgram createQuery createRenderbuffer createSampler createShader createTexture createTransformFeedback createVertexArray cullFace deleteBuffer deleteFramebuffer deleteProgram deleteQuery deleteRenderbuffer deleteSampler deleteShader deleteSync deleteTexture deleteTransformFeedback deleteVertexArray depthFunc depthMask depthRange detachShader disable disableVertexAttribArray drawArrays drawArraysInstanced drawBuffers drawElements drawElementsInstanced drawRangeElements enable enableVertexAttribArray endQuery endTransformFeedback fenceSync finish flush framebufferRenderbuffer framebufferTexture2D framebufferTextureLayer frontFace generateMipmap hint invalidateFramebuffer invalidateSubFramebuffer lineWidth linkProgram pauseTransformFeedback pixelStorei polygonOffset readBuffer renderbufferStorage renderbufferStorageMultisample resumeTransformFeedback sampleCoverage samplerParameterf samplerParameteri scissor shaderSource stencilFunc stencilFuncSeparate stencilMask stencilMaskSeparate stencilOp stencilOpSeparate texImage2D texImage3D texParameterf texParameteri texStorage2D texStorage3D texSubImage2D texSubImage3D transformFeedbackVaryings uniform1f uniform1fv uniform1i uniform1iv uniform1ui uniform1uiv uniform2f uniform2fv uniform2i uniform2iv uniform2ui uniform2uiv uniform3f uniform3fv uniform3i uniform3iv uniform3ui uniform3uiv uniform4f uniform4fv uniform4i uniform4iv uniform4ui uniform4uiv uniformBlockBinding uniformMatrix2fv uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4fv uniformMatrix4x2fv uniformMatrix4x3fv useProgram validateProgram vertexAttrib1f vertexAttrib1fv vertexAttrib2f vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f vertexAttrib4fv vertexAttribDivisor vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv vertexAttribIPointer vertexAttribPointer viewport waitSync`.split(' '));
const EXT_COMMANDS = new Set(`multiDrawArraysWEBGL multiDrawElementsWEBGL multiDrawArraysInstancedWEBGL multiDrawElementsInstancedWEBGL multiDrawArraysInstancedBaseInstanceWEBGL multiDrawElementsInstancedBaseVertexBaseInstanceWEBGL drawArraysInstancedANGLE drawElementsInstancedANGLE vertexAttribDivisorANGLE drawArraysInstancedBaseInstanceWEBGL drawElementsInstancedBaseVertexBaseInstanceWEBGL createVertexArrayOES bindVertexArrayOES deleteVertexArrayOES drawBuffersWEBGL queryCounterEXT beginQueryEXT endQueryEXT createQueryEXT deleteQueryEXT blendEquationiOES blendEquationSeparateiOES blendFunciOES blendFuncSeparateiOES colorMaskiOES enableiOES disableiOES polygonOffsetClampEXT framebufferTextureMultiviewOVR framebufferTextureMultisampleMultiviewOVR`.split(' '));
const EXT_READONLY = new Set('getTranslatedShaderSource getQueryEXT getQueryObjectEXT getQueryObjectuivEXT isQueryEXT isVertexArrayOES'.split(' '));
const CREATE: Record<string, GLObjectKind> = { createBuffer: 'Buffer', createTexture: 'Texture', createProgram: 'Program', createShader: 'Shader', createFramebuffer: 'Framebuffer', createRenderbuffer: 'Renderbuffer', createVertexArray: 'VertexArray', createVertexArrayOES: 'VertexArray', createSampler: 'Sampler', createQuery: 'Query', createQueryEXT: 'Query', createTransformFeedback: 'TransformFeedback', fenceSync: 'Sync' };
const LOOKUPS = new Set(['getUniformLocation', 'getAttribLocation', 'getUniformBlockIndex']);
const UNPACK_DEFAULTS: Record<string, RecordedValue> = { '3317': 4, '3314': 0, '3315': 0, '3316': 0, '32878': 0, '32877': 0, '37440': false, '37441': false, '37443': 37444 };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child); }
  return value;
}
function cloneJSON<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function methodNames(object: object): Set<string> {
  const names = new Set<string>();
  for (let cursor: object | null = object; cursor && cursor !== Object.prototype; cursor = Object.getPrototypeOf(cursor)) for (const name of Object.getOwnPropertyNames(cursor)) {
    if (name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(cursor, name)?.value === 'function') names.add(name);
  }
  return names;
}
function descriptorInChain(object: object, name: string): PropertyDescriptor | undefined {
  for (let cursor: object | null = object; cursor; cursor = Object.getPrototypeOf(cursor)) { const descriptor = Object.getOwnPropertyDescriptor(cursor, name); if (descriptor) return descriptor; }
  return undefined;
}

export class WebGL2CommandRecorder {
  private readonly context: GLContextLike;
  private readonly options: WebGL2RecorderOptions;
  private readonly commands: RecordedGLCommand[] = [];
  private readonly frames: RecordedGLFrame[] = [];
  private readonly resourceStates: ResourceState[] = [];
  private readonly objects = new WeakMap<object, ResourceState>();
  private readonly programLinks = new Map<number, number>();
  private readonly blobRecords = new Map<string, RecordedBlob>();
  private readonly retainedBlobs = new Map<string, Blob>();
  private readonly pendingBlobs = new Set<Promise<void>>();
  private readonly restored: RestoreEntry[] = [];
  private readonly wrappedExtensions = new WeakSet<object>();
  private readonly unpack: Record<string, RecordedValue> = { ...UNPACK_DEFAULTS };
  private readonly contextAttributes: Readonly<Record<string, RecordedValue>> | null;
  private readonly initialDrawingBuffer: { width: number; height: number; samples: number | null; depthBits: number | null; stencilBits: number | null };
  private activeFrame: ActiveFrame | null = null;
  private sequence = 0;
  private frameSequence = 0;
  private blobSequence = 0;
  private capturing = false;
  private disposed = false;
  private failure: Error | null = null;
  private pixelPackBuffer: unknown = null;

  constructor(context: WebGL2RenderingContext | object, options: WebGL2RecorderOptions = {}) {
    this.context = context as GLContextLike; this.options = options;
    const numericParameter = (name: number): number | null => {
      const value = typeof this.context.getParameter === 'function' ? this.context.getParameter(name) : null;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    this.contextAttributes = typeof this.context.getContextAttributes === 'function' ? cloneJSON(this.context.getContextAttributes()) : null;
    this.initialDrawingBuffer = { width: Number(this.context.drawingBufferWidth ?? 0), height: Number(this.context.drawingBufferHeight ?? 0), samples: numericParameter(0x80a9), depthBits: numericParameter(0x0d56), stencilBits: numericParameter(0x0d57) };
    // These reads are not commands. They ensure texture metadata reflects the
    // owned context's initial unpack state, rather than assuming defaults.
    if (typeof this.context.getParameter === 'function') for (const name of Object.keys(this.unpack)) {
      const value = this.context.getParameter(Number(name));
      if (typeof value === 'number' || typeof value === 'boolean') this.unpack[name] = value;
    }
    try {
      this.installMethods(this.context, '');
      for (const property of ['drawingBufferColorSpace', 'unpackColorSpace']) this.installProperty(property);
    } catch (error) { this.dispose(); throw error; }
  }

  get lastSequence(): number { return this.sequence; }

  beginFrame(label = ''): number {
    this.ensureHealthy();
    if (this.activeFrame) throw new Error('A recorded frame is already open.');
    const id = ++this.frameSequence;
    this.activeFrame = { id, label, firstSequence: this.sequence + 1, width: Number(this.context.drawingBufferWidth ?? 0), height: Number(this.context.drawingBufferHeight ?? 0) };
    return id;
  }

  endFrame(): RecordedGLFrame {
    this.ensureHealthy();
    if (!this.activeFrame) throw new Error('No recorded frame is open.');
    const frame = this.activeFrame;
    if (frame.width !== Number(this.context.drawingBufferWidth ?? 0) || frame.height !== Number(this.context.drawingBufferHeight ?? 0)) this.fail('The drawing buffer resized inside a frame; split the capture at the resize boundary.');
    const record = Object.freeze({ id: frame.id, label: frame.label, firstSequence: frame.firstSequence, lastSequence: this.sequence, drawingBufferWidth: frame.width, drawingBufferHeight: frame.height });
    this.frames.push(record); this.activeFrame = null; return record;
  }

  /** Await asynchronous blob persistence before exporting JSON and its separate raw blobs. */
  async exportRecording(): Promise<{ recording: WebGL2Recording; blobs: readonly { id: string; blob: Blob }[] }> {
    if (this.activeFrame) throw new Error('End the frame before exporting its commands.');
    while (this.pendingBlobs.size) await Promise.all([...this.pendingBlobs]);
    if (this.failure) throw this.failure;
    const recording: WebGL2Recording = deepFreeze({ version: 1, commands: [...this.commands], resources: this.resourceStates.map(state => ({ ...state.reference, createdAt: state.createdAt, ...(state.deletedAt === undefined ? {} : { deletedAt: state.deletedAt }), ...(state.program === undefined ? {} : { program: state.program, name: state.name, linkGeneration: state.linkGeneration }) })), blobs: [...this.blobRecords.values()].map(record => cloneJSON(record)), frames: [...this.frames], contextAttributes: this.contextAttributes === null ? null : cloneJSON(this.contextAttributes), initialDrawingBuffer: { ...this.initialDrawingBuffer } });
    return { recording, blobs: [...this.retainedBlobs].map(([id, blob]) => Object.freeze({ id, blob })) };
  }

  /** Only restores properties installed on this context and its returned extensions. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeFrame && !this.failure) this.failure = new Error('Recorder disposed with an incomplete frame.');
    for (const entry of [...this.restored].reverse()) {
      const current = Object.getOwnPropertyDescriptor(entry.target, entry.name);
      const stillOwned = current?.value === entry.installed.value && current?.get === entry.installed.get && current?.set === entry.installed.set;
      if (!stillOwned) continue; // Never overwrite another owner's subsequent wrapper.
      if (entry.original) {
        // An own writable data property is temporarily represented by an
        // accessor. Restore its latest value, not its pre-capture value.
        const descriptor = 'value' in entry.original && entry.installed.get ? { ...entry.original, value: current?.get?.call(entry.target) } : entry.original;
        Object.defineProperty(entry.target, entry.name, descriptor);
      }
      else Reflect.deleteProperty(entry.target, entry.name);
    }
  }

  private installMethods(target: GLContextLike, extension: string): void {
    for (const name of methodNames(target)) {
      if ((!extension && READONLY.has(name)) || (extension && EXT_READONLY.has(name))) continue;
      const original = target[name] as AnyFunction, recorder = this;
      const wrapper = function(this: unknown, ...args: unknown[]) {
        if (this !== target || recorder.disposed) return original.apply(this, args);
        if (!extension && name === 'getExtension') {
          const result = original.apply(target, args);
          if (result && typeof result === 'object' && !recorder.wrappedExtensions.has(result)) {
            recorder.wrappedExtensions.add(result); recorder.installMethods(result, String(args[0]));
          }
          return result;
        }
        // CPU readback queries have no GPU-state replay effect. PBO readPixels
        // does write GPU buffer storage and therefore must remain a command.
        if (!extension && name === 'readPixels' && (!recorder.pixelPackBuffer || typeof args[6] !== 'number')) return original.apply(target, args);
        const supported = extension ? EXT_COMMANDS.has(name) : CORE_COMMANDS.has(name) || LOOKUPS.has(name) || name === 'readPixels';
        if (!supported) recorder.fail(`Unsupported mutating WebGL operation: ${extension ? extension + '.' : ''}${name}`);
        return recorder.invoke(target, original, name, extension, args);
      };
      this.install(target, name, { value: wrapper, writable: true, configurable: true });
    }
  }

  private installProperty(name: string): void {
    const descriptor = descriptorInChain(this.context, name);
    if (!descriptor || (!descriptor.set && descriptor.writable === false)) return;
    let value = descriptor.value;
    const recorder = this;
    const get = () => descriptor.get ? descriptor.get.call(recorder.context) : value;
    const set = (next: unknown) => {
      if (recorder.disposed) { if (descriptor.set) descriptor.set.call(recorder.context, next); else value = next; return; }
      recorder.ensureHealthy();
      if (recorder.capturing) recorder.fail('Capture callbacks must not mutate the recorded WebGL context.');
      const encoded = recorder.encode(next, `$set.${name}`, 1);
      if (descriptor.set) descriptor.set.call(recorder.context, next); else value = next;
      recorder.commands.push(deepFreeze({ seq: ++recorder.sequence, frame: recorder.activeFrame?.id ?? null, op: '$set', args: [name, encoded] }));
    };
    this.install(this.context, name, { get, set, configurable: true, enumerable: descriptor.enumerable ?? true });
  }

  private install(target: object, name: string, descriptor: PropertyDescriptor): void {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, descriptor); this.restored.push({ target, name, original, installed: descriptor });
  }

  private invoke(target: GLContextLike, original: AnyFunction, name: string, extension: string, args: unknown[]): unknown {
    this.ensureHealthy();
    if (this.capturing) this.fail('Capture callbacks must not mutate the recorded WebGL context.');
    const op = extension ? `${extension}.${name}` : name;
    let encoded: RecordedValue[], textureUpload: Record<string, RecordedValue> | undefined;
    this.capturing = true;
    try {
      const texture = !extension && ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D'].includes(name) ? this.textureUpload(name, args) : null;
      encoded = args.map((argument, index) => texture?.pixelIndex === index ? texture.pixels : this.encode(argument, op, index));
      if (texture) textureUpload = { ...texture.description, pixels: texture.pixels };
    } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); throw error; }
    finally { this.capturing = false; }
    let result: unknown;
    try { result = original.apply(target, args); }
    catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); throw error; }
    const seq = ++this.sequence;
    let encodedResult: RecordedValue | undefined;
    if (CREATE[name]) encodedResult = result === null ? null : this.register(result, CREATE[name], seq).reference as unknown as RecordedValue;
    else if (name === 'getUniformLocation') {
      if (result === null) encodedResult = null;
      else {
        const program = this.resource(args[0]);
        const state = this.register(result, 'UniformLocation', seq);
        state.program = program.reference.id; state.name = String(args[1]); state.linkGeneration = this.programLinks.get(program.reference.id) ?? 0;
        encodedResult = state.reference as unknown as RecordedValue;
      }
    } else if (name === 'getAttribLocation' || name === 'getUniformBlockIndex') encodedResult = this.encode(result, op, -1);
    if (name === 'linkProgram') { const id = this.resource(args[0]).reference.id; this.programLinks.set(id, (this.programLinks.get(id) ?? 0) + 1); }
    if (name.startsWith('delete') && args[0] !== null) this.resource(args[0]).deletedAt ??= seq;
    if (name === 'pixelStorei') this.unpack[String(args[0])] = encoded[1];
    if (name === 'bindBuffer' && args[0] === 0x88eb) this.pixelPackBuffer = args[1];
    this.commands.push(deepFreeze({ seq, frame: this.activeFrame?.id ?? null, op, args: encoded, ...(encodedResult === undefined ? {} : { result: encodedResult }), ...(textureUpload ? { textureUpload } : {}) }));
    return result;
  }

  private register(object: unknown, kind: GLObjectKind, sequence: number): ResourceState {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) this.fail(`Native ${kind} creation did not return an object or null.`);
    const existing = this.objects.get(object as object);
    if (existing) { if (existing.reference.object !== kind) this.fail('Native resource object changed kind.'); return existing; }
    const state: ResourceState = { reference: Object.freeze({ object: kind, id: this.resourceStates.length + 1 }), createdAt: sequence };
    this.objects.set(object as object, state); this.resourceStates.push(state); return state;
  }

  private resource(object: unknown): ResourceState {
    const result = object && (typeof object === 'object' || typeof object === 'function') ? this.objects.get(object as object) : undefined;
    if (!result) this.fail('Unregistered GL object: install the recorder before resource creation, on this context only.');
    return result;
  }

  private binary(blob: Blob, type: string, op: string, argument: number): BinaryReference {
    const id = `b${++this.blobSequence}`, info = Object.freeze({ id, byteLength: blob.size, op, argument });
    this.blobRecords.set(id, Object.freeze({ id, byteLength: blob.size }));
    if (this.options.captureBlob) {
      let result: ExternalBlobReference | Promise<ExternalBlobReference>;
      try { result = this.options.captureBlob(blob, info); } catch (error) { this.fail(`Blob capture failed: ${String(error)}`); }
      this.persistReference(result, id, blob.size);
    } else this.retainedBlobs.set(id, blob);
    return Object.freeze({ blob: id, type, byteLength: blob.size });
  }

  private persistReference(result: ExternalBlobReference | Promise<ExternalBlobReference>, id: string, byteLength: number): void {
    const save = (reference: ExternalBlobReference) => {
      if (!reference || typeof reference.file !== 'string' || !reference.file || (reference.byteOffset !== undefined && (!Number.isSafeInteger(reference.byteOffset) || reference.byteOffset < 0))) throw new Error(`Invalid immutable blob file reference: ${id}`);
      this.blobRecords.set(id, deepFreeze({ id, byteLength, reference: cloneJSON(reference) }));
    };
    if (result && typeof (result as Promise<ExternalBlobReference>).then === 'function') {
      const promise = Promise.resolve(result).then(save).catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); }).finally(() => this.pendingBlobs.delete(promise));
      this.pendingBlobs.add(promise);
    } else save(result as ExternalBlobReference);
  }

  private immutableBinary(source: ArrayBuffer | ArrayBufferView, type: string, op: string, argument: number): BinaryReference | null {
    if (!this.options.captureImmutableBuffer) return null;
    const id = `b${this.blobSequence + 1}`, byteLength = source.byteLength;
    const result = this.options.captureImmutableBuffer(source, Object.freeze({ id, byteLength, type, op, argument }));
    if (result === undefined) return null;
    this.blobSequence++;
    this.blobRecords.set(id, Object.freeze({ id, byteLength }));
    this.persistReference(result, id, byteLength);
    return Object.freeze({ blob: id, type, byteLength });
  }

  private encode(value: unknown, op: string, argument: number): RecordedValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (Object.is(value, -0)) return { number: '-0' };
      return Number.isFinite(value) ? value : { number: String(value) };
    }
    if (value === undefined) return { undefined: true };
    if (ArrayBuffer.isView(value)) {
      if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) this.fail('Concurrent SharedArrayBuffer uploads cannot be captured atomically.');
      const external = this.immutableBinary(value, value.constructor.name, op, argument);
      if (external) return external as unknown as RecordedValue;
      const bytes = new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
      return this.binary(new Blob([bytes]), value.constructor.name, op, argument) as unknown as RecordedValue;
    }
    if (value instanceof ArrayBuffer) return (this.immutableBinary(value, 'ArrayBuffer', op, argument) ?? this.binary(new Blob([value]), 'ArrayBuffer', op, argument)) as unknown as RecordedValue;
    if (Array.isArray(value)) return value.map(item => this.encode(item, op, argument));
    if (typeof value === 'object' || typeof value === 'function') return this.resource(value).reference as unknown as RecordedValue;
    this.fail(`Unsupported WebGL argument type ${typeof value} at ${op}[${argument}].`);
  }

  private textureUpload(op: string, args: unknown[]): { pixelIndex: number; pixels: RecordedValue; description: Record<string, RecordedValue> } {
    let pixelIndex: number, description: Record<string, RecordedValue>;
    const n = (index: number) => this.encode(args[index], op, index);
    const source2D = (op === 'texImage2D' && args.length === 6) || (op === 'texSubImage2D' && args.length === 7);
    if (op === 'texImage2D') {
      pixelIndex = source2D ? 5 : 8;
      description = { target: n(0), level: n(1), internalformat: n(2), width: source2D ? 0 : n(3), height: source2D ? 0 : n(4), depth: 1, border: source2D ? 0 : n(5), format: n(source2D ? 3 : 6), type: n(source2D ? 4 : 7) };
    } else if (op === 'texSubImage2D') {
      pixelIndex = source2D ? 6 : 8;
      description = { target: n(0), level: n(1), xoffset: n(2), yoffset: n(3), width: source2D ? 0 : n(4), height: source2D ? 0 : n(5), depth: 1, format: n(source2D ? 4 : 6), type: n(source2D ? 5 : 7) };
    } else if (op === 'texImage3D') {
      pixelIndex = 9; description = { target: n(0), level: n(1), internalformat: n(2), width: n(3), height: n(4), depth: n(5), border: n(6), format: n(7), type: n(8) };
    } else {
      pixelIndex = 10; description = { target: n(0), level: n(1), xoffset: n(2), yoffset: n(3), zoffset: n(4), width: n(5), height: n(6), depth: n(7), format: n(8), type: n(9) };
    }
    const value = args[pixelIndex];
    description.sourceElementOffset = args.length > pixelIndex + 1 ? n(pixelIndex + 1) : 0;
    description.unpack = { ...this.unpack, unpackColorSpace: String(this.context.unpackColorSpace ?? 'srgb') };
    if (value === null || typeof value === 'number' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      description.sourceKind = value === null ? 'null-allocation' : typeof value === 'number' ? 'pixel-unpack-buffer-offset' : 'binary';
      return { pixelIndex, description, pixels: this.encode(value, op, pixelIndex) };
    }
    const sourceKind = value && typeof value === 'object' ? value.constructor.name : typeof value;
    let image: CapturedTextureImage;
    // ImageData has a directly available canonical byte array. Other DOM sources
    // require an explicit provider to avoid implicit color/alpha conversions.
    if (sourceKind === 'ImageData' && (value as ImageData).data instanceof Uint8ClampedArray) {
      const data = value as ImageData;
      image = { bytes: new Blob([new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength)]), encoding: 'rgba8', width: data.width, height: data.height, rowOrigin: 'top-left', premultipliedAlpha: false, colorSpace: data.colorSpace ?? 'srgb' };
    } else {
      if (!this.options.captureImage) this.fail(`Texture source ${sourceKind} needs captureImage with exact bytes and image-creation metadata.`);
      image = this.options.captureImage(value, Object.freeze({ op, sourceKind, unpack: Object.freeze({ ...this.unpack, unpackColorSpace: String(this.context.unpackColorSpace ?? 'srgb') }) }));
    }
    if (!(image.bytes instanceof Blob) || !Number.isInteger(image.width) || image.width <= 0 || !Number.isInteger(image.height) || image.height <= 0) this.fail('Invalid captured texture image.');
    if (image.encoding === 'rgba8' && image.bytes.size !== image.width * image.height * 4) this.fail('RGBA8 image snapshot has an inconsistent byte length.');
    const binary = this.binary(image.bytes, image.encoding, op, pixelIndex);
    const pixels: RecordedValue = { image: { ...binary, encoding: image.encoding, width: image.width, height: image.height, rowOrigin: image.rowOrigin, premultipliedAlpha: image.premultipliedAlpha, colorSpace: image.colorSpace, sourceKind, sourceCreation: image.sourceCreation ? cloneJSON(image.sourceCreation) : null } };
    description.sourceKind = sourceKind;
    if (source2D) { description.width = image.width; description.height = image.height; }
    return { pixelIndex, pixels, description };
  }

  private ensureHealthy(): void { if (this.disposed) throw new Error('WebGL recorder is disposed.'); if (this.failure) throw this.failure; }
  private fail(message: string): never { const error = new Error(message); this.failure ??= error; throw error; }
}
