import { G3DL_LAYOUT } from "./dataLayout.js";
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
import { createUniformBuffer as createUniformBufferImpl } from "./resources/uniforms.js";
import {
  shouldReadbackStats as shouldReadbackStatsImpl,
  acquireReadbackSlot as acquireReadbackSlotImpl,
  startReadback as startReadbackImpl,
  requestPopulationReadback as requestPopulationReadbackImpl,
} from "./readback.js";
import { rebuildBindGroups as rebuildBindGroupsImpl } from "./resources/bindGroups.js";
import {
  updateFrameUniforms as updateFrameUniformsImpl,
  updateRenderUniforms as updateRenderUniformsImpl,
} from "./resources/frameUniforms.js";
import { BufferManager } from "./util/bufferManager.js";
import {
  ensureCameraScratch,
  syncCameraMatrix,
  setQuatFromEuler as setQuatFromEulerImpl,
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


// Packed cell coordinate format: 10 bits per axis.
//
// The GPU compaction path stores live cell coordinates in a single u32:
//   x (10 bits) | y (10 bits) << 10 | z (10 bits) << 20
// See src/gpu/shaders.js for the WGSL packing/unpacking logic.
//
// This supports coordinates 0..1023, so gridSize must be <= 1024.
const PACKED_CELL_AXIS_BITS = 10;
const MAX_PACKED_GRID_SIZE = 1 << PACKED_CELL_AXIS_BITS;


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
    // Used to keep UI and Screensaver heuristics reasonably fresh in fast-play modes without stalling steps.
    this.populationReadbackBuffers = null;
    this.populationReadbackPending = false;
    this.populationReadbackPromise = null;
    this.populationReadbackSlot = 0;
    this.populationReadbackLastTimeMs = 0;
    this.populationReadbackMinIntervalMs = 250; // cap readbacks to avoid UI/GPU stalls
    this.populationValidGeneration = -1;

    // Change detection counter
    this.changeCounterBuffer = null;

    // Optional live-cell AABB readback (used by Screensaver camera targeting)
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
      pipelineAsync: false,
    };
    /** @type {Map<string, GPUShaderModule>} */
    this._shaderModuleCache = new Map();
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

    this.surviveRule = 0b11100000;
    this.birthRule = 0b01000000;
    this.toroidal = false;
    this.enableChangeDetection = true;

    // Workgroup size tuning (x,y,z). 8x4x4 = 128 threads/workgroup (<= 256 guaranteed).
    this.workgroupSize = { x: 8, y: 4, z: 4 };

    // Max grid size supported by per-buffer limits and conservative total-memory heuristics; populated in init().
    this.maxSupportedGridSize = 256;

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
    this._model = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    this._renderUniforms = new Float32Array(G3DL_LAYOUT.UNIFORMS.DATA_FLOATS);
    this._eye = new Float32Array(3);
    this._target = new Float32Array(3);

    // Optional camera override (used by Screensaver mode).
    // When enabled, updateUniforms() uses these explicit vectors instead of the user-controlled trackball camera.
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

    // Set initial camera rotation.
    // Camera scratch must exist before any rotation operations (no per-frame allocations).
    ensureCameraScratch(this);
    this.setQuatFromEuler(0.7, -0.5);
    syncCameraMatrix(this);
  }

  // ----------------------------
  // CPU -> GPU write helpers
  // ----------------------------

  _registerBuffer(buffer, name, byteLength, usage) {
    this._buffers.registerBuffer(buffer, name, byteLength, usage);
  }

  _createBuffer(name, desc) {
    return this._buffers.createBuffer(name, desc);
  }

  _scratchU32View(count) {
    return this._buffers.scratchU32View(count);
  }

  _scratchF32View(count) {
    return this._buffers.scratchF32View(count);
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
    if (!navigator.gpu) throw new Error("WebGPU not supported");

    let adapter = null;
    for (const delay of [0, 100, 300, 500]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      adapter = await navigator.gpu.requestAdapter();
      if (adapter) break;
    }
    if (!adapter) throw new Error("No GPU adapter found");

    // Capability negotiation:
    // - Prefer requesting the full adapter limits for large storage buffers when available.
    // - Fall back to default limits if the request is rejected by the implementation.
    const limits = adapter.limits;
    const WANT = 134217728; // 128 MiB is a useful threshold for large 3D grids.
    const requiredLimits = {};
    if (typeof limits.maxStorageBufferBindingSize === "number" && limits.maxStorageBufferBindingSize > WANT) {
      requiredLimits.maxStorageBufferBindingSize = limits.maxStorageBufferBindingSize;
    }
    if (typeof limits.maxBufferSize === "number" && limits.maxBufferSize > WANT) {
      requiredLimits.maxBufferSize = limits.maxBufferSize;
    }

    const deviceDesc = Object.keys(requiredLimits).length ? { requiredLimits } : {};
    try {
      this.device = await adapter.requestDevice(deviceDesc);
    } catch (e) {
      console.warn("requestDevice with requiredLimits failed; retrying with defaults", e);
      this.device = await adapter.requestDevice();
    }

    // BufferManager must be attached to the newly created device before any resource allocation.
    // (We create several buffers immediately after this during init.)
    this._buffers.setDevice(this.device);

    this._caps.pipelineAsync =
      typeof this.device.createComputePipelineAsync === "function" &&
      typeof this.device.createRenderPipelineAsync === "function";

    // Device loss can happen on mobile (backgrounding, memory pressure, driver reset).
    // Surface this to the app so it can stop the simulation and prompt the user.
    this.device.lost.then((info) => {
      this.deviceLost = true;
      console.error("WebGPU device lost:", info);
      if (typeof this.onDeviceLost === "function") {
        try {
          this.onDeviceLost(info);
        } catch (e) {
          console.warn("onDeviceLost callback failed:", e);
        }
      }
    });

    this.maxBufferSize = this.device.limits.maxStorageBufferBindingSize;

    // Configure the AABB reduction kernel size based on device limits.
    this.aabbWorkgroupSize = this.chooseAabbWorkgroupSize();

    // Derive a safe maximum grid size from per-buffer limits (per-binding) AND a conservative total-memory heuristic.
    // One cell = 4 bytes (u32). Each grid buffer must fit within maxStorageBufferBindingSize (and maxBufferSize).
    const perBufferLimit = Math.min(
      this.device.limits.maxStorageBufferBindingSize,
      this.device.limits.maxBufferSize ??
        this.device.limits.maxStorageBufferBindingSize,
    );
    const maxCellsPerBuffer = Math.floor(perBufferLimit / 4);
    const maxGridFromLimits = Math.floor(Math.cbrt(maxCellsPerBuffer));
    let maxGrid = Math.max(4, Math.min(256, maxGridFromLimits));

    // Additional hard safety cap from the packed live-cell coordinate format.
    // (Today we clamp to <= 256 anyway, but we keep this explicit so that future
    // grid-size expansions cannot silently break rendering.)
    maxGrid = Math.min(maxGrid, MAX_PACKED_GRID_SIZE);


    // Conservative, best-effort cap based on expected total GPU memory pressure.
    // WebGPU does not expose total VRAM; this is a heuristic to reduce device-loss on mobile.
    const isCoarsePointer =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches;
    this._caps.isCoarsePointer = !!isCoarsePointer;

    // Mobile-friendly queue pacing.
    // Coarse-pointer devices are typically phones/tablets where over-submitting work can cause
    // latency spikes or even device loss due to memory pressure.
    if (this._caps.isCoarsePointer) {
      this._paceEveryNSteps = 1;
      this._paceMinIntervalMs = 33;
    }
    const budgetBytes = isCoarsePointer ? 128 * 1024 * 1024 : 256 * 1024 * 1024;
    const safetyOverhead = 16 * 1024 * 1024; // textures, pipelines, backbuffers, driver overhead, etc.
    const budgetUsable = Math.max(
      32 * 1024 * 1024,
      budgetBytes - safetyOverhead,
    );

    let maxGridByBudget = 4;

    // Additional cap driven by expected interactive rendering limits.
    // Rendering worst-case can require up to gridSize^3 cube instances; this cap prevents pathological UI stalls.
    const maxGridByRender = isCoarsePointer ? 128 : 160;
    maxGrid = Math.max(4, Math.min(maxGrid, maxGridByRender));

    // Estimate total GPU memory pressure from persistent buffers.
    // We allocate 2 full grid buffers (ping-pong) plus a full living-cell list buffer.
    // Each cell entry is a u32 (4 bytes).
    for (let n = 4; n <= maxGrid; n++) {
      const total = n ** 3;
      const bytes = 3 * total * 4;
      if (bytes <= budgetUsable) {
        maxGridByBudget = n;
      } else {
        break; // bytes increases monotonically with n
      }
    }

    this.maxSupportedGridSize = Math.max(4, Math.min(maxGrid, maxGridByBudget));

    this.context = this.canvas.getContext("webgpu");
    if (!this.context) throw new Error("Failed to get WebGPU context");

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this._canvasConfig = {
      device: this.device,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      alphaMode: "premultiplied",
    };

    // Configure the canvas and create the depth buffer using the current devicePixelRatio.
    // We re-run this logic on resize/orientation changes to keep the swapchain correct on mobile browsers.
    this.resize({ force: true });

    // Kick off pipeline compilation early, while we allocate buffers.
    const pipelinesPromise = this.ensureEssentialPipelines();
    this.createCubeGeometry();
    this.createUniformBuffer();
    this.createGridBuffers();
    this.createDrawArgsResources();
    // Wait for essential pipelines to be ready before building bind groups.
    await pipelinesPromise;
    this.rebuildBindGroups();

    if (G3DL_LAYOUT.DEBUG) {
      // Validate JS<->WGSL buffer contracts early (debug-only).
      G3DL_LAYOUT.assertRenderer(this);
    }

    return true;
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
  chooseAabbWorkgroupSize() {
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
   * Cache shader modules by WGSL source to avoid duplicate compilation work.
   * @param {string} code WGSL source
   * @returns {GPUShaderModule}
   */
  _getShaderModule(code) {
    const cached = this._shaderModuleCache.get(code);
    if (cached) return cached;
    const mod = this.device.createShaderModule({ code });
    this._shaderModuleCache.set(code, mod);
    return mod;
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
    return this.device.createRenderPipeline(desc);
  }

  /**
   * Compile the core pipelines required for simulation and rendering.
   * This is awaited by init() so the first frame is fully correct.
   *
   * Optional pipelines (e.g. the AABB pass) are compiled lazily when first used.
   */
  async ensureEssentialPipelines() {
    if (this._ensureEssentialPipelinesPromise) return this._ensureEssentialPipelinesPromise;
    this._ensureEssentialPipelinesPromise = (async () => {
      await Promise.all([
        this.createComputePipeline(),
        this.createExtractPipeline(),
        this.createInitPipeline(),
        this.createDrawArgsPipeline(),
        this.createRenderPipeline(),
        this.createGridProjectionPipeline(),
        this.createBackgroundPipeline(),
      ]);
    })();
    return this._ensureEssentialPipelinesPromise;
  }

  /**
   * Ensure AABB pipelines and bind groups exist.
   * Compiled lazily because Screensaver camera targeting is optional.
   *
   * @returns {Promise<boolean>} true if ready
   */
  async ensureAabbPipelines() {
    if (this.aabbPipeline && this.aabbArgsPipeline && this.aabbBindGroup && this.aabbArgsBindGroup) {
      return true;
    }
    if (!this.device) return false;
    if (this._ensureAabbPipelinesPromise) return await this._ensureAabbPipelinesPromise;

    this._ensureAabbPipelinesPromise = (async () => {
      await this.createAabbPipeline();
      // Bind groups depend on the pipeline layouts.
      this.rebuildBindGroups();
      return !!(
        this.aabbPipeline &&
        this.aabbArgsPipeline &&
        this.aabbBindGroup &&
        this.aabbArgsBindGroup
      );
    })()
      .catch((e) => {
        console.warn("AABB pipeline compilation failed; Screensaver targeting will be disabled", e);
        return false;
      })
      .finally(() => {
        this._ensureAabbPipelinesPromise = null;
      });

    return await this._ensureAabbPipelinesPromise;
  }

  async createComputePipeline() {
    return await createSimulationPipelineImpl(this);
  }

  async createExtractPipeline() {
    return await createExtractPipelineImpl(this);
  }

  async createAabbPipeline() {
    await createAabbPipelinesImpl(this);
  }

  async createInitPipeline() {
    return await createInitPipelineImpl(this);
  }

  async createDrawArgsPipeline() {
    return await createDrawArgsPipelineImpl(this);
  }

  createDrawArgsResources() {
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
    this.updateDrawArgsParams();
  }

  updateDrawArgsParams() {
    this._writeDrawArgsParams(this.indexCount, this.maxCells);
  }

  rebuildBindGroups() {
    rebuildBindGroupsImpl(this);
  }



  shouldReadbackStats(force) {
    return shouldReadbackStatsImpl(this, force);
  }



  async acquireReadbackSlot(forceWait) {
    return await acquireReadbackSlotImpl(this, forceWait);
  }



  startReadback(slot, stepGeneration) {
    return startReadbackImpl(this, slot, stepGeneration);
  }


  /**
   * Request a lightweight population (live-cell count) readback from the GPU.
   *
   * This is intentionally separate from the throttled stats ring used by step(), so callers can
   * refresh the HUD (or Screensaver heuristics) in fast-play modes without forcing per-step
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
    if (
      !this.device ||
      !this.aabbDispatchArgsBuffer ||
      !this.aabbBuffer ||
      !this.aabbStagingBuffers ||
      !this.atomicCounterBuffer
    ) {
      return null;
    }

    // Coalesce concurrent requests.
    if (this.aabbReadbackPending && this.aabbReadbackPromise) {
      return await this.aabbReadbackPromise;
    }

    // Lazily compile the pipelines used by this optional feature.
    const ready = await this.ensureAabbPipelines();
    if (
      !ready ||
      !this.aabbPipeline ||
      !this.aabbArgsPipeline ||
      !this.aabbBindGroup ||
      !this.aabbArgsBindGroup
    ) {
      return null;
    }

    const slot = this.aabbReadbackSlot % this.aabbStagingBuffers.length;
    const staging = this.aabbStagingBuffers[slot];
    this.aabbReadbackSlot = (slot + 1) % this.aabbStagingBuffers.length;

    // Initialize the accumulator: min = 0xFFFFFFFF, max = 0.
    this._writeAabbInitAccumulator();

    const enc = this.device.createCommandEncoder();

    // Pass 1: generate dispatchWorkgroupsIndirect() args from the atomic live-cell counter.
    {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.aabbArgsPipeline);
      pass.setBindGroup(0, this.aabbArgsBindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
    }

    // Pass 2: reduce live-cell coordinates into an AABB (indirect dispatch).
    {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.aabbPipeline);
      pass.setBindGroup(0, this.aabbBindGroup);
      pass.dispatchWorkgroupsIndirect(this.aabbDispatchArgsBuffer, 0);
      pass.end();
    }

    // Copy both AABB and the current live-cell count into a staging buffer for readback.
    enc.copyBufferToBuffer(this.aabbBuffer, 0, staging, 0, 32);
    enc.copyBufferToBuffer(this.atomicCounterBuffer, 0, staging, 32, 4);
    this.device.queue.submit([enc.finish()]);

    // Best-effort: ensure unmapped prior to mapping
    try {
      staging.unmap();
    } catch (_) {}

    this.aabbReadbackPending = true;
    this.aabbReadbackPromise = staging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const u = new Uint32Array(staging.getMappedRange());
        const minX = u[0],
          minY = u[1],
          minZ = u[2];
        const maxX = u[3],
          maxY = u[4],
          maxZ = u[5];
        const count = u[8] >>> 0; // offset 32 bytes

        staging.unmap();

        this.aabbReadbackPending = false;
        this.aabbReadbackPromise = null;

        if (!count || minX === 0xffffffff) {
          this.lastAabb = null;
          return null;
        }

        const res = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], count };
        this.lastAabb = res;
        return res;
      })
      .catch(() => {
        try {
          staging.unmap();
        } catch (_) {}
        this.aabbReadbackPending = false;
        this.aabbReadbackPromise = null;
        return null;
      });

    return this.aabbReadbackPromise;
  }

  async maybePace(force = false) {
    if (
      !this.device ||
      !this.device.queue ||
      typeof this.device.queue.onSubmittedWorkDone !== "function"
    ) {
      return;
    }

    const now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    const dueBySteps = this._stepsSincePace >= this._paceEveryNSteps;
    const dueByTime = now - this._lastPaceTimeMs >= this._paceMinIntervalMs;

    if (force || dueBySteps || dueByTime) {
      this._stepsSincePace = 0;
      this._lastPaceTimeMs = now;
      try {
        await this.device.queue.onSubmittedWorkDone();
      } catch (_) {
        // Ignore device-lost / transient failures; caller handles the overall error path.
      }
    }
  }

  async createRenderPipeline() {
    return await createCellsRenderPipeline(this);
  }
  async createGridProjectionPipeline() {
    return await createGridProjectionPipelineImpl(this);
  }

  rebuildGridProjectionInstances() {
    rebuildGridProjectionInstancesImpl(this);
  }

  async createBackgroundPipeline() {
    return await createBackgroundPipelineImpl(this);
  }

  createCubeGeometry() {
    createCubeGeometryImpl(this);
  }

  destroyGridResources() {
    destroyGridResourcesImpl(this);
  }

  createGridBuffers() {
    createGridBuffersImpl(this);
  }

  createUniformBuffer() {
    createUniformBufferImpl(this);
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
    if (this.maxBufferSize && size ** 3 * 4 > this.maxBufferSize) {
      throw new Error(`Grid size ${size} exceeds GPU limits`);
    }
    this.gridSize = size;
    this.currentBuffer = 0;
    this.population = 0;
    this.generation = 0;
    this.lastStepChanged = true;
    this.createGridBuffers();
    this.createDrawArgsResources();
    this.rebuildBindGroups();
    // Grid projection faces depend on gridSize/cellSize.
    this.rebuildGridProjectionInstances();

    if (G3DL_LAYOUT.DEBUG) {
      G3DL_LAYOUT.assertRenderer(this);
    }
  }

  async randomize(density = 0.15, initSize = null) {
    const size = this.gridSize;
    const region = Math.min(initSize || size, size);
    const off = Math.floor((size - region) / 2);

    // Convert density (0..1) to a u32 threshold for comparison.
    const d = Math.max(0, Math.min(1, Number(density) || 0));
    const threshold = Math.min(
      0xffffffff,
      Math.max(0, Math.floor(d * 4294967295)),
    );

    // Seed changes per reset for a new random field.
    const seed =
      ((typeof performance !== "undefined" && performance.now
        ? Math.floor(performance.now() * 1000)
        : Date.now()) ^
        Math.floor(Math.random() * 0xffffffff)) >>>
      0;

    const initP = G3DL_LAYOUT.PARAMS.INIT.U32;
    this._initParams[initP.GRID_SIZE] = size;
    this._initParams[initP.REGION] = region;
    this._initParams[initP.OFFSET] = off;
    this._initParams[initP.THRESHOLD] = threshold >>> 0;
    this._initParams[initP.SEED] = seed;
    this._initParams[initP.PAD0] = 0;
    this._initParams[initP.PAD1] = 0;
    this._initParams[initP.PAD2] = 0;
    this._queueWriteU32(this.initParamsBuffer, 0, this._initParams);

    const wgX = Math.ceil(size / this.workgroupSize.x);
    const wgY = Math.ceil(size / this.workgroupSize.y);
    const wgZ = Math.ceil(size / this.workgroupSize.z);

    // Prepare extraction parameters and counters up front. We keep init->extract->drawArgs
    // inside a single command submission, using separate passes, to make ordering explicit
    // across all backends and reduce per-submit overhead on mobile browsers.
    const extP = G3DL_LAYOUT.PARAMS.EXTRACT.U32;
    this._extractParams[extP.GRID_SIZE] = this.gridSize;
    this._extractParams[extP.MAX_CELLS] = this.maxCells;
    this._extractParams[extP.PAD0] = 0;
    this._extractParams[extP.PAD1] = 0;
    this._queueWriteU32(this.extractParamsBuffer, 0, this._extractParams);

    // Reset counters before the extract pass runs.
    this._queueWriteU32(this.atomicCounterBuffer, 0, this._u32_0);
    // Force "changed" true so UI state (e.g., auto-stop) cannot latch onto a stale 0.
    this._queueWriteU32(this.changeCounterBuffer, 0, this._u32_1);

    // Randomization should update UI state immediately, so we sync stats here.
    const syncStats = true;
    const slot = await this.acquireReadbackSlot(syncStats);

    const encoder = this.device.createCommandEncoder();

    // 1) Initialize the grid
    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.initPipeline);
      pass.setBindGroup(0, this.initBindGroups[this.currentBuffer]);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);

      pass.end();
    }

    // 2) Extract living cells for rendering
    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.extractPipeline);
      pass.setBindGroup(0, this.extractBindGroups[this.currentBuffer]);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);

      pass.end();
    }

    // 3) Build indirect draw args (clamps instance count to maxCells)
    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.drawArgsPipeline);
      pass.setBindGroup(0, this.drawArgsBindGroup);
      pass.dispatchWorkgroups(1, 1, 1);

      pass.end();
    }

    if (slot >= 0) {
      encoder.copyBufferToBuffer(
        this.atomicCounterBuffer,
        0,
        this.statsStagingBuffers[slot],
        0,
        4,
      );
      encoder.copyBufferToBuffer(
        this.changeCounterBuffer,
        0,
        this.changeStagingBuffers[slot],
        0,
        4,
      );
    }

    this.device.queue.submit([encoder.finish()]);

    // Randomization resets the simulation timeline.
    this.population = 0;
    this.generation = 0;
    this.lastStepChanged = true;

    // Stats correspond to generation 0.
    if (slot >= 0) {
      await this.startReadback(slot, 0);
    }
  }

  async step(options = {}) {
    const syncStats = !!options.syncStats;
    const pace = options.pace !== false;

    const prev = this.currentBuffer;
    const next = 1 - prev;
    const wgX = Math.ceil(this.gridSize / this.workgroupSize.x);
    const wgY = Math.ceil(this.gridSize / this.workgroupSize.y);
    const wgZ = Math.ceil(this.gridSize / this.workgroupSize.z);

    // Update per-step simulation parameters
    const simP = G3DL_LAYOUT.PARAMS.SIM.U32;
    this._computeParams[simP.GRID_SIZE] = this.gridSize;
    this._computeParams[simP.SURVIVE_RULE] = this.surviveRule;
    this._computeParams[simP.BIRTH_RULE] = this.birthRule;
    this._computeParams[simP.TOROIDAL] = this.toroidal ? 1 : 0;
    this._computeParams[simP.CHANGE_ENABLED] = this.enableChangeDetection ? 1 : 0;
    this._computeParams[simP.PAD0] = 0;
    this._computeParams[simP.PAD1] = 0;
    this._computeParams[simP.PAD2] = 0;
    this._queueWriteU32(this.computeParamsBuffer, 0, this._computeParams);
    // Update per-step extraction parameters (maxCells affects draw clamping)
    const extP = G3DL_LAYOUT.PARAMS.EXTRACT.U32;
    this._extractParams[extP.GRID_SIZE] = this.gridSize;
    this._extractParams[extP.MAX_CELLS] = this.maxCells;
    this._extractParams[extP.PAD0] = 0;
    this._extractParams[extP.PAD1] = 0;
    this._queueWriteU32(this.extractParamsBuffer, 0, this._extractParams);

    // Reset counters used by extraction + change detection
    this._queueWriteU32(this.atomicCounterBuffer, 0, this._u32_0);
    if (this.enableChangeDetection) {
      this._queueWriteU32(this.changeCounterBuffer, 0, this._u32_0);
    } else {
      // Keep "changed" non-zero so play mode never auto-stops due to stability.
      this._queueWriteU32(this.changeCounterBuffer, 0, this._u32_1);
    }

    // Schedule a readback only when needed (or if sync requested)
    const doReadback = this.shouldReadbackStats(syncStats);
    let slot = -1;
    if (doReadback) {
      slot = await this.acquireReadbackSlot(syncStats);
    }

    const encoder = this.device.createCommandEncoder();

    // NOTE: We intentionally split simulation, extraction, and indirect-args generation into
    // separate compute passes. This makes the data dependencies explicit and relies only on
    // WebGPU's pass-to-pass visibility guarantees (portable across backends and drivers).
    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.computePipeline);
      pass.setBindGroup(0, this.computeBindGroups[prev]);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);

      pass.end();
    }

    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.extractPipeline);
      pass.setBindGroup(0, this.extractBindGroups[next]);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);

      pass.end();
    }

    // Build indirect draw args (clamps instance count to maxCells)
    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.drawArgsPipeline);
      pass.setBindGroup(0, this.drawArgsBindGroup);
      pass.dispatchWorkgroups(1, 1, 1);

      pass.end();
    }

    const stepGeneration = this.generation + 1;

    if (slot >= 0) {
      encoder.copyBufferToBuffer(
        this.atomicCounterBuffer,
        0,
        this.statsStagingBuffers[slot],
        0,
        4,
      );
      encoder.copyBufferToBuffer(
        this.changeCounterBuffer,
        0,
        this.changeStagingBuffers[slot],
        0,
        4,
      );
    }

    this.device.queue.submit([encoder.finish()]);

    // Optional pacing to keep the GPU submission queue bounded.
    // Without pacing, very small UI delays can enqueue many steps ahead of the GPU,
    // increasing latency and risking device loss on memory-constrained devices.
    if (pace) {
      this._stepsSincePace++;
      await this.maybePace(false);
    }

    // Swap buffers and advance generation
    this.currentBuffer = next;
    this.generation = stepGeneration;

    if (slot >= 0) {
      const p = this.startReadback(slot, stepGeneration);
      if (syncStats) {
        await p;
        return this.lastStepChanged;
      }
    }

    // In async mode, return the most recent known value (may lag)
    return this.lastStepChanged;
  }

  async extractLivingCells(options = {}) {
    // Used after randomization / initialization. Default to syncing so UI updates immediately.
    const syncStats = options.syncStats !== false;
    const wgX = Math.ceil(this.gridSize / this.workgroupSize.x);
    const wgY = Math.ceil(this.gridSize / this.workgroupSize.y);
    const wgZ = Math.ceil(this.gridSize / this.workgroupSize.z);

    const extP = G3DL_LAYOUT.PARAMS.EXTRACT.U32;
    this._extractParams[extP.GRID_SIZE] = this.gridSize;
    this._extractParams[extP.MAX_CELLS] = this.maxCells;
    this._extractParams[extP.PAD0] = 0;
    this._extractParams[extP.PAD1] = 0;
    this._queueWriteU32(this.extractParamsBuffer, 0, this._extractParams);

    // Reset population counter. Force 'changed' true for the UI/controls.
    this._queueWriteU32(this.atomicCounterBuffer, 0, this._u32_0);
    // Force "changed" true for the UI/controls.
    this._queueWriteU32(this.changeCounterBuffer, 0, this._u32_1);

    const slot = await this.acquireReadbackSlot(syncStats);

    const encoder = this.device.createCommandEncoder();

    // Split into separate passes to make the "extract -> counter -> indirect args" dependency explicit.
    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.extractPipeline);
      pass.setBindGroup(0, this.extractBindGroups[this.currentBuffer]);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);

      pass.end();
    }

    {
      const pass = encoder.beginComputePass();

      pass.setPipeline(this.drawArgsPipeline);
      pass.setBindGroup(0, this.drawArgsBindGroup);
      pass.dispatchWorkgroups(1, 1, 1);

      pass.end();
    }

    if (slot >= 0) {
      encoder.copyBufferToBuffer(
        this.atomicCounterBuffer,
        0,
        this.statsStagingBuffers[slot],
        0,
        4,
      );
      encoder.copyBufferToBuffer(
        this.changeCounterBuffer,
        0,
        this.changeStagingBuffers[slot],
        0,
        4,
      );
    }

    this.device.queue.submit([encoder.finish()]);

    // Extract does not advance generation; stats correspond to the current generation number.
    const gen = this.generation;
    if (slot >= 0) {
      const p = this.startReadback(slot, gen);
      if (syncStats) {
        await p;
      }
    }
  }
  setSurviveRule(c) {
    this.surviveRule = 0;
    for (const n of c) if (n >= 0 && n <= 26) this.surviveRule |= 1 << n;
  }
  setBirthRule(c) {
    this.birthRule = 0;
    for (const n of c) if (n >= 0 && n <= 26) this.birthRule |= 1 << n;
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
    this.cellColorTop = [
      parseInt(topHex.substr(1, 2), 16) / 255,
      parseInt(topHex.substr(3, 2), 16) / 255,
      parseInt(topHex.substr(5, 2), 16) / 255,
    ];
    this.cellColorBottom = [
      parseInt(bottomHex.substr(1, 2), 16) / 255,
      parseInt(bottomHex.substr(3, 2), 16) / 255,
      parseInt(bottomHex.substr(5, 2), 16) / 255,
    ];
  }
  setBackgroundColors(topHex, bottomHex) {
    this.bgColorTop = [
      parseInt(topHex.substr(1, 2), 16) / 255,
      parseInt(topHex.substr(3, 2), 16) / 255,
      parseInt(topHex.substr(5, 2), 16) / 255,
    ];
    this.bgColorBottom = [
      parseInt(bottomHex.substr(1, 2), 16) / 255,
      parseInt(bottomHex.substr(3, 2), 16) / 255,
      parseInt(bottomHex.substr(5, 2), 16) / 255,
    ];
  }

  setLanternLightingEnabled(enabled) {
    this.lanternEnabled = enabled ? 1.0 : 0.0;
  }

  setGridProjectionEnabled(enabled) {
    this.gridProjectionEnabled = enabled ? 1.0 : 0.0;
  }

  // Grid projection faces are static (6 faces) and are re-generated only when
  // gridSize/cellSize changes. Visibility is handled by inward-facing winding + culling.
  updateGridProjectionFaces() {
    // Kept for backwards compatibility with older call sites.
    this.rebuildGridProjectionInstances();
  }

  setLanternStrength(strength) {
    // Clamp to sensible range
    const s = Math.max(0.0, Math.min(2.0, Number(strength)));
    this.lanternStrength = isFinite(s) ? s : this.lanternStrength;
  }

  render() {
    // Update frame uniforms (camera + background) once per frame.
    updateFrameUniformsImpl(this);

    const encoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          loadOp: "clear",
          clearValue: {
            r: this.bgColorBottom[0],
            g: this.bgColorBottom[1],
            b: this.bgColorBottom[2],
            a: 1.0,
          },
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTextureView,
        depthLoadOp: "clear",
        depthClearValue: 1.0,
        depthStoreOp: "store",
      },
    });

    pass.setPipeline(this.bgPipeline);
    pass.setBindGroup(0, this.bgBindGroup);
    pass.draw(3);

    // Camera uniforms were already updated at the start of render().

    // Optional subtle projection of the outer grid box (drawn blended over the background).
    if (
      this.gridProjectionEnabled > 0.5 &&
      this.gridProjPipeline &&
      this.gridProjBindGroup &&
      this.gridProjInstanceBuffer
    ) {
      if (this.gridProjInstanceCount > 0) {
        pass.setPipeline(this.gridProjPipeline);
        pass.setBindGroup(0, this.gridProjBindGroup);
        pass.setVertexBuffer(0, this.gridProjInstanceBuffer);
        pass.draw(6, this.gridProjInstanceCount);
      }
    }

    // Cell pass (GPU-driven instance count)
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.cellBindGroup);
    pass.setVertexBuffer(0, this.cubeVertexBuffer);
    pass.setIndexBuffer(this.cubeIndexBuffer, "uint16");
    pass.drawIndexedIndirect(this.indirectArgsBuffer, 0);

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  updateUniforms() {
    // Kept for backwards compatibility with older call sites.
    // Prefer calling updateFrameUniformsImpl() from render().
    updateRenderUniformsImpl(this);
  }

  resize(options = {}) {
    const force = !!options.force;
    const dpr =
      typeof window !== "undefined" && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1;

    // clientWidth/clientHeight are CSS pixels. Multiply by devicePixelRatio for the backing store size.
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));

    if (
      !force &&
      w === this._lastCanvasW &&
      h === this._lastCanvasH &&
      dpr === this._lastDpr
    ) {
      return false;
    }

    this._lastDpr = dpr;
    this._lastCanvasW = w;
    this._lastCanvasH = h;

    this.canvas.width = w;
    this.canvas.height = h;

    // Reconfigure the swapchain so the drawable texture matches the new canvas size.
    // Some implementations accept an explicit `size`; others infer from canvas.width/height.
    if (this.context && this._canvasConfig) {
      const baseCfg = Object.assign({}, this._canvasConfig);
      try {
        this.context.configure(Object.assign({ size: [w, h] }, baseCfg));
      } catch (_) {
        // Fallback: configure without `size`.
        this.context.configure(baseCfg);
      }
    }

    // Recreate depth buffer to match the new render target size.
    if (this.depthTexture) {
      try {
        this.depthTexture.destroy();
      } catch (_) {}
    }
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTextureView = this.depthTexture.createView();
    return true;
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
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Suppress teardown-time warnings from async readback helpers.
    this._suppressAsyncErrors = true;

    const tryDestroy = (obj) => {
      try {
        if (obj && typeof obj.destroy === "function") obj.destroy();
      } catch (_) {}
    };

    // Grid-sized resources (including readback rings and AABB staging).
    try {
      destroyGridResourcesImpl(this);
    } catch (_) {}

    // Per-app resources
    tryDestroy(this.cubeVertexBuffer);
    this.cubeVertexBuffer = null;
    tryDestroy(this.cubeIndexBuffer);
    this.cubeIndexBuffer = null;

    tryDestroy(this.uniformBuffer);
    this.uniformBuffer = null;

    tryDestroy(this.indirectArgsBuffer);
    this.indirectArgsBuffer = null;
    tryDestroy(this.drawArgsParamsBuffer);
    this.drawArgsParamsBuffer = null;

    tryDestroy(this.gridProjInstanceBuffer);
    this.gridProjInstanceBuffer = null;

    tryDestroy(this.depthTexture);
    this.depthTexture = null;
    this.depthTextureView = null;

    // Pipelines/bind groups/shader modules do not have explicit destroy calls,
    // but clearing references allows GC to reclaim associated JS objects.
    this.bgPipeline = null;
    this.renderPipeline = null;
    this.computePipeline = null;
    this.extractPipeline = null;
    this.initPipeline = null;
    this.drawArgsPipeline = null;
    this.aabbPipeline = null;
    this.aabbArgsPipeline = null;
    this.gridProjPipeline = null;

    this.bgBindGroup = null;
    this.cellBindGroup = null;
    this.drawArgsBindGroup = null;
    this.gridProjBindGroup = null;
    this.computeBindGroups = [null, null];
    this.extractBindGroups = [null, null];
    this.initBindGroups = [null, null];

    try {
      this._shaderModuleCache.clear();
    } catch (_) {}
    this._ensureEssentialPipelinesPromise = null;
    this._ensureAabbPipelinesPromise = null;

    // Drop WebGPU device/context references.
    this._canvasConfig = null;
    this.context = null;
    this.device = null;
    this.onDeviceLost = null;

    // Release BufferManager scratch references (and detach device).
    try {
      if (this._buffers && typeof this._buffers.destroy === "function") {
        this._buffers.destroy();
      } else if (this._buffers && typeof this._buffers.setDevice === "function") {
        this._buffers.setDevice(null);
      }
    } catch (_) {}
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

  /**
   * Internal helper retained for readability during init/reset.
   * Prefer calling cameraControls.setQuatFromEuler() directly from new code.
   */
  setQuatFromEuler(yaw, pitch) {
    setQuatFromEulerImpl(this, yaw, pitch);
  }
}
