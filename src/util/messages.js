/**
 * Standardized log message strings.
 *
 * These strings are used as the first argument to console logging helpers so that
 * logs remain searchable and consistent across modules.
 *
 * User-facing UI strings are centralized separately in src/app/messages.js (UI_MSG).
 */
export const LOG_MSG = Object.freeze({
  WEBGPU_DEVICE_LOST: "WebGPU device lost:",
  WEBGPU_INIT_FAILED: "WebGPU initialization failed:",
  INIT_FAILED: "Failed to initialize:",

  STEP_FAILED: "Step failed:",
  SIM_STEP_ERROR: "Simulation step error:",

  GRID_ALLOC_FALLBACK: "Failed to allocate grid resources; falling back to a smaller grid size:",
  RECOVER_INIT_SIZE_FAILED: "Failed to recover after init size error:",

  AABB_PIPELINE_FAILED: "AABB pipeline compilation failed; Screen show targeting will be disabled",

  BUFFER_UNREGISTERED_WRITE:
    "G3DL debug: writeBuffer() called on an unregistered buffer; size validation skipped. " +
    "Prefer creating buffers via the renderer buffer helpers.",
});
