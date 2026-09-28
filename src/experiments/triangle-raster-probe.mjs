import * as THREE from 'three';
import { Renderer } from '../core/Renderer.ts';
import { Atmosphere } from '../systems/Atmosphere.ts';
import { OriginalTriangleAtlas, VisibleTriangleRasterAdapter } from './VisibleTriangleRasterAdapter.ts';
import { loadTriangleRasterDataset } from './loadTriangleRasterDataset.mjs';
import { buildRasterDrawGroups } from './rasterDrawGroups.mjs';
import { FourBiomeWorld } from '../world/FourBiomeWorld.ts';

const progress = text => console.log(`RASTER ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.now();

/** Actual beauty-cost feasibility only. Shadows are explicitly disabled; never a delivery renderer. */
export class TriangleRasterProbe {
  static async create({ datasetURL = '/acceleration/visibility-world', pairURL = '/artifacts/four-horizons/target-30fps/native-dxr-world', width = 1440, height = 900 } = {}) {
    const probe = new TriangleRasterProbe();
    probe.started = now(); probe.pairURL = pairURL; probe.adapters = []; probe.shaderSources = []; probe.shaderErrors = [];
    probe.setupTimes = {};
    const loaded = now();
    probe.dataset = await loadTriangleRasterDataset(datasetURL, { onProgress: file => progress(`LOAD ${file}`) });
    probe.setupTimes.loadDatasetMs = now() - loaded;
    progress(`DATASET placements=${probe.dataset.manifest.placements} uniqueTriangles=${probe.dataset.input.triangles.length / 3}`);
    const packing = now(); probe.atlas = new OriginalTriangleAtlas(probe.dataset.input); probe.setupTimes.packAtlasMs = now() - packing;
    progress(`ATLAS floatPages=${probe.atlas.floatTextures.map(t => t.image.data.byteLength).join(',')} integerBytes=${probe.atlas.integerTexture.image.data.byteLength}`);
    // Capture the exact GL sources after Three include/define/unroll expansion, before compilation.
    const nativeShaderSource = WebGL2RenderingContext.prototype.shaderSource;
    probe.restoreShaderSource = () => { WebGL2RenderingContext.prototype.shaderSource = nativeShaderSource; };
    WebGL2RenderingContext.prototype.shaderSource = function(shader, source) {
      probe.shaderSources.push({ type: this.getShaderParameter(shader, this.SHADER_TYPE) === this.VERTEX_SHADER ? 'vertex' : 'fragment', source });
      return nativeShaderSource.call(this, shader, source);
    };
    probe.rendering = new Renderer(document.querySelector('#probe'));
    probe.renderer = probe.rendering.renderer; probe.scene = probe.rendering.scene; probe.camera = probe.rendering.camera;
    probe.renderer.setPixelRatio(1); probe.renderer.setSize(width, height);
    probe.gl = probe.renderer.getContext();
    probe.renderer.debug.onShaderError = (gl, program, vertex, fragment) => probe.shaderErrors.push({ program: gl.getProgramInfoLog(program), vertex: gl.getShaderInfoLog(vertex), fragment: gl.getShaderInfoLog(fragment) });
    const gpuExt = probe.gl.getExtension('WEBGL_debug_renderer_info');
    probe.hardware = gpuExt ? probe.gl.getParameter(gpuExt.UNMASKED_RENDERER_WEBGL) : probe.gl.getParameter(probe.gl.RENDERER);
    probe.limits = { samples: probe.gl.getParameter(probe.gl.SAMPLES), maxTextureSize: probe.gl.getParameter(probe.gl.MAX_TEXTURE_SIZE), maxVertexSamplers: probe.gl.getParameter(probe.gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), width: probe.gl.drawingBufferWidth, height: probe.gl.drawingBufferHeight };
    if (!/NVIDIA.*RTX 3080/i.test(probe.hardware)) throw new Error(`Unexpected GPU: ${probe.hardware}`);
    if (probe.limits.samples !== 4 || probe.limits.width !== width || probe.limits.height !== height) throw new Error(`Expected native 4xMSAA ${width}x${height}: ${JSON.stringify(probe.limits)}`);
    if (probe.limits.maxTextureSize < 16384 || probe.limits.maxVertexSamplers < 5) throw new Error('Insufficient lossless atlas limits');
    probe.timer = probe.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!probe.timer) throw new Error('GPU timer query extension unavailable');
    const world = await (await fetch('/environments/world-manifest.json')).json(), view = world.biomes[0].review;
    const evidence = await (await fetch(`${pairURL}/input-evidence.json`)).json();
    probe.camera.position.fromArray(view.camera); probe.camera.lookAt(new THREE.Vector3().fromArray(view.target));
    probe.camera.fov = 48; probe.camera.aspect = width / height; probe.camera.near = .15; probe.camera.far = 16000;
    probe.camera.updateProjectionMatrix(); probe.camera.updateMatrixWorld(true);
    if (view.camera.some((x, i) => x !== evidence.camera.origin[i]) || evidence.width !== width || evidence.height !== height) throw new Error('Native visibility camera/dimensions do not match raster');
    probe.cameraEvidence = { camera: view.camera, target: view.target, fov: 48, near: .15, far: 16000, nativeInput: evidence };
    probe.atmosphere = new Atmosphere(probe.scene, probe.renderer, probe.camera);
    probe.atmosphere.update(0, new THREE.Vector3().fromArray(view.aircraft), 120, false);
    probe.atmosphere.sunlight.update();
    // Explicit measurement exclusion: preserve the PBR lights/CSM hooks but do not render shadows.
    probe.renderer.shadowMap.enabled = false;
    for (const material of probe.dataset.materials) if (material.normalMap) {
      material.normalMap.anisotropy = probe.renderer.capabilities.getMaxAnisotropy(); material.normalMap.needsUpdate = true;
    }
    probe.atlas.prepareView(probe.camera);
    probe.scene.updateMatrixWorld(true);
    probe.createGroupIndex();
    progress(`READY hardware=${probe.hardware} samples=${probe.limits.samples} groups=${probe.groups.length}`);
    return probe;
  }

  createGroupIndex() {
    const { batches, input, materials } = this.dataset;
    Object.assign(this, buildRasterDrawGroups(batches, input.geometries, materials, input.instances.length));
  }

  /** Independent canonical oracle: the production GLB loader/batcher, not reconstructed atlas meshes. */
  async loadCanonicalWorld() {
    if (this.canonicalWorld) return this.canonicalWorld.diagnostics;
    const start = now();
    this.canonicalWorld = await FourBiomeWorld.load(message => progress(`CANONICAL ${message}`));
    this.canonicalWorld.root.visible = false;
    const materials = new Set();
    this.canonicalWorld.root.traverse(object => {
      if (object.isMesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    this.canonicalMaterials = materials;
    for (const material of materials) {
      if (material.normalMap) { material.normalMap.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); material.normalMap.needsUpdate = true; }
      this.atmosphere.sunlight.setupMaterial(material);
    }
    this.scene.add(this.canonicalWorld.root); this.scene.updateMatrixWorld(true);
    this.canonicalLoadMs = now() - start;
    progress(`CANONICAL_READY ${JSON.stringify(this.canonicalWorld.diagnostics)}`);
    return { ...this.canonicalWorld.diagnostics, loadAndConfigureMs: this.canonicalLoadMs, materials: materials.size };
  }

  setMode(mode = 'selected') {
    if (!['selected', 'canonical'].includes(mode)) throw new Error('Unknown comparison mode');
    if (mode === 'canonical' && !this.canonicalWorld) throw new Error('Canonical source must be loaded first');
    if (this.canonicalWorld) this.canonicalWorld.root.visible = mode === 'canonical';
    for (const adapter of this.adapters) adapter.mesh.visible = mode === 'selected';
    this.mode = mode;
  }

  async setBlock(blockSize) {
    for (const adapter of this.adapters) adapter.dispose(); this.adapters.length = 0;
    const fetchStarted = now();
    const [pairs, offsets] = await Promise.all(['pairs', 'offsets'].map(async name => {
      const response = await fetch(`${this.pairURL}/blocks-${blockSize}-${name}.bin`);
      if (!response.ok) throw new Error(`Missing native ${name}`); return new Uint32Array(await response.arrayBuffer());
    }));
    const fetchMs = now() - fetchStarted, groupStarted = now();
    const signatureOffsets = offsets.length === this.groups.length + 1;
    if ((!signatureOffsets && offsets.length !== this.dataset.materials.length + 1) || offsets.at(-1) * 2 !== pairs.length) throw new Error('Native draw/material offsets do not cover pair buffer');
    const counts = new Uint32Array(this.groups.length), cursors = new Uint32Array(this.groups.length);
    for (let material = 0; material < offsets.length - 1; material++) for (let p = offsets[material]; p < offsets[material + 1]; p++) {
      const instance = pairs[p * 2], group = this.instanceGroup[instance];
      if (!this.groups[group] || (signatureOffsets ? group : this.groups[group].materialId) !== material) throw new Error('Native material/draw partition changed');
      counts[group]++;
    }
    const lists = [...counts].map(count => new Uint32Array(count * 2));
    for (let p = 0; p < pairs.length; p += 2) {
      const group = this.instanceGroup[pairs[p]], at = cursors[group] * 2;
      lists[group][at] = pairs[p]; lists[group][at + 1] = pairs[p + 1]; cursors[group]++;
    }
    let actualTriangles = 0;
    for (let i = 0; i < this.groups.length; i++) {
      if (!counts[i]) continue;
      const settings = this.groups[i], source = this.dataset.materials[settings.materialId];
      const adapter = new VisibleTriangleRasterAdapter(this.atlas, source, { ...settings, capacity: counts[i], trianglesPerReference: blockSize,
        customHooksCompatible: true, configureClone: clone => { this.atmosphere.sunlight.setupMaterial(clone); return () => this.atmosphere.sunlight.shaders.delete(clone); } });
      adapter.setVisibleReferences(lists[i]); this.scene.add(adapter.mesh); this.adapters.push(adapter);
      for (let p = 0; p < lists[i].length; p += 2) {
        const geometry = this.dataset.input.geometries[this.dataset.input.instances[lists[i][p]].geometry];
        actualTriangles += Math.min(blockSize, geometry.triangleOffset + geometry.triangleCount - lists[i][p + 1]);
      }
    }
    this.blockSize = blockSize;
    this.currentSetup = { blockSize, pairs: pairs.length / 2, pairBytes: pairs.byteLength, materialGroups: this.adapters.length, originalTriangles: actualTriangles, submittedTrianglesIncludingPadding: pairs.length / 2 * blockSize, fetchMs, groupingAndValidationMs: now() - groupStarted };
    progress(`BLOCK ${JSON.stringify(this.currentSetup)}`);
    return this.currentSetup;
  }

  async frame() {
    const prepared = now(); this.camera.updateMatrixWorld(true); this.atlas.prepareView(this.camera); this.scene.updateMatrixWorld();
    const preparationMs = now() - prepared;
    const gl = this.gl, ext = this.timer, query = gl.createQuery(); this.renderer.info.reset();
    const start = now(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.renderer.render(this.scene, this.camera);
    gl.endQuery(ext.TIME_ELAPSED_EXT); const submissionMs = now() - start;
    // Chrome's command-buffer gl.finish return is not proof of GPU completion. The timer-query
    // availability below is the actual completion evidence; report both distinct wall intervals.
    gl.finish(); const finishReturnMs = now() - start;
    const timeout = now() + 15000;
    while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && now() < timeout) await sleep(2);
    const valid = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT);
    const gpuMs = valid ? gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 : null; gl.deleteQuery(query);
    const error = gl.getError();
    const result = { preparationMs, submissionMs, finishReturnMs, queryCompletionWallMs: now() - start, gpuMs, gpuValid: !!valid, glError: error, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, programs: this.renderer.info.programs.length, shaderErrors: this.shaderErrors.length };
    if (error || this.shaderErrors.length || !valid) throw new Error(`Raster draw failed: ${JSON.stringify(result)} ${JSON.stringify(this.shaderErrors)}`);
    return result;
  }

  capture() {
    const gl = this.gl, width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    this.atlas.prepareView(this.camera); this.renderer.render(this.scene, this.camera); gl.finish();
    const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const flipped = new Uint8ClampedArray(pixels.length);
    for (let row = 0; row < height; row++) flipped.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(flipped, width, height), 0, 0);
    return { png: canvas.toDataURL('image/png'), glError: gl.getError() };
  }

  exportShaders() {
    const unique = new Map();
    for (const shader of this.shaderSources) unique.set(shader.type + shader.source, shader);
    return [...unique.values()].map((shader, index) => ({ index, ...shader, pulled: shader.source.includes('exactLoadOriginalVertex'), length: shader.source.length }));
  }

  summary() {
    return { hardware: this.hardware, limits: this.limits, setupTimes: this.setupTimes, totalSetupMs: now() - this.started,
      camera: this.cameraEvidence, source: { weightedTriangles: this.dataset.manifest.weightedTriangles, placements: this.dataset.manifest.placements,
        uniqueGeometries: this.dataset.manifest.uniqueGeometries, uniqueTriangles: this.dataset.input.triangles.length / 3, uniqueBatches: this.dataset.input.batches.length },
      textureBytes: { floats: this.atlas.floatTextures.map(t => t.image.data.byteLength), integer: this.atlas.integerTexture.image.data.byteLength, batches: this.atlas.batchTexture.image.data.byteLength },
      exclusion: 'Beauty-cost feasibility only: shadows explicitly disabled; visibility, dedup, bridge, aircraft and UI excluded from timed draws. No appearance or delivered-FPS claim.' };
  }

  dispose() {
    for (const adapter of this.adapters) adapter.dispose(); this.adapters.length = 0;
    this.atlas.dispose();
    if (this.canonicalWorld) {
      for (const material of this.canonicalMaterials) this.atmosphere.sunlight.shaders.delete(material);
      this.canonicalWorld.root.removeFromParent(); this.canonicalWorld.dispose(); this.canonicalMaterials.clear();
    }
    this.atmosphere.dispose(); this.dataset.disposeMaterials(); this.rendering.dispose(); this.restoreShaderSource();
    this.dataset = null;
  }
}
