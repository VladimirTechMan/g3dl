/**
 * WebGPURenderer — facade for all GPU state and operations.
 *
 * This class is the central hub of the GPU subsystem. It owns the WebGPU device,
 * canvas context, buffers, pipelines, bind groups, and camera state. To keep the
 * file manageable, most implementation is delegated to focused submodules:
 *
 *   renderer/lifecycle.js  – init, resize, destroy, device-lost recovery
 *   renderer/render.js     – per-frame render pass encoding
 *   renderer/step.js       – simulation step dispatch + grid randomization
 *   renderer/aabb.js       – living-cell bounding-box readback (Screen show)
 *   pipelines/compute.js   – compute pipeline factories (simulation, extract, init, AABB)
 *   pipelines/render.js    – render pipeline factories (cells, grid projection, background)
 *   resources/grid.js      – grid buffer allocation and sizing
 *   resources/geometry.js  – cube geometry + grid projection instances
 *   resources/frameUniforms.js – uniform buffer allocation + per-frame writes
 *   resources/bindGroups.js – bind group (re)creation
 *   readback.js            – async GPU→CPU readback ring for population stats
 *   dataLayout.js          – JS↔WGSL buffer layout contract with static assertions
 *   cameraControls.js      – orbit camera math (rotate, pan, zoom, inertia)
 *
 * These submodules receive the renderer instance (`r`) and mutate it directly.
 * The renderer is therefore more of a "bag of GPU state" than a deeply
 * encapsulated object — the encapsulation boundary is the module folder, not the
 * class itself.
 */

import { G3DL_LAYOUT } from "./dataLayout.js";
import { MAX_PACKED_GRID_SIZE } from "./constants.js";
import {
  createSimulationPipeline as createSimulationPipelineImpl,
  createExtractPipeline as createExtractPipelineImpl,
  createInitPipeline as createInitPipelineImpl,
  createDrawArgsPipeline as createDrawArgsPipelineImpl,
  createAabbPipelines as createAabbPipelinesImpl,
} from "./pipelines/compute.js";
import {
  createCellsRenderPipeline,
  createGridProjectionPipeline as createGridProjectionPipelineImpl,
  createBackgroundPipeline as createBackgroundPipelineImpl,
} from "./pipelines/render.js";
import {
  createCubeGeometry as createCubeGeometryImpl,
  rebuildGridProjectionInstances as rebuildGridProjectionInstancesImpl,
} from "./resources/geometry.js";
import {
  createGridBuffers as createGridBuffersImpl,
  destroyGridResources as destroyGridResourcesImpl,
} from "./resources/grid.js";
import {
  shouldReadbackStats as shouldReadbackStatsImpl,
  acquireReadbackSlot as acquireReadbackSlotImpl,
  startReadback as startReadbackImpl,
  requestPopulationReadback as requestPopulationReadbackImpl,
} from "./readback.js";
import { rebuildBindGroups as rebuildBindGroupsImpl } from "./resources/bindGroups.js";
import { BufferManager } from "./util/bufferManager.js";
import { initRenderer, resizeRenderer, destroyRenderer } from "./renderer/lifecycle.js";
import { renderFrame as renderFrameImpl } from "./renderer/render.js";
import {
  stepSimulation as stepSimulationImpl,
  randomizeGrid as randomizeGridImpl,
} from "./renderer/step.js";
import { requestLivingCellsAABB as requestLivingCellsAABBImpl } from "./renderer/aabb.js";
import {
  ensureCameraScratch,
  syncCameraMatrix,
  setQuatFromEuler,
  rotate as rotateImpl,
  pan as panImpl,
  updateInertia as updateInertiaImpl,
  stopInertia as stopInertiaImpl,
  zoomCamera as zoomCameraImpl,
  resetPan as resetPanImpl,
  resetView as resetViewImpl,
  setCameraOverride as setCameraOverrideImpl,
  clearCameraOverride as clearCameraOverrideImpl,
  commitCameraOverrideToUser as commitCameraOverrideToUserImpl,
} from "./cameraControls.js";

import { warn } from "../util/log.js";
import { LOG_MSG } from "../util/messages.js";
import { parseHex6 } from "../util/color.js";

/**
 * Try to parse a CSS hex color ("#rrggbb" or "rrggbb") into 0..1 sRGB floats.
 *
 * @param {unknown} hex
 * @returns {null | [number, number, number]}
 */
function tryParseHexColor01(hex) {
  const s = parseHex6(hex);
  if (!s) return null;
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? [r, g, b] : null;
}


/**
 * Game of 3D Life - WebGPU Renderer
 * Cube rendering with packed cell data (4x memory reduction)
 */

export class WebGPURenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = null;
    this.context = null;
    this.format = null;

    this.gridSize = 96;
    this.cellSize = 1.0;

    this.gridBuffers = [null, null];
    this.currentBuffer = 0;
    this.livingCellsBuffer = null;
    this.atomicCounterBuffer = null;

    // Lightweight population-only readback (independent of throttled stats ring).
    // Used to keep UI and Screen show heuristics reasonably fresh in fast-play modes without stalling steps.
    this.populationReadbackBuffers = null;
    this.populationReadbackPending = false;
    this.populationReadbackPromise = null;
    this.populationReadbackSlot = 0;
    this.populationReadbackLastTimeMs = 0;
    this.populationReadbackMinIntervalMs = 250; // cap readbacks to avoid UI/GPU stalls
    this.populationValidGeneration = -1;

    // Change detection counter
    this.changeCounterBuffer = null;

    // Optional live-cell AABB readback (used by Screen show camera targeting)
    this.aabbPipeline = null;
    this.aabbArgsPipeline = null;
    this.aabbDispatchArgsBuffer = null;
    this.aabbArgsBindGroup = null;
    this.aabbBuffer = null;
    this.aabbBindGroup = null;
    this.aabbStagingBuffers = null;
    this.aabbReadbackPending = false;
    this.aabbReadbackPromise = null;
    this.aabbReadbackSlot = 0;
    this.lastAabb = null;

    // Chosen at init() based on device limits; used by the AABB reduction shader.
    // Must be a power of two because the reduction uses a stride-halving pattern.
    this.aabbWorkgroupSize = 256;

    // Indirect draw args (GPU-driven instance count) + associated pipeline/resources
    this.indirectArgsBuffer = null;
    this.drawArgsParamsBuffer = null;
    this.drawArgsPipeline = null;
    this.drawArgsBindGroup = null;

    // Cached bind groups (avoid per-frame/per-step allocations)
    this.bgBindGroup = null;
    this.cellBindGroup = null;
    this.computeBindGroups = [null, null];
    this.extractBindGroups = [null, null];

    // GPU-side random initialization (avoids CPU-side full grid uploads)
    this.initPipeline = null;
    this.initBindGroups = [null, null];
    this.initParamsBuffer = null;

    // Stats readback pacing and ring buffers
    this.statsStagingBuffers = null;
    this.changeStagingBuffers = null;
    this.readbackPending = null;
    this.readbackPromises = null;
    this.nextReadbackSlot = 0;
    this.statsValidGeneration = 0;
    this.lastReadbackTimeMs = 0;
    this.lastReadbackGeneration = 0;
    this.readbackEveryNSteps = 4; // Prefer stats refresh every N steps
    this.readbackMinIntervalMs = 200; // ...or at least every X ms

    // Optional pacing to prevent unbounded GPU queue growth in "fast" play mode.
    // If we submit steps much faster than the GPU can execute them, latency spikes and
    // some mobile browsers may lose the device under memory pressure.
    this._paceEveryNSteps = 2;
    this._paceMinIntervalMs = 50;
    this._stepsSincePace = 0;
    this._lastPaceTimeMs = 0;

    // Device lost notifications
    this.deviceLost = false;
    this.onDeviceLost = null;

    // Renderer lifetime flag for SPA-style mounts/unmounts.
    // The app currently initializes exactly once, but destroy() makes it safe to
    // embed into larger applications without accumulating GPU resources or listeners.
    this.isDestroyed = false;
    // Used by async readback helpers to suppress teardown-time warnings.
    this._suppressAsyncErrors = false;

    // Centralized buffer creation + CPU→GPU writes (scratch-backed, debug validated).
    this._buffers = new BufferManager();

    this.cubeVertexBuffer = null;
    this.cubeIndexBuffer = null;
    this.uniformBuffer = null;
    this.renderPipeline = null;
    this.computePipeline = null;
    this.extractPipeline = null;

    // Pipeline/shader compilation caching.
    // On some mobile browsers, synchronous pipeline creation can cause long main-thread stalls.
    // We prefer create*PipelineAsync() when available and cache shader modules by WGSL source.
    this._caps = {
      isCoarsePointer: false,
    };
    this._ensureEssentialPipelinesPromise = null;
    this._ensureAabbPipelinesPromise = null;

    // Quaternion-based camera for free rotation
    this.cameraQuat = [0, 0, 0, 1]; // x, y, z, w - identity quaternion
    this.cameraMatrix = new Float32Array(16);
    this.cameraDistance = 1.8;
    this.panX = 0;
    this.panY = 0;

    // Inertia for smooth camera movement
    this.rotationVelocityX = 0;
    this.rotationVelocityY = 0;
    this.panVelocityX = 0;
    this.panVelocityY = 0;
    this.inertiaDecay = 0.92; // How quickly velocity decays (0-1, higher = longer glide)
    this.minVelocity = 0.001; // Stop when velocity is below this

    this.surviveRule = 0b00110000; // default: S4-5 (Rule 4555)
    this.birthRule = 0b00100000; // default: B5 (Rule 4555)
    this.toroidal = false;
    this.enableChangeDetection = true;

    // Workgroup size tuning for the main grid-wide compute kernels (simulation, extraction, init).
    // This default is overwritten during init() based on device.limits to maximize portability across
    // desktop and mobile WebGPU implementations. Do not assume a fixed workgroup size.
    this.workgroupSize = { x: 8, y: 4, z: 4 };

    // Max grid size supported by per-buffer limits and conservative total-memory heuristics; populated in init().
    this.maxSupportedGridSize = 256;

    // Effective byte limit for allocating the ping-pong grid STORAGE buffers.
    // Populated in init() based on device.limits.maxStorageBufferBindingSize and device.limits.maxBufferSize.
    this.maxGridBufferBytes = 0;

    // Reused small typed arrays to reduce per-step GC.
    // compute params: [gridSize, surviveRule, birthRule, toroidal, changeEnabled, padding x3]
    this._computeParams = new Uint32Array(G3DL_LAYOUT.PARAMS.SIM.U32S);
    this._extractParams = new Uint32Array(G3DL_LAYOUT.PARAMS.EXTRACT.U32S);
    // init params: [gridSize, region, offset, threshold, seed, padding x3]
    this._initParams = new Uint32Array(G3DL_LAYOUT.PARAMS.INIT.U32S);
    this._u32_0 = new Uint32Array([0]);
    this._u32_1 = new Uint32Array([1]);

    // Scratch ArrayBuffer for small CPU->GPU writes (prevents per-call allocations).

    // Reused typed arrays to avoid per-frame allocations in render().
    this._bgUniforms = new Float32Array(G3DL_LAYOUT.BG_UNIFORMS.DATA_FLOATS);
    this._proj = new Float32Array(16);
    this._view = new Float32Array(16);
    this._renderUniforms = new Float32Array(G3DL_LAYOUT.UNIFORMS.DATA_FLOATS);
    this._eye = new Float32Array(3);
    this._target = new Float32Array(3);

    // Optional camera override (used by Screen show mode).
    // When enabled, frame uniform updates use these explicit vectors instead of the user-controlled trackball camera.
    this.cameraOverrideEnabled = false;
    this._overrideEye = new Float32Array(3);
    this._overrideTarget = new Float32Array(3);
    this._overrideUp = new Float32Array([0, 1, 0]);

    // Canvas configuration + resize tracking (for robust cross-browser behavior).
    this._canvasConfig = null;
    this._lastDpr = 0;
    this._lastCanvasW = 0;
    this._lastCanvasH = 0;
    this.population = 0;
    this.generation = 0;

    this.cellColorTop = [77 / 255, 255 / 255, 154 / 255]; // Top color - #4dff9a
    this.cellColorBottom = [0.29, 0.62, 1.0]; // Bottom color - #4a9eff
    this.bgColorTop = [31 / 255, 19 / 255, 57 / 255]; // Background top - #1f1339
    this.bgColorBottom = [10 / 255, 37 / 255, 66 / 255]; // Background bottom - #0a2542

    // Optional per-cell "lantern" emissive lighting (off by default)
    this.lanternEnabled = 0.0; // 0.0 or 1.0 (stored as float for uniform packing)
    this.lanternStrength = 0.55; // tuned for subtle glow

    // Optional haze (purely visual)
    // Stored as a maximum blend amount in [0..0.30]. 0 disables the effect.
    this.hazeStrength = 0.0;

    // Optional projected outline of the outer grid box (rendered as a subtle 'shadow' behind cells)
    this.gridProjectionEnabled = 1.0; // on by default; user can disable in Settings
    this.gridProjPipeline = null;
    this.gridProjBindGroup = null;
    this.gridProjInstanceBuffer = null;
    // Grid projection renders filled translucent "back" faces of the outer cube.
    // Depending on view direction, between 3 and 5 faces may qualify as "behind".
    this.gridProjMaxInstanceCount = 6;
    this.gridProjInstanceCount = 0;

    // Timebase used for the low-cost "candle" flicker animation in the lantern effect.
    // Stored as seconds since renderer creation.
    this._startTimeMs =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();

    // Optional pause marker for timebase freezing.
    // When the page is backgrounded we suspend rendering; without adjusting the
    // timebase, the next visible frame would "jump" forward by the hidden duration.
    // This marker is used by pauseTimebase()/resumeTimebase() to exclude hidden
    // time from the lantern animation.
    this._timePausedAtMs = null;

    // Set initial camera rotation.
    // Camera scratch must exist before any rotation operations (no per-frame allocations).
    ensureCameraScratch(this);
    setQuatFromEuler(this, 0.7, -0.5);
    syncCameraMatrix(this);
  }

  // ----------------------------
  // Timebase control (visibility/backgrounding)
  // ----------------------------

  /**
   * Freeze the renderer timebase.
   *
   * This is used when the document becomes hidden (tab backgrounding / app switching).
   * Simulation correctness is unaffected (time is only used for visualization effects).
   */
  pauseTimebase() {
    if (this._timePausedAtMs != null) return;
    const nowMs =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    this._timePausedAtMs = nowMs;
  }

  /**
   * Resume a previously frozen timebase.
   *
   * The internal start-time is shifted forward by the hidden duration so
   * elapsed time remains continuous for shaders.
   */
  resumeTimebase() {
    if (this._timePausedAtMs == null) return;
    const nowMs =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    const pausedAt = this._timePausedAtMs;
    this._timePausedAtMs = null;
    const delta = nowMs - pausedAt;
    if (Number.isFinite(delta) && delta > 0) {
      this._startTimeMs += delta;
    }
  }

  // ----------------------------
  // CPU -> GPU write helpers
  // ----------------------------

  _createBuffer(name, desc) {
    return this._buffers.createBuffer(name, desc);
  }

  _scratchU32View(count) {
    return this._buffers.scratchU32View(count);
  }

  _queueWrite(buffer, offsetBytes, view) {
    this._buffers.queueWrite(buffer, offsetBytes, view);
  }

  _queueWriteU32(buffer, offsetBytes, u32View) {
    this._buffers.queueWriteU32(buffer, offsetBytes, u32View);
  }

  _queueWriteF32(buffer, offsetBytes, f32View) {
    this._buffers.queueWriteF32(buffer, offsetBytes, f32View);
  }

  _writeIndirectDrawArgsDefault() {
    // Safe default until the first extract + draw-args passes run.
    if (!this.indirectArgsBuffer) return;
    const a = this._scratchU32View(G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_U32S);
    a[G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_U32.INDEX_COUNT] = (this.indexCount || 0) >>> 0;
    a[G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_U32.INSTANCE_COUNT] = 0;
    a[G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_U32.FIRST_INDEX] = 0;
    a[G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_U32.BASE_VERTEX] = 0;
    a[G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_U32.FIRST_INSTANCE] = 0;
    this._queueWriteU32(this.indirectArgsBuffer, 0, a);
  }

  _writeDrawArgsParams(indexCount, maxCells) {
    if (!this.drawArgsParamsBuffer) return;
    const p = this._scratchU32View(G3DL_LAYOUT.PARAMS.DRAW_ARGS.U32S);
    const P = G3DL_LAYOUT.PARAMS.DRAW_ARGS.U32;
    p[P.INDEX_COUNT] = (indexCount || 0) >>> 0;
    p[P.MAX_CELLS] = (maxCells || 0) >>> 0;
    p[P.PAD0] = 0;
    p[P.PAD1] = 0;
    this._queueWriteU32(this.drawArgsParamsBuffer, 0, p);
  }

  _writeAabbInitAccumulator() {
    // Initialize the accumulator: min = 0xFFFFFFFF, max = 0.
    if (!this.aabbBuffer) return;
    const a = this._scratchU32View(G3DL_LAYOUT.AABB.U32S);
    a[0] = 0xffffffff;
    a[1] = 0xffffffff;
    a[2] = 0xffffffff;
    a[3] = 0;
    a[4] = 0;
    a[5] = 0;
    a[6] = 0;
    a[7] = 0;
    this._queueWriteU32(this.aabbBuffer, 0, a);
  }
  async init() {
    return await initRenderer(this);
  }

  /**
   * Choose a safe (x,y,z) workgroup size for "one invocation per grid cell" compute kernels.
   *
   * These kernels are bounds-checked (global ID vs gridSize), so workgroup shape does not affect
   * correctness, but it must respect the device's per-dimension and total invocation limits.
   *
   * Selection heuristics:
   * - Prefer larger X to improve linear memory access for the x-major flattened grid.
   * - Cap the target invocation count on coarse-pointer devices (typically phones/tablets) to reduce
   *   latency spikes and improve overall UI responsiveness.
   *
   * @returns {{x:number, y:number, z:number}}
   */
  _chooseGridWorkgroupSize() {
    const lim = this.device?.limits;
    if (!lim) return { x: 8, y: 4, z: 4 };

    const maxInv =
      typeof lim.maxComputeInvocationsPerWorkgroup === "number"
        ? lim.maxComputeInvocationsPerWorkgroup
        : 256;
    const maxX =
      typeof lim.maxComputeWorkgroupSizeX === "number" ? lim.maxComputeWorkgroupSizeX : maxInv;
    const maxY =
      typeof lim.maxComputeWorkgroupSizeY === "number" ? lim.maxComputeWorkgroupSizeY : maxInv;
    const maxZ =
      typeof lim.maxComputeWorkgroupSizeZ === "number" ? lim.maxComputeWorkgroupSizeZ : maxInv;

    const targetCap = this._caps?.isCoarsePointer ? 128 : 256;
    const targetInv = Math.max(1, Math.min(maxInv, targetCap));

    // Ordered by preference: keep the prior default first, then fall back to smaller shapes.
    const candidates = [
      { x: 8, y: 4, z: 4 }, // 128
      { x: 8, y: 8, z: 2 }, // 128
      { x: 16, y: 4, z: 2 }, // 128
      { x: 16, y: 2, z: 2 }, // 64
      { x: 8, y: 4, z: 2 }, // 64
      { x: 4, y: 4, z: 4 }, // 64
      { x: 8, y: 2, z: 2 }, // 32
      { x: 4, y: 4, z: 2 }, // 32
      { x: 4, y: 2, z: 2 }, // 16
      { x: 4, y: 2, z: 1 }, // 8
      { x: 2, y: 2, z: 2 }, // 8
      { x: 1, y: 1, z: 1 }, // 1
    ];

    for (const wg of candidates) {
      const inv = wg.x * wg.y * wg.z;
      if (inv > targetInv) continue;
      if (wg.x > maxX || wg.y > maxY || wg.z > maxZ) continue;
      return wg;
    }

    // Final safety fallback (should not be needed for sane limits).
    return { x: 1, y: 1, z: 1 };
  }

  /**
   * Choose a safe power-of-two workgroup size for the AABB reduction pass.
   *
   * The AABB shader uses a tree reduction that halves the stride each iteration, so the
   * workgroup size must be a power of two. We also cap it to keep workgroup memory small
   * and to avoid relying on unusually large per-workgroup limits on some mobile GPUs.
   *
   * @returns {number} workgroupSizeX (power of two, >= 1)
   */
  _chooseAabbWorkgroupSize() {
    const lim = this.device?.limits;
    if (!lim) return 256;

    const maxInv =
      typeof lim.maxComputeInvocationsPerWorkgroup === "number"
        ? lim.maxComputeInvocationsPerWorkgroup
        : 256;

    const maxX =
      typeof lim.maxComputeWorkgroupSizeX === "number"
        ? lim.maxComputeWorkgroupSizeX
        : maxInv;

    // Keep the shader's shared arrays bounded (performance-friendly, predictable footprint).
    const cap = Math.max(1, Math.min(256, maxInv, maxX));

    // Greatest power-of-two <= cap.
    let p = 1;
    while (p << 1 <= cap) p <<= 1;
    return p;
  }

  /**
   * Create a compute pipeline, preferring the async variant when available.
   * @param {GPUComputePipelineDescriptor} desc
   * @returns {Promise<GPUComputePipeline>}
   */
  async _createComputePipeline(desc) {
    if (typeof this.device.createComputePipelineAsync === "function") {
      return await this.device.createComputePipelineAsync(desc);
    }
    // Fall back to synchronous pipeline creation when the async helpers are not
    // available (some implementations only expose create*Pipeline()).
    return this.device.createComputePipeline(desc);
  }

  /**
   * Create a render pipeline, preferring the async variant when available.
   * @param {GPURenderPipelineDescriptor} desc
   * @returns {Promise<GPURenderPipeline>}
   */
  async _createRenderPipeline(desc) {
    if (typeof this.device.createRenderPipelineAsync === "function") {
      return await this.device.createRenderPipelineAsync(desc);
    }
    // Fall back to synchronous pipeline creation when the async helpers are not
    // available (some implementations only expose create*Pipeline()).
    return this.device.createRenderPipeline(desc);
  }

  /**
   * Compile the core pipelines required for simulation and rendering.
   * This is awaited by init() so the first frame is fully correct.
   *
   * Optional pipelines (e.g. the AABB pass) are compiled lazily when first used.
   */
  async _ensureEssentialPipelines() {
    if (this._ensureEssentialPipelinesPromise) return this._ensureEssentialPipelinesPromise;
    this._ensureEssentialPipelinesPromise = (async () => {
      await Promise.all([
        this._createSimulationPipeline(),
        this._createExtractPipeline(),
        this._createInitPipeline(),
        this._createDrawArgsPipeline(),
        this._createCellsRenderPipeline(),
        this._createGridProjectionPipeline(),
        this._createBackgroundPipeline(),
      ]);
    })().finally(() => {
      // Clear the cached promise on failure so a subsequent call can retry
      // (e.g. after a device-lost recovery).  On success the early-return
      // guards inside each pipeline factory make the retry a no-op.
      if (!this.computePipeline || !this.renderPipeline) {
        this._ensureEssentialPipelinesPromise = null;
      }
    });
    return this._ensureEssentialPipelinesPromise;
  }

  /**
   * Ensure AABB pipelines and bind groups exist.
   * Compiled lazily because Screen show camera targeting is optional.
   *
   * @returns {Promise<boolean>} true if ready
   */
  async _ensureAabbPipelines() {
    if (this.aabbPipeline && this.aabbArgsPipeline && this.aabbBindGroup && this.aabbArgsBindGroup) {
      return true;
    }
    if (!this.device) return false;
    if (this._ensureAabbPipelinesPromise) return await this._ensureAabbPipelinesPromise;

    this._ensureAabbPipelinesPromise = (async () => {
      await this._createAabbPipelines();
      // Bind groups depend on the pipeline layouts.
      this._rebuildBindGroups();
      return !!(
        this.aabbPipeline &&
        this.aabbArgsPipeline &&
        this.aabbBindGroup &&
        this.aabbArgsBindGroup
      );
    })()
      .catch((e) => {
        warn(LOG_MSG.AABB_PIPELINE_FAILED, e);
        return false;
      })
      .finally(() => {
        this._ensureAabbPipelinesPromise = null;
      });

    return await this._ensureAabbPipelinesPromise;
  }

  async _createSimulationPipeline() {
    return await createSimulationPipelineImpl(this);
  }

  async _createExtractPipeline() {
    return await createExtractPipelineImpl(this);
  }

  async _createAabbPipelines() {
    await createAabbPipelinesImpl(this);
  }

  async _createInitPipeline() {
    return await createInitPipelineImpl(this);
  }

  async _createDrawArgsPipeline() {
    return await createDrawArgsPipelineImpl(this);
  }

  _createDrawArgsResources() {
    // Create once; updated by a compute pass each simulation step.
    if (!this.indirectArgsBuffer) {
      this.indirectArgsBuffer = this._createBuffer("indirectArgsBuffer", {
        size: G3DL_LAYOUT.INDIRECT.DRAW_INDEXED_BYTES,
        usage:
          GPUBufferUsage.INDIRECT |
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });
    }

    if (!this.drawArgsParamsBuffer) {
      this.drawArgsParamsBuffer = this._createBuffer("drawArgsParamsBuffer", {
        size: G3DL_LAYOUT.PARAMS.DRAW_ARGS.BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // Safe default until first extract pass runs
    this._writeIndirectDrawArgsDefault();
    this._updateDrawArgsParams();
  }

  _updateDrawArgsParams() {
    this._writeDrawArgsParams(this.indexCount, this.maxCells);
  }

  _rebuildBindGroups() {
    rebuildBindGroupsImpl(this);
  }



  _shouldReadbackStats(force) {
    return shouldReadbackStatsImpl(this, force);
  }



  async _acquireReadbackSlot(forceWait) {
    return await acquireReadbackSlotImpl(this, forceWait);
  }



  _startReadback(slot, stepGeneration) {
    return startReadbackImpl(this, slot, stepGeneration);
  }


  /**
   * Request a lightweight population (live-cell count) readback from the GPU.
   *
   * This is intentionally separate from the throttled stats ring used by step(), so callers can
   * refresh the HUD (or Screen show heuristics) in fast-play modes without forcing per-step
   * readbacks or stalling the simulation queue.
   *
   * Notes:
   *  - The count is read from atomicCounterBuffer, which is written by the extract pass.
   *  - The returned generation is the CPU-side generation number at the time the readback was queued.
   *    If multiple steps are queued quickly, the returned generation may lag behind the current one;
   *    callers should ignore out-of-order results if they care about monotonicity.
   *
   * @param {boolean} [force=false] - Bypass the internal min-interval throttle.
   * @returns {Promise<null|{population:number, generation:number}>}
   */

  requestPopulationReadback(force = false) {
    return requestPopulationReadbackImpl(this, force);
  }


  /**
   * Request a best-effort AABB (in cell coordinates) of the current live-cell list.
   *
   * This reads the authoritative live-cell count directly from the GPU-side atomic counter
   * produced by the extract pass, so it remains correct even when CPU stats readback is throttled.
   *
   * @returns {Promise<null|{min:number[],max:number[],count:number}>}
   */
  async requestLivingCellsAABB() {
    return await requestLivingCellsAABBImpl(this);
  }

  async _createCellsRenderPipeline() {
    return await createCellsRenderPipeline(this);
  }
  async _createGridProjectionPipeline() {
    return await createGridProjectionPipelineImpl(this);
  }

  _rebuildGridProjectionInstances() {
    rebuildGridProjectionInstancesImpl(this);
  }

  async _createBackgroundPipeline() {
    return await createBackgroundPipelineImpl(this);
  }

  _createCubeGeometry() {
    createCubeGeometryImpl(this);
  }

  _destroyGridResources() {
    destroyGridResourcesImpl(this);
  }

  _createGridBuffers() {
    createGridBuffersImpl(this);
  }

  setGridSize(size) {
    const max = this.getMaxSupportedGridSize();
    if (size > MAX_PACKED_GRID_SIZE) {
      throw new Error(
        `Grid size ${size} exceeds packed-coordinate limit (${MAX_PACKED_GRID_SIZE}). ` +
          `Rendering packs x/y/z into 10 bits each (0..1023).`
      );
    }

    if (size > max) {
      throw new Error(`Grid size ${size} exceeds maximum (${max})`);
    }
    if (this.maxGridBufferBytes && size ** 3 * 4 > this.maxGridBufferBytes) {
      throw new Error(`Grid size ${size} exceeds per-buffer GPU limits`);
    }
    this.gridSize = size;
    this.currentBuffer = 0;
    this.population = 0;
    this.generation = 0;
    this.lastStepChanged = true;
    this._createGridBuffers();
    this._createDrawArgsResources();
    this._rebuildBindGroups();
    // Grid projection faces depend on gridSize/cellSize.
    this._rebuildGridProjectionInstances();

    if (G3DL_LAYOUT.DEBUG) {
      G3DL_LAYOUT.assertRenderer(this);
    }
  }

  async randomize(density = 0.15, initSize = null) {
    return await randomizeGridImpl(this, density, initSize);
  }

  async step(options = {}) {
    return await stepSimulationImpl(this, options);
  }

  setSurviveRule(c) {
    this.surviveRule = 0;
    for (const n of c) if (n >= 0 && n <= 26) this.surviveRule |= 1 << n;
    this.surviveRule >>>= 0;
  }
  setBirthRule(c) {
    this.birthRule = 0;
    for (const n of c) if (n >= 0 && n <= 26) this.birthRule |= 1 << n;
    this.birthRule >>>= 0;
  }
  setToroidal(e) {
    this.toroidal = e;
  }
  setChangeDetectionEnabled(enabled) {
    this.enableChangeDetection = !!enabled;
    // Force 'changed' state to avoid accidental auto-stop on stale counters.
    this.lastStepChanged = true;
    if (this.device && this.changeCounterBuffer) {
      try {
        this._queueWriteU32(this.changeCounterBuffer, 0, this._u32_1);
      } catch (_) {
        // Ignore if device is not ready or buffer was recreated.
      }
    }
  }

  getMaxSupportedGridSize() {
    return Math.min(this.maxSupportedGridSize || 256, MAX_PACKED_GRID_SIZE);
  }

  setCellColors(topHex, bottomHex) {
    const top = tryParseHexColor01(topHex);
    const bottom = tryParseHexColor01(bottomHex);

    // Warn only when malformed input would otherwise feed NaNs into uniforms.
    if (!top && String(topHex ?? "").trim() !== "") {
      warn("Invalid cell top color:", topHex);
    }
    if (!bottom && String(bottomHex ?? "").trim() !== "") {
      warn("Invalid cell bottom color:", bottomHex);
    }

    if (top) this.cellColorTop = top;
    if (bottom) this.cellColorBottom = bottom;
  }

  setBackgroundColors(topHex, bottomHex) {
    const top = tryParseHexColor01(topHex);
    const bottom = tryParseHexColor01(bottomHex);

    if (!top && String(topHex ?? "").trim() !== "") {
      warn("Invalid background top color:", topHex);
    }
    if (!bottom && String(bottomHex ?? "").trim() !== "") {
      warn("Invalid background bottom color:", bottomHex);
    }

    if (top) this.bgColorTop = top;
    if (bottom) this.bgColorBottom = bottom;
  }

  /**
   * Set haze strength.
   *
   * @param {number} strength Maximum blend amount in [0..0.30].
   */
  setHazeStrength(strength) {
    const n = Number(strength);
    this.hazeStrength = Number.isFinite(n) ? Math.max(0.0, Math.min(0.30, n)) : 0.0;
  }

  setLanternLightingEnabled(enabled) {
    this.lanternEnabled = enabled ? 1.0 : 0.0;
  }

  setGridProjectionEnabled(enabled) {
    this.gridProjectionEnabled = enabled ? 1.0 : 0.0;
  }

  render() {
    renderFrameImpl(this);
  }

  resize(options = {}) {
    return resizeRenderer(this, options);
  }

  // ----------------------------
  // Teardown (SPA embeds)
  // ----------------------------

  /**
   * Destroy GPU resources owned by this renderer.
   *
   * WebGPU implementations will eventually release resources when the
   * corresponding JS objects are garbage-collected. However, in SPA-style
   * mounts/unmounts we want to proactively destroy buffers/textures to avoid
   * accumulating GPU memory (and to prevent device-loss due to memory pressure
   * on mobile browsers).
   *
   * This method is intentionally idempotent.
   */
  destroy() {
    destroyRenderer(this);
  }

  // ----------------------------
  // Camera controls (delegated)
  // ----------------------------

  rotate(dx, dy) {
    rotateImpl(this, dx, dy);
  }

  pan(dx, dy) {
    panImpl(this, dx, dy);
  }

  updateInertia() {
    return updateInertiaImpl(this);
  }

  stopInertia() {
    stopInertiaImpl(this);
  }

  zoomCamera(d) {
    zoomCameraImpl(this, d);
  }

  resetPan() {
    resetPanImpl(this);
  }

  resetView() {
    resetViewImpl(this);
  }

  setCameraOverride(eye, target, up = [0, 1, 0]) {
    setCameraOverrideImpl(this, eye, target, up);
  }

  clearCameraOverride() {
    clearCameraOverrideImpl(this);
  }

  commitCameraOverrideToUser() {
    commitCameraOverrideToUserImpl(this);
  }
}
