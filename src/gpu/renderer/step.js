import { G3DL_LAYOUT } from "../dataLayout.js";

/**
 * Simulation-step helpers.
 *
 * This module intentionally operates on a WebGPURenderer instance `r`.
 * It does not create or own GPU resources; it only encodes compute passes
 * using resources already created by the renderer.
 */

/**
 * GPU queue pacing helper.
 *
 * In fast-play modes, the CPU may submit simulation steps faster than the GPU can execute them.
 * This can increase input latency and, on some mobile browsers, lead to device loss due to
 * memory pressure from queued work.
 *
 * This helper lives in step.js because it is part of the step-submission policy.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 * @param {boolean} [force=false]
 */
async function maybePace(r, force = false) {
  if (!r.device || !r.device.queue || typeof r.device.queue.onSubmittedWorkDone !== "function") {
    return;
  }

  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  const dueBySteps = r._stepsSincePace >= r._paceEveryNSteps;
  const dueByTime = now - r._lastPaceTimeMs >= r._paceMinIntervalMs;

  if (force || dueBySteps || dueByTime) {
    r._stepsSincePace = 0;
    r._lastPaceTimeMs = now;
    try {
      await r.device.queue.onSubmittedWorkDone();
    } catch (_) {
      // Ignore device-lost / transient failures; caller handles the overall error path.
    }
  }
}


function writeStepParams(r) {
  // Update per-step simulation parameters
  const simP = G3DL_LAYOUT.PARAMS.SIM.U32;
  r._computeParams[simP.GRID_SIZE] = r.gridSize;
  r._computeParams[simP.SURVIVE_RULE] = r.surviveRule;
  r._computeParams[simP.BIRTH_RULE] = r.birthRule;
  r._computeParams[simP.TOROIDAL] = r.toroidal ? 1 : 0;
  r._computeParams[simP.CHANGE_ENABLED] = r.enableChangeDetection ? 1 : 0;
  // PAD0..PAD2 are zero-initialized and never mutated.
  r._queueWriteU32(r.computeParamsBuffer, 0, r._computeParams);

  // Update per-step extraction parameters (maxCells affects draw clamping)
  const extP = G3DL_LAYOUT.PARAMS.EXTRACT.U32;
  r._extractParams[extP.GRID_SIZE] = r.gridSize;
  r._extractParams[extP.MAX_CELLS] = r.maxCells;
  // PAD0..PAD1 are zero-initialized and never mutated.
  r._queueWriteU32(r.extractParamsBuffer, 0, r._extractParams);
}

function resetExtractAndChangeCounters(r) {
  // Reset population counter and change-flag.
  r._queueWriteU32(r.atomicCounterBuffer, 0, r._u32_0);
  if (r.enableChangeDetection) {
    r._queueWriteU32(r.changeCounterBuffer, 0, r._u32_0);
  } else {
    // Keep the change-flag non-zero so play mode never auto-stops due to stability.
    r._queueWriteU32(r.changeCounterBuffer, 0, r._u32_1);
  }
}

function computeWorkgroups(r) {
  return {
    wgX: Math.ceil(r.gridSize / r.workgroupSize.x),
    wgY: Math.ceil(r.gridSize / r.workgroupSize.y),
    wgZ: Math.ceil(r.gridSize / r.workgroupSize.z),
  };
}

/**
 * Encode simulation+extraction+indirect-args compute passes.
 *
 * Pass separation is intentional: it makes data dependencies explicit and relies only
 * on WebGPU's pass-to-pass visibility guarantees (portable across backends/drivers).
 */
function encodeStepPasses(r, encoder, prevBufIdx, nextBufIdx, wg) {
  // Simulation
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(r.computePipeline);
    pass.setBindGroup(0, r.computeBindGroups[prevBufIdx]);
    pass.dispatchWorkgroups(wg.wgX, wg.wgY, wg.wgZ);
    pass.end();
  }

  // Extraction
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(r.extractPipeline);
    pass.setBindGroup(0, r.extractBindGroups[nextBufIdx]);
    pass.dispatchWorkgroups(wg.wgX, wg.wgY, wg.wgZ);
    pass.end();
  }

  // Indirect args
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(r.drawArgsPipeline);
    pass.setBindGroup(0, r.drawArgsBindGroup);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }
}

export async function stepSimulation(r, options = {}) {
  const syncStats = !!options.syncStats;
  const pace = options.pace !== false;

  const prev = r.currentBuffer;
  const next = 1 - prev;
  const wg = computeWorkgroups(r);

  writeStepParams(r);
  resetExtractAndChangeCounters(r);

  // Schedule a readback only when needed (or if sync requested)
  const doReadback = r._shouldReadbackStats(syncStats);
  let slot = -1;
  if (doReadback) {
    slot = await r._acquireReadbackSlot(syncStats);
  }

  const encoder = r.device.createCommandEncoder();
  encodeStepPasses(r, encoder, prev, next, wg);

  const stepGeneration = r.generation + 1;

  if (slot >= 0) {
    encoder.copyBufferToBuffer(r.atomicCounterBuffer, 0, r.statsStagingBuffers[slot], 0, 4);
    encoder.copyBufferToBuffer(r.changeCounterBuffer, 0, r.changeStagingBuffers[slot], 0, 4);
  }

  r.device.queue.submit([encoder.finish()]);

  // Optional pacing to keep the GPU submission queue bounded.
  if (pace) {
    r._stepsSincePace++;
    await maybePace(r, false);
  }

  // Swap buffers and advance generation
  r.currentBuffer = next;
  r.generation = stepGeneration;

  if (slot >= 0) {
    const p = r._startReadback(slot, stepGeneration);
    if (syncStats) {
      await p;
      return r.lastStepChanged;
    }
  }

  // In async mode, return the most recent known value (may lag)
  return r.lastStepChanged;
}

export async function randomizeGrid(r, density = 0.15, initSize = null) {
  const size = r.gridSize;
  const region = Math.min(initSize || size, size);
  const off = Math.floor((size - region) / 2);

  // Convert density (0..1) to a u32 threshold for comparison.
  const d = Math.max(0, Math.min(1, Number(density) || 0));
  const threshold = Math.min(0xffffffff, Math.max(0, Math.floor(d * 4294967295)));

  // Seed changes per reset for a new random field.
  const seed =
    ((typeof performance !== "undefined" && performance.now
      ? Math.floor(performance.now() * 1000)
      : Date.now()) ^
      Math.floor(Math.random() * 0xffffffff)) >>>
    0;

  const initP = G3DL_LAYOUT.PARAMS.INIT.U32;
  r._initParams[initP.GRID_SIZE] = size;
  r._initParams[initP.REGION] = region;
  r._initParams[initP.OFFSET] = off;
  r._initParams[initP.THRESHOLD] = threshold >>> 0;
  r._initParams[initP.SEED] = seed;
  // PAD0..PAD2 are zero-initialized and never mutated.
  r._queueWriteU32(r.initParamsBuffer, 0, r._initParams);

  const wg = computeWorkgroups(r);

  // Prepare extraction parameters and counters up front.
  const extP = G3DL_LAYOUT.PARAMS.EXTRACT.U32;
  r._extractParams[extP.GRID_SIZE] = r.gridSize;
  r._extractParams[extP.MAX_CELLS] = r.maxCells;
  // PAD0..PAD1 are zero-initialized and never mutated.
  r._queueWriteU32(r.extractParamsBuffer, 0, r._extractParams);

  // Reset population counter before the extract pass runs.
  r._queueWriteU32(r.atomicCounterBuffer, 0, r._u32_0);
  // Force the change-flag true so UI state (e.g., auto-stop) cannot latch onto a stale 0.
  r._queueWriteU32(r.changeCounterBuffer, 0, r._u32_1);

  // Randomization should update UI state immediately, so we sync stats here.
  const syncStats = true;
  const slot = await r._acquireReadbackSlot(syncStats);

  const encoder = r.device.createCommandEncoder();

  // 1) Initialize the grid
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(r.initPipeline);
    pass.setBindGroup(0, r.initBindGroups[r.currentBuffer]);
    pass.dispatchWorkgroups(wg.wgX, wg.wgY, wg.wgZ);
    pass.end();
  }

  // 2) Extract living cells for rendering
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(r.extractPipeline);
    pass.setBindGroup(0, r.extractBindGroups[r.currentBuffer]);
    pass.dispatchWorkgroups(wg.wgX, wg.wgY, wg.wgZ);
    pass.end();
  }

  // 3) Build indirect draw args (clamps instance count to maxCells)
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(r.drawArgsPipeline);
    pass.setBindGroup(0, r.drawArgsBindGroup);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }

  if (slot >= 0) {
    encoder.copyBufferToBuffer(r.atomicCounterBuffer, 0, r.statsStagingBuffers[slot], 0, 4);
    encoder.copyBufferToBuffer(r.changeCounterBuffer, 0, r.changeStagingBuffers[slot], 0, 4);
  }

  r.device.queue.submit([encoder.finish()]);

  // Randomization resets the simulation timeline.
  r.population = 0;
  r.generation = 0;
  r.lastStepChanged = true;

  // Stats correspond to generation 0.
  if (slot >= 0) {
    await r._startReadback(slot, 0);
  }
}
