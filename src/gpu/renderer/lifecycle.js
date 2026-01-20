import { G3DL_LAYOUT } from "../dataLayout.js";
import { MAX_PACKED_GRID_SIZE } from "../constants.js";
import { _destroyGridResources as destroyGridResourcesImpl } from "../resources/grid.js";
import { debugLog, debugWarn, error } from "../../util/log.js";
import { LOG_MSG } from "../../util/messages.js";
import { getCaps } from "../../util/caps.js";

/**
 * Renderer lifecycle helpers.
 *
 * The WebGPURenderer class is intentionally a high-level orchestrator. These
 * functions keep its core lifecycle methods readable by moving their sizeable
 * implementations into focused modules.
 *
 * IMPORTANT: These functions are pure refactors; they are not intended to change
 * runtime behavior.
 */

/**
 * Initialize WebGPU, allocate persistent buffers, and compile the essential pipelines.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 * @returns {Promise<boolean>}
 */
export async function initRenderer(r) {
  if (!navigator.gpu) throw new Error("WebGPU not supported");

  let adapter = null;
  for (const delay of [0, 100, 300, 500]) {
    if (delay > 0) await new Promise((res) => setTimeout(res, delay));
    adapter = await navigator.gpu.requestAdapter();
    if (adapter) break;
  }
  if (!adapter) throw new Error("No GPU adapter found");

  // Capability negotiation:
  // WebGPU implementations may expose adapter.limits that are higher than the default device limits.
  // Requesting the adapter maximums is unnecessary (and some drivers reject oversized requests).
  //
  // Policy: request only what we *actually* need for our supported grid-size cap, then fall back
  // to default limits if the implementation rejects the request.
  //
  // Today the UI clamps gridSize to <= 256 and rendering packs per-axis coordinates, so we
  // negotiate buffer limits sufficient for a 256^3 u32 grid buffer (and a same-sized live-cell list).
  const limits = adapter.limits;

  // Largest single STORAGE buffer we expect to bind, in bytes.
  //  - grid buffer: gridSize^3 * 4 bytes (u32)
  //  - livingCellsBuffer: same size (worst case: every cell alive)
  const TARGET_GRID_SIZE = Math.min(256, MAX_PACKED_GRID_SIZE);
  const REQUIRED_STORAGE_BYTES = TARGET_GRID_SIZE ** 3 * 4;

  // Small alignment to avoid edge-case rejection on some implementations (not required by spec,
  // but harmless and keeps requested values "round").
  const alignUp = (n, a) => Math.ceil(n / a) * a;
  const requiredBytes = alignUp(REQUIRED_STORAGE_BYTES, 256);

  const requiredLimits = {};
  if (
    typeof limits.maxStorageBufferBindingSize === "number" &&
    limits.maxStorageBufferBindingSize >= requiredBytes
  ) {
    requiredLimits.maxStorageBufferBindingSize = requiredBytes;
  }
  if (
    typeof limits.maxBufferSize === "number" &&
    limits.maxBufferSize >= requiredBytes
  ) {
    requiredLimits.maxBufferSize = requiredBytes;
  }

  const deviceDesc = Object.keys(requiredLimits).length ? { requiredLimits } : {};
  try {
    r.device = await adapter.requestDevice(deviceDesc);
  } catch (e) {
    debugWarn(
      "requestDevice with requiredLimits failed; retrying with defaults",
      e,
    );
    r.device = await adapter.requestDevice();
  }

  // BufferManager must be attached to the newly created device before any resource allocation.
  // (We create several buffers immediately after this during init.)
  r._buffers.setDevice(r.device);

  r._caps.pipelineAsync =
    typeof r.device.createComputePipelineAsync === "function" &&
    typeof r.device.createRenderPipelineAsync === "function";

  // Device loss can happen on mobile (backgrounding, memory pressure, driver reset).
  // Surface this to the app so it can stop the simulation and prompt the user.
  r.device.lost.then((info) => {
    r.deviceLost = true;
    error(LOG_MSG.WEBGPU_DEVICE_LOST, info);
    if (typeof r.onDeviceLost === "function") {
      try {
        r.onDeviceLost(info);
      } catch (e) {
        debugWarn("onDeviceLost callback failed:", e);
      }
    }
  });

  // Configure the AABB reduction kernel size based on device limits.
  r.aabbWorkgroupSize = r._chooseAabbWorkgroupSize();

  // Derive a safe maximum grid size from per-buffer limits (per-binding) AND a conservative total-memory heuristic.
  // One cell = 4 bytes (u32). Each grid buffer is a STORAGE buffer bound in a bind group, so it must satisfy
  // both the per-binding limit (maxStorageBufferBindingSize) and the overall buffer-size limit (maxBufferSize).
  const perBufferLimit = Math.min(
    r.device.limits.maxStorageBufferBindingSize,
    r.device.limits.maxBufferSize ?? r.device.limits.maxStorageBufferBindingSize,
  );

  // Effective byte limit for allocating the ping-pong grid buffers.
  // (Name intentionally avoids confusion with device.limits.maxBufferSize.)
  r.maxGridBufferBytes = perBufferLimit;
  const maxCellsPerBuffer = Math.floor(perBufferLimit / 4);
  const maxGridFromLimits = Math.floor(Math.cbrt(maxCellsPerBuffer));
  let maxGrid = Math.max(4, Math.min(256, maxGridFromLimits));

  // Additional hard safety cap from the packed live-cell coordinate format.
  // (Today we clamp to <= 256 anyway, but we keep this explicit so that future
  // grid-size expansions cannot silently break rendering.)
  maxGrid = Math.min(maxGrid, MAX_PACKED_GRID_SIZE);

  // Conservative, best-effort cap based on expected total GPU memory pressure.
  // WebGPU does not expose total VRAM; this is a heuristic to reduce device-loss on mobile.
  const { isCoarsePointer } = getCaps();
  r._caps.isCoarsePointer = !!isCoarsePointer;

  // Choose portable workgroup sizes for the main grid-wide compute kernels.
  // This must happen before we compile compute pipelines because the workgroup size is baked
  // into the WGSL via @workgroup_size(...).
  r.workgroupSize = r._chooseGridWorkgroupSize();
  if (r.device?.limits && r.workgroupSize) {
    const lim = r.device.limits;
    debugLog(
      "Selected grid compute workgroup size:",
      r.workgroupSize,
      {
        maxInv: lim.maxComputeInvocationsPerWorkgroup,
        maxX: lim.maxComputeWorkgroupSizeX,
        maxY: lim.maxComputeWorkgroupSizeY,
        maxZ: lim.maxComputeWorkgroupSizeZ,
        coarsePointer: r._caps.isCoarsePointer,
      },
    );
  }

  // Mobile-friendly queue pacing.
  // Coarse-pointer devices are typically phones/tablets where over-submitting work can cause
  // latency spikes or even device loss due to memory pressure.
  if (r._caps.isCoarsePointer) {
    r._paceEveryNSteps = 1;
    r._paceMinIntervalMs = 33;
  }

  const budgetBytes = isCoarsePointer ? 128 * 1024 * 1024 : 256 * 1024 * 1024;
  const safetyOverhead =
    16 * 1024 * 1024; // textures, pipelines, backbuffers, driver overhead, etc.
  const budgetUsable = Math.max(32 * 1024 * 1024, budgetBytes - safetyOverhead);

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

  r.maxSupportedGridSize = Math.max(4, Math.min(maxGrid, maxGridByBudget));

  r.context = r.canvas.getContext("webgpu");
  if (!r.context) throw new Error("Failed to get WebGPU context");

  r.format = navigator.gpu.getPreferredCanvasFormat();
  r._canvasConfig = {
    device: r.device,
    format: r.format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    // The canvas is used as a full-screen render target with UI drawn in DOM layers above it.
    // We do not rely on swapchain alpha for compositing with the page, so prefer an opaque
    // swapchain to reduce platform-specific alpha handling and avoid unnecessary blending work.
    alphaMode: "opaque",
  };

  // Configure the canvas and create the depth buffer using the current devicePixelRatio.
  // We re-run this logic on resize/orientation changes to keep the swapchain correct on mobile browsers.
  r.resize({ force: true });

  // Kick off pipeline compilation early, while we allocate buffers.
  const pipelinesPromise = r._ensureEssentialPipelines();
  r._createCubeGeometry();
  r._createUniformBuffer();
  r._createGridBuffers();
  r._createDrawArgsResources();
  // Wait for essential pipelines to be ready before building bind groups.
  await pipelinesPromise;
  r._rebuildBindGroups();

  if (G3DL_LAYOUT.DEBUG) {
    // Validate JS<->WGSL buffer contracts early (debug-only).
    G3DL_LAYOUT.assertRenderer(r);
  }

  return true;
}

/**
 * Resize the swapchain and depth buffer based on the canvas CSS size and devicePixelRatio.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 * @param {{ force?: boolean }=} options
 */
export function resizeRenderer(r, options = {}) {
  const force = !!options.force;
  const dpr =
    typeof window !== "undefined" && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;

  // clientWidth/clientHeight are CSS pixels. Multiply by devicePixelRatio for the backing store size.
  const cssW = r.canvas.clientWidth || r.canvas.width || 1;
  const cssH = r.canvas.clientHeight || r.canvas.height || 1;
  const w = Math.max(1, Math.floor(cssW * dpr));
  const h = Math.max(1, Math.floor(cssH * dpr));

  if (!force && w === r._lastCanvasW && h === r._lastCanvasH && dpr === r._lastDpr) {
    return false;
  }

  r._lastDpr = dpr;
  r._lastCanvasW = w;
  r._lastCanvasH = h;

  r.canvas.width = w;
  r.canvas.height = h;

  // Reconfigure the swapchain so the drawable texture matches the new canvas size.
  // Per WebGPU's usage model, the portable baseline is to size the canvas backing store
  // via canvas.width/height and (re)configure the context without specifying an explicit
  // `size`. Some implementations also accept a `size` field on configure(); we only use it
  // as a last-resort fallback to reduce cross-browser variability.
  if (r.context && r._canvasConfig) {
    const baseCfg = Object.assign({}, r._canvasConfig);
    try {
      r.context.configure(baseCfg);
    } catch (_) {
      // Last resort fallback: configure with an explicit size.
      // (This path should be rare on modern browsers.)
      r.context.configure(Object.assign({ size: [w, h] }, baseCfg));
    }
  }

  // Recreate depth buffer to match the new render target size.
  if (r.depthTexture) {
    try {
      r.depthTexture.destroy();
    } catch (_) {}
  }
  r.depthTexture = r.device.createTexture({
    size: [w, h],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  r.depthTextureView = r.depthTexture.createView();
  return true;
}

/**
 * Destroy GPU resources owned by this renderer.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 */
export function destroyRenderer(r) {
  if (r.isDestroyed) return;
  r.isDestroyed = true;

  // Suppress teardown-time warnings from async readback helpers.
  r._suppressAsyncErrors = true;

  const tryDestroy = (obj) => {
    try {
      if (obj && typeof obj.destroy === "function") obj.destroy();
    } catch (_) {}
  };

  // Grid-sized resources (including readback rings and AABB staging).
  try {
    destroyGridResourcesImpl(r);
  } catch (_) {}

  // Per-app resources
  tryDestroy(r.cubeVertexBuffer);
  r.cubeVertexBuffer = null;
  tryDestroy(r.cubeIndexBuffer);
  r.cubeIndexBuffer = null;

  tryDestroy(r.uniformBuffer);
  r.uniformBuffer = null;

  tryDestroy(r.indirectArgsBuffer);
  r.indirectArgsBuffer = null;
  tryDestroy(r.drawArgsParamsBuffer);
  r.drawArgsParamsBuffer = null;

  tryDestroy(r.gridProjInstanceBuffer);
  r.gridProjInstanceBuffer = null;

  tryDestroy(r.depthTexture);
  r.depthTexture = null;
  r.depthTextureView = null;

  // Pipelines/bind groups/shader modules do not have explicit destroy calls,
  // but clearing references allows GC to reclaim associated JS objects.
  r.bgPipeline = null;
  r.renderPipeline = null;
  r.computePipeline = null;
  r.extractPipeline = null;
  r.initPipeline = null;
  r.drawArgsPipeline = null;
  r.aabbPipeline = null;
  r.aabbArgsPipeline = null;
  r.gridProjPipeline = null;

  r.bgBindGroup = null;
  r.cellBindGroup = null;
  r.drawArgsBindGroup = null;
  r.gridProjBindGroup = null;
  r.computeBindGroups = [null, null];
  r.extractBindGroups = [null, null];
  r.initBindGroups = [null, null];

  try {
    r._shaderModuleCache.clear();
  } catch (_) {}
  r._ensureEssentialPipelinesPromise = null;
  r._ensureAabbPipelinesPromise = null;

  // Drop WebGPU device/context references.
  r._canvasConfig = null;
  r.context = null;
  r.device = null;
  r.onDeviceLost = null;

  // Release BufferManager scratch references (and detach device).
  try {
    if (r._buffers && typeof r._buffers.destroy === "function") {
      r._buffers.destroy();
    } else if (r._buffers && typeof r._buffers.setDevice === "function") {
      r._buffers.setDevice(null);
    }
  } catch (_) {}
}
