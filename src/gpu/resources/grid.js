import { G3DL_LAYOUT } from "../dataLayout.js";
import {
  createReadbackResources,
  destroyReadbackResources,
} from "../readback.js";

/**
 * Grid resource lifecycle helpers.
 *
 * This module owns creation and destruction of the buffers that scale with gridSize:
 *  - ping-pong cell state buffers
 *  - living cell instance list + atomic counters
 *  - per-grid parameter buffers
 *  - readback staging buffers (population/stats)
 *  - AABB readback resources (optional Screen show feature)
 */

/**
 * Destroy all grid-sized GPU resources.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 */
export function destroyGridResources(r) {
  const tryUnmap = (b) => {
    try {
      if (b) b.unmap();
    } catch (_) {}
  };
  const tryDestroy = (b) => {
    try {
      if (b) b.destroy();
    } catch (_) {}
  };

  // Grid state buffers
  if (r.gridBuffers) {
    for (let i = 0; i < r.gridBuffers.length; i++) {
      tryDestroy(r.gridBuffers[i]);
      r.gridBuffers[i] = null;
    }
  }

  // Living cell list + counters
  tryDestroy(r.livingCellsBuffer);
  r.livingCellsBuffer = null;
  tryDestroy(r.atomicCounterBuffer);
  r.atomicCounterBuffer = null;
  tryDestroy(r.changeCounterBuffer);
  r.changeCounterBuffer = null;

  // Readback staging buffers (may have been mapped)
  destroyReadbackResources(r, tryUnmap, tryDestroy);

  // AABB staging buffers (may have been mapped)
  if (r.aabbStagingBuffers) {
    for (const b of r.aabbStagingBuffers) {
      tryUnmap(b);
      tryDestroy(b);
    }
  }
  r.aabbStagingBuffers = null;
  tryDestroy(r.aabbBuffer);
  r.aabbBuffer = null;
  tryDestroy(r.aabbDispatchArgsBuffer);
  r.aabbDispatchArgsBuffer = null;
  r.aabbBindGroup = null;
  r.aabbArgsBindGroup = null;
  r.aabbReadbackPending = false;
  r.aabbReadbackPromise = null;
  r.lastAabb = null;

  // Per-grid parameter buffers
  tryDestroy(r.computeParamsBuffer);
  r.computeParamsBuffer = null;
  tryDestroy(r.extractParamsBuffer);
  r.extractParamsBuffer = null;
  tryDestroy(r.initParamsBuffer);
  r.initParamsBuffer = null;

  // Reset derived state
  r.maxCells = 0;
  r.population = 0;
}

/**
 * Allocate all grid-sized buffers for the current gridSize.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 */
export function createGridBuffers(r) {
  // Clean up old GPU resources to avoid leaks when resizing the grid
  destroyGridResources(r);

  const total = r.gridSize ** 3;

  for (let i = 0; i < 2; i++) {
    r.gridBuffers[i] = r._createBuffer(`gridBuffer[${i}]`, {
      size: total * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  const maxCells = total;
  r.livingCellsBuffer = r._createBuffer("livingCellsBuffer", {
    size: maxCells * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  r.maxCells = maxCells;

  r.atomicCounterBuffer = r._createBuffer("atomicCounterBuffer", {
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  r.changeCounterBuffer = r._createBuffer("changeCounterBuffer", {
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  r.lastStepChanged = true;

  // Readback staging rings depend on the counter buffers.
  createReadbackResources(r);

  // AABB readback resources (optional Screen show camera targeting)
  r.aabbDispatchArgsBuffer = r._createBuffer("aabbDispatchArgsBuffer", {
    size: G3DL_LAYOUT.INDIRECT.DISPATCH_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });

  r.aabbBuffer = r._createBuffer("aabbBuffer", {
    size: G3DL_LAYOUT.AABB.BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  const AABB_RING = 2;
  const AABB_STAGING_SIZE = 48;
  r.aabbStagingBuffers = new Array(AABB_RING);
  for (let i = 0; i < AABB_RING; i++) {
    r.aabbStagingBuffers[i] = r._createBuffer(`aabbStagingBuffer[${i}]`, {
      size: AABB_STAGING_SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }
  r.aabbReadbackSlot = 0;
  r.aabbReadbackPending = false;
  r.aabbReadbackPromise = null;
  r.lastAabb = null;

  // Update indirect draw args params (maxCells may have changed)
  r._updateDrawArgsParams();

  // Per-grid parameter buffers
  r.computeParamsBuffer = r._createBuffer("computeParamsBuffer", {
    size: G3DL_LAYOUT.PARAMS.SIM.BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  r.extractParamsBuffer = r._createBuffer("extractParamsBuffer", {
    size: G3DL_LAYOUT.PARAMS.EXTRACT.BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  r.initParamsBuffer = r._createBuffer("initParamsBuffer", {
    // NOTE: INIT and SIM parameter blocks are currently the same size, but they are
    // semantically different (and may diverge in the future). Allocate using the
    // INIT layout constant so that any future layout changes cannot silently
    // under-allocate this buffer.
    size: G3DL_LAYOUT.PARAMS.INIT.BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}
