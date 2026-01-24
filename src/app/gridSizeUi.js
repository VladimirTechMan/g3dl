/**
 * Grid size and init-size UI controller.
 *
 * Responsibilities:
 * - validate + clamp grid size to device limits
 * - validate + clamp Gen0 init cube edge length
 * - apply Gen0 init-size changes immediately only when the simulation is stopped at generation 0
 * - otherwise store changes and apply them on the next explicit reset (or when grid size is changed while stopped)
 *
 * This module is intentionally deterministic and does not register any event listeners.
 */

import { blurOnEnter, setInvalid } from "./inputUi.js";

/**
 * @typedef {Object} GridSizeControllerDeps
 * @property {HTMLInputElement | null} sizeInput
 * @property {HTMLInputElement | null} initSizeInput
 * @property {{
 *   settings: { gridSize: number, initSize: number, density: number },
 *   sim: { isPlaying: boolean, generation: number, population: number, populationGeneration: number },
 * }} state
 * @property {any} renderer
 * @property {() => Promise<void>} waitForIdle
 * @property {(force?: boolean) => void} requestRender
 * @property {() => void} updateStats
 * @property {() => void} clearStickyError
 * @property {{
 *   show: (args: { kind: "info" | "warn" | "error" | "success", message: string }) => void,
 * }} toast
 * @property {any} uiMsg
 * @property {(msg: any) => void} [debugWarn]
 * @property {(msg: any, err?: any) => void} [error]
 * @property {any} [logMsg]
 */

/**
 * @param {GridSizeControllerDeps} deps
 */
export function createGridSizeController(deps) {
  const {
    sizeInput,
    initSizeInput,
    state,
    renderer,
    waitForIdle,
    requestRender,
    updateStats,
    clearStickyError,
    toast,
    uiMsg,
    debugWarn,
    error,
    logMsg,
  } = deps;

  function getMaxGrid() {
    return renderer && typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;
  }

  /**
   * Handle grid size input change.
   */
  async function handleSizeChange() {
    if (!sizeInput) return;

    const prevSize = state.settings.gridSize;
    let value = parseInt(sizeInput.value, 10);
    const wrapper = sizeInput.parentElement;

    const max = getMaxGrid();

    if (isNaN(value) || value < 4) {
      value = 4;
    }

    let clampedToMax = false;
    if (value > max) {
      value = max;
      clampedToMax = true;
    }

    sizeInput.value = value;
    setInvalid(wrapper, false);

    // Inform the user when the value is clamped due to device limits.
    if (clampedToMax) {
      toast.show({
        kind: "warn",
        message: uiMsg.gpu.gridSizeClamped(max),
      });
    }

    // Keep Gen0 edge HTML constraint in sync with the intended logical maximum.
    if (initSizeInput) initSizeInput.max = String(value);

    if (state.settings.initSize > value) {
      state.settings.initSize = value;
      if (initSizeInput) {
        initSizeInput.value = state.settings.initSize;
        setInvalid(initSizeInput.parentElement, false);
      }
    }

    // Only apply changes if simulation is not running.
    if (!state.sim.isPlaying) {
      try {
        await waitForIdle();
        state.sim.generation = 0;
        renderer.setGridSize(value);
        state.settings.gridSize = value;
        await renderer.randomize(state.settings.density, state.settings.initSize);
        state.sim.population = renderer.population;
        state.sim.populationGeneration = state.sim.generation;
        updateStats();
        clearStickyError();
        requestRender(true);
      } catch (e) {
        debugWarn && debugWarn("Grid size error:", e?.message || e);

        toast.show({
          kind: "warn",
          message: uiMsg.gpu.gridSizeAllocFail(value, prevSize),
        });

        // Revert to previous grid size.
        sizeInput.value = prevSize;
        value = prevSize;
        state.settings.gridSize = prevSize;

        // Restore Gen0 edge max to match the reverted grid size.
        if (initSizeInput) initSizeInput.max = String(value);
      }
    } else {
      state.settings.gridSize = value;
      toast.show({
        kind: "info",
        message: uiMsg.sim.stopToApply.gridSize,
      });
    }
  }

  /**
   * Validate grid size input.
   */
  function validateSizeInput() {
    if (!sizeInput) return;

    const value = parseInt(sizeInput.value, 10);
    const wrapper = sizeInput.parentElement;

    const max = getMaxGrid();

    setInvalid(wrapper, isNaN(value) || value < 4 || value > max);
  }

  function handleSizeKeydown(e) {
    if (!sizeInput) return;
    blurOnEnter(e, sizeInput);
  }

  /**
   * Handle initial size input change.
   */
  async function handleInitSizeChange() {
    if (!initSizeInput) return;

    const prevInitSize = state.settings.initSize;
    const wrapper = initSizeInput.parentElement;

    const raw = String(initSizeInput.value || "").trim();

    // Treat blank / non-numeric as "no change".
    if (raw === "") {
      initSizeInput.value = String(prevInitSize);
      setInvalid(wrapper, false);
      return;
    }

    let value = parseInt(raw, 10);
    if (!Number.isFinite(value)) {
      initSizeInput.value = String(prevInitSize);
      setInvalid(wrapper, false);
      return;
    }

    // Compute the effective maximum.
    const maxAttr = parseInt(initSizeInput.max, 10);
    const max = Number.isFinite(maxAttr)
      ? Math.min(maxAttr, state.settings.gridSize)
      : state.settings.gridSize;

    /** @type {string | null} */
    let clampedMsg = null;

    if (value < 2) {
      value = 2;
      clampedMsg = uiMsg.gpu.initSizeClampedMin;
    } else if (value > max) {
      value = max;
      clampedMsg = uiMsg.gpu.initSizeClampedMax(max);
    }

    initSizeInput.value = String(value);
    setInvalid(wrapper, false);

    // Nothing to do if the logical value didn't change.
    if (value === prevInitSize) {
      state.settings.initSize = value;
      return;
    }

    state.settings.initSize = value;

    if (clampedMsg) {
      toast.show({
        kind: "warn",
        message: clampedMsg,
      });
    }

    // Apply immediately only when the simulation is stopped at generation 0.
    // If the user has already advanced the simulation (even if paused), changing Gen0
    // settings should not discard the current state; it should take effect on the next reset.
    if (state.sim.isPlaying || state.sim.generation !== 0) {
      toast.show({
        kind: "info",
        message: uiMsg.sim.applyOnNextReset.initSize,
      });
      return;
    }

    try {
      await waitForIdle();
      state.sim.generation = 0;
      await renderer.randomize(state.settings.density, state.settings.initSize);
      clearStickyError();
      state.sim.population = renderer.population;
      state.sim.populationGeneration = state.sim.generation;
      updateStats();
      requestRender();
    } catch (e) {
      debugWarn && debugWarn("Init size apply error:", e?.message || e);

      // Revert UI/state to previous value.
      state.settings.initSize = prevInitSize;
      initSizeInput.value = String(prevInitSize);
      setInvalid(wrapper, false);

      toast.show({
        kind: "warn",
        message: uiMsg.gpu.initSizeApplyFail(value, prevInitSize),
      });

      // Attempt to restore a consistent Gen0 state.
      try {
        await waitForIdle();
        state.sim.generation = 0;
        await renderer.randomize(state.settings.density, prevInitSize);
        clearStickyError();
        state.sim.population = renderer.population;
        state.sim.populationGeneration = state.sim.generation;
        updateStats();
        requestRender();
      } catch (e2) {
        if (error && logMsg) error(logMsg.RECOVER_INIT_SIZE_FAILED, e2);
        toast.show({
          kind: "error",
          message: uiMsg.sim.recoverFailed,
        });
      }
    }
  }

  /**
   * Validate init size input.
   */
  function validateInitSizeInput() {
    if (!initSizeInput) return;

    const value = parseInt(initSizeInput.value, 10);
    const wrapper = initSizeInput.parentElement;

    const maxAttr = parseInt(initSizeInput.max, 10);
    const max = Number.isFinite(maxAttr)
      ? Math.min(maxAttr, state.settings.gridSize)
      : state.settings.gridSize;

    setInvalid(wrapper, isNaN(value) || value < 2 || value > max);
  }

  function handleInitSizeKeydown(e) {
    if (!initSizeInput) return;
    blurOnEnter(e, initSizeInput);
  }

  return {
    handleSizeChange,
    validateSizeInput,
    handleSizeKeydown,
    handleInitSizeChange,
    validateInitSizeInput,
    handleInitSizeKeydown,
  };
}
