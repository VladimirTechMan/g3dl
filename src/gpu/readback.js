/**
 * GPU -> CPU readback helpers.
 *
 * This module centralizes "mapAsync / getMappedRange" logic and ring-buffer
 * scheduling so renderer.js can stay focused on orchestration.
 */

import { debugWarn } from "../util/log.js";

/**
 * Create the staging buffers and internal ring state used for CPU readback.
 *
 * Allocates:
 *  - populationReadbackBuffers (small ring for fast HUD updates)
 *  - statsStagingBuffers (ring for per-step population)
 *  - changeStagingBuffers (ring for per-step change flag)
 *
 * Also (re)initializes associated bookkeeping fields.
 *
 * @param {import('./renderer.js').WebGPURenderer} r
 */
export function createReadbackResources(r) {
  // Lightweight population-only readback ring (independent of throttled stats ring).
  const POP_RB = 2;
  r.populationReadbackBuffers = new Array(POP_RB);
  for (let i = 0; i < POP_RB; i++) {
    r.populationReadbackBuffers[i] = r._createBuffer(`populationReadbackBuffer[${i}]`, {
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }
  r.populationReadbackPending = false;
  r.populationReadbackPromise = null;
  r.populationReadbackSlot = 0;
  r.populationReadbackLastTimeMs = 0;
  r.populationValidGeneration = -1;

  // Stats readback ring buffers (population + change flag)
  const RING = 3;
  r.statsStagingBuffers = new Array(RING);
  r.changeStagingBuffers = new Array(RING);
  r.readbackPending = new Array(RING).fill(false);
  r.readbackPromises = new Array(RING).fill(null);
  r.nextReadbackSlot = 0;
  for (let i = 0; i < RING; i++) {
    r.statsStagingBuffers[i] = r._createBuffer(`statsStagingBuffer[${i}]`, {
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    r.changeStagingBuffers[i] = r._createBuffer(`changeStagingBuffer[${i}]`, {
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  resetReadbackTiming(r);
}

/**
 * Reset readback timing fields (called after grid resize).
 * @param {import('./renderer.js').WebGPURenderer} r
 */
function resetReadbackTiming(r) {
  // Use -1 to indicate "no valid readback" yet.
  r.statsValidGeneration = -1;
  r.lastReadbackTimeMs = 0;
  r.lastReadbackGeneration = -1;
}

/**
 * Destroy readback buffers.
 * @param {import('./renderer.js').WebGPURenderer} r
 * @param {(b:GPUBuffer)=>void} tryUnmap
 * @param {(b:GPUBuffer)=>void} tryDestroy
 */
export function destroyReadbackResources(r, tryUnmap, tryDestroy) {
  if (r.statsStagingBuffers) {
    for (const b of r.statsStagingBuffers) {
      tryUnmap(b);
      tryDestroy(b);
    }
  }
  if (r.changeStagingBuffers) {
    for (const b of r.changeStagingBuffers) {
      tryUnmap(b);
      tryDestroy(b);
    }
  }
  r.statsStagingBuffers = null;
  r.changeStagingBuffers = null;

  r.readbackPending = null;
  r.readbackPromises = null;
  r.nextReadbackSlot = 0;

  if (r.populationReadbackBuffers) {
    for (const b of r.populationReadbackBuffers) {
      tryUnmap(b);
      tryDestroy(b);
    }
  }
  r.populationReadbackBuffers = null;
  r.populationReadbackPending = false;
  r.populationReadbackPromise = null;
  r.populationReadbackSlot = 0;
  r.populationReadbackLastTimeMs = 0;
  r.populationValidGeneration = -1;
}

/**
 * Decide whether we should schedule a stats readback on this step.
 * @param {import('./renderer.js').WebGPURenderer} r
 * @param {boolean} force
 */
export function _shouldReadbackStats(r, force) {
  if (force) return true;
  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  if (r.generation - r.lastReadbackGeneration >= r.readbackEveryNSteps) return true;
  if (now - r.lastReadbackTimeMs >= r.readbackMinIntervalMs) return true;
  return false;
}

/**
 * Find an available slot in the stats readback ring.
 * @param {import('./renderer.js').WebGPURenderer} r
 * @param {boolean} forceWait
 */
export async function _acquireReadbackSlot(r, forceWait) {
  const n = r.statsStagingBuffers ? r.statsStagingBuffers.length : 0;
  if (n === 0) return -1;

  for (let i = 0; i < n; i++) {
    const idx = (r.nextReadbackSlot + i) % n;
    if (!r.readbackPending[idx]) {
      r.nextReadbackSlot = (idx + 1) % n;
      return idx;
    }
  }

  if (!forceWait) return -1;

  const promises = (r.readbackPromises || []).filter(Boolean);
  if (promises.length === 0) return -1;
  await Promise.race(promises);
  return _acquireReadbackSlot(r, false);
}

/**
 * Map the stats staging buffers for a slot and update renderer state.
 * @param {import('./renderer.js').WebGPURenderer} r
 * @param {number} slot
 * @param {number} stepGeneration
 */
export function _startReadback(r, slot, stepGeneration) {
  const popBuf = r.statsStagingBuffers[slot];
  const chgBuf = r.changeStagingBuffers[slot];

  try {
    popBuf.unmap();
  } catch (_) {}
  try {
    chgBuf.unmap();
  } catch (_) {}

  r.readbackPending[slot] = true;

  const p = Promise.all([
    popBuf.mapAsync(GPUMapMode.READ),
    chgBuf.mapAsync(GPUMapMode.READ),
  ])
    .then(() => {
      const pop = new Uint32Array(popBuf.getMappedRange())[0];
      const changeCount = new Uint32Array(chgBuf.getMappedRange())[0];
      popBuf.unmap();
      chgBuf.unmap();

      r.population = pop;
      r.lastStepChanged = changeCount > 0;
      r.statsValidGeneration = stepGeneration;

      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      r.lastReadbackTimeMs = now;
      r.lastReadbackGeneration = stepGeneration;
    })
    .catch((e) => {
      // In normal operation, surface readback failures because they can hint at
      // device loss, invalid buffer states, or backend bugs.
      //
      // During teardown (renderer.destroy()), buffers may be destroyed while
      // mapAsync() is still pending; suppress warnings in that case.
      if (!r._suppressAsyncErrors) {
        debugWarn("Stats readback failed:", e);
      }
      try {
        popBuf.unmap();
      } catch (_) {}
      try {
        chgBuf.unmap();
      } catch (_) {}
    })
    .finally(() => {
      r.readbackPending[slot] = false;
    });

  r.readbackPromises[slot] = p;
  return p;
}

/**
 * Lightweight population-only readback.
 *
 * @param {import('./renderer.js').WebGPURenderer} r
 * @param {boolean} force
 * @returns {Promise<null|{population:number,generation:number}>}
 */
export function requestPopulationReadback(r, force = false) {
  if (
    !r.device ||
    !r.atomicCounterBuffer ||
    !r.populationReadbackBuffers ||
    r.populationReadbackBuffers.length === 0
  ) {
    return Promise.resolve(null);
  }

  if (r.populationReadbackPending) {
    return r.populationReadbackPromise || Promise.resolve(null);
  }

  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  if (!force && now - r.populationReadbackLastTimeMs < r.populationReadbackMinIntervalMs) {
    return Promise.resolve(null);
  }

  r.populationReadbackLastTimeMs = now;

  const slot = r.populationReadbackSlot++ % r.populationReadbackBuffers.length;
  const staging = r.populationReadbackBuffers[slot];
  const generationAtSubmit = r.generation;

  try {
    staging.unmap();
  } catch (_) {}

  const enc = r.device.createCommandEncoder();
  enc.copyBufferToBuffer(r.atomicCounterBuffer, 0, staging, 0, 4);
  r.device.queue.submit([enc.finish()]);

  r.populationReadbackPending = true;

  const p = staging
    .mapAsync(GPUMapMode.READ)
    .then(() => {
      const pop = new Uint32Array(staging.getMappedRange())[0] >>> 0;
      staging.unmap();

      r.population = pop;
      r.populationValidGeneration = generationAtSubmit;

      return { population: pop, generation: generationAtSubmit };
    })
    .catch(() => {
      try {
        staging.unmap();
      } catch (_) {}
      return null;
    })
    .finally(() => {
      r.populationReadbackPending = false;
      r.populationReadbackPromise = null;
    });

  r.populationReadbackPromise = p;
  return p;
}
