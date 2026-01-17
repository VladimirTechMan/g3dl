/**
 * Centralized user-facing UI messages.
 *
 * Rationale:
 * - Keeps user-visible strings consistent across the app.
 * - Makes it easier to revise wording without hunting through logic.
 * - Reduces the chance of subtle mismatches between similar error paths.
 */

export const UI_MSG = {
  clipboard: {
    failed:
      "Copy failed. Your browser may block clipboard access. Try again or enable clipboard permissions.",
  },

  sim: {
    stepFailed:
      "Simulation failed to advance (GPU step error). Reload the page. If this keeps happening on a specific device/browser, please report it.",

    stopToApply: {
      gridSize: "Stop the simulation to apply grid size changes.",
      initSize: "Stop the simulation to apply initial size changes.",
      density: "Stop the simulation to apply Gen0 density changes.",
    },

    recoverFailed: "Unable to recover after a GPU allocation error. Reload the page.",
  },

  gpu: {
    allocGeneric:
      "Unable to allocate GPU resources for these settings. Try a smaller grid size or lower Gen0 density.",

    gridSizeClamped: (max) =>
      `Grid size clamped to ${max} due to GPU limits on this device.`,

    gridSizeReduced: (size) => `Grid size reduced to ${size} due to GPU limits.`,

    gridSizeAllocFail: (requested, revertedTo) =>
      `Unable to allocate GPU resources for grid size ${requested}. Reverted to ${revertedTo}. Try a smaller grid size.`,

    initSizeClampedMin: "Initial size must be at least 2. Clamped to 2.",

    initSizeClampedMax: (max) =>
      `Initial size clamped to ${max} (cannot exceed grid size).`,

    initSizeApplyFail: (requested, revertedTo) =>
      `Unable to apply initial size ${requested}. Reverted to ${revertedTo}. Try a smaller grid size.`,

    densityApplyFail: (requestedPct, revertedPct) =>
      `Unable to apply density ${requestedPct}%. Reverted to ${revertedPct}%. Try lowering density or reducing grid size.`,
  },

  rules: {
    invalid: (which) =>
      `Invalid ${which} rule. Use numbers 0–26, separated by commas, and ranges like 5-7.`,
  },
};
