/**
 * Startup orchestration helpers.
 *
 * This module centralizes the "after WebGPU init" startup sequence:
 * - Apply URL settings (if present)
 * - Clamp UI controls to device limits
 * - Install global resize listeners
 * - Create cohesive UI controllers
 * - Apply UI settings to the renderer and randomize Gen0
 *
 * The goal is to keep app.js focused on lifecycle orchestration.
 */

import {
  hasKnownSettingsParams,
  applySettingsFromUrl,
  stripAllQueryParamsFromAddressBarExcept,
} from "./settings.js";

import { isDebugEnabled } from "../util/debug.js";
import { speedSliderValueFromDelayMs } from "./speedMapping.js";

import { createGridSizeController } from "./gridSizeUi.js";
import { createDensityController } from "./densityUi.js";
import { createRendererSettingsHandlers } from "./rendererSettingsUi.js";
import { createRulesController } from "./rulesUi.js";

/**
 * @typedef {import("../ui/dom.js").DomCache} DomCache
 */

/**
 * @typedef {Object} StartupDeps
 * @property {DomCache} dom
 * @property {any} state
 * @property {any} renderer
 * @property {() => any} getScreenShow
 * @property {AbortSignal} appSignal
 * @property {() => void} scheduleResizeWork
 * @property {(force?: boolean) => void} requestRender
 * @property {() => void} updateStats
 * @property {() => void} clearStickyError
 * @property {() => void} refreshSpeedFromSlider
 * @property {(controllers: {
 *   gridSizeUi: any,
 *   densityUi: any,
 *   rendererSettingsUi: any,
 *   rulesUi: any,
 * }) => void} installUiBindings
 * @property {(reason: any) => void} showNotSupportedMessage
 * @property {{ show: (o: { kind: "info"|"warn"|"error"|"success", message: string }) => void }} toast
 * @property {any} uiMsg
 * @property {any} logMsg
 * @property {(msg: any, err?: any) => void} error
 * @property {(msg: any, err?: any) => void} debugWarn
 * @property {() => Promise<void>} waitForIdle
 * @property {(opts?: { showToastOnFailure?: boolean }) => Promise<boolean>} reset
 * @property {any} fullscreen
 */

/**
 * Seed DOM controls with the canonical defaults from {@link createAppState}.
 *
 * Why:
 * - Avoids duplicated defaults between index.html and state.js.
 * - Keeps defaults consistent when they change (humans and AI agents edit one place).
 *
 * URL query parameters (if present) will override these values immediately afterward.
 *
 * NOTE: This only seeds the controls whose defaults are currently defined in AppState
 * (grid edge, Gen0 edge, Gen0 density, run speed). Other controls keep their HTML defaults.
 *
 * @param {DomCache} dom
 * @param {any} state
 */
function seedDefaultSettingsControls(dom, state) {
  const { speedSlider, sizeInput, initSizeInput, densitySlider, densityTip } = dom;

  /**
   * Clamp a numeric value to an <input> element's [min, max] attributes, if present.
   * @param {number} n
   * @param {HTMLInputElement} input
   * @returns {number}
   */
  function clampToInputRange(n, input) {
    const min = Number.isFinite(parseInt(input.min, 10)) ? parseInt(input.min, 10) : -Infinity;
    const max = Number.isFinite(parseInt(input.max, 10)) ? parseInt(input.max, 10) : Infinity;
    return Math.min(max, Math.max(min, n));
  }

  if (speedSlider) {
    const raw = speedSliderValueFromDelayMs(state.settings.speed);
    speedSlider.value = String(clampToInputRange(raw, speedSlider));
  }

  if (sizeInput) {
    sizeInput.value = String(clampToInputRange(state.settings.gridSize, sizeInput));
  }

  if (initSizeInput) {
    initSizeInput.value = String(clampToInputRange(state.settings.initSize, initSizeInput));
  }

  if (densitySlider) {
    const pct = Math.round(state.settings.density * 100);
    densitySlider.value = String(clampToInputRange(pct, densitySlider));
    if (densityTip) densityTip.textContent = densitySlider.value + "%";
  }
}

/**
 * Perform post-WebGPU init startup work.
 *
 * NOTE: This function is a refactor-only extraction of logic that used to live
 * in app.js. It should not introduce behavior changes.
 *
 * @param {StartupDeps} deps
 * @returns {Promise<{
 *   gridSizeUi: any,
 *   densityUi: any,
 *   rendererSettingsUi: any,
 *   rulesUi: any,
 * }|null>} Returns null if a fatal startup error was handled (overlay shown).
 */
export async function runStartupSequence(deps) {
  const {
    dom,
    state,
    renderer,
    getScreenShow,
    appSignal,
    scheduleResizeWork,
    requestRender,
    updateStats,
    clearStickyError,
    refreshSpeedFromSlider,
    installUiBindings,
    showNotSupportedMessage,
    toast,
    uiMsg,
    logMsg,
    error,
    debugWarn,
    waitForIdle,
    reset,
    fullscreen,
  } = deps;

  // DOM references are provided via the centralized DOM cache.
  const {
    fullscreenBtn,
    sizeInput,
    initSizeInput,
    densitySlider,
    densityTip,
    cellColorPicker,
    cellColorPicker2,
    bgColorPicker,
    bgColorPicker2,
    presetSelect,
    surviveInput,
    birthInput,
    toroidalCheckbox,
    stableStopCheckbox,
    hazeSlider,
    lanternCheckbox,
    screenShowCheckbox,
    gridProjectionCheckbox,
  } = dom;

  // Apply device-derived maximum grid size to the UI.
  const maxGrid =
    typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;

  sizeInput.max = String(maxGrid);

  // Keep the Gen0 edge input's HTML constraint in sync with the actual grid limit.
  if (initSizeInput) initSizeInput.max = String(maxGrid);

  // Seed UI controls from AppState defaults (single source of truth).
  seedDefaultSettingsControls(dom, state);

  // Debug UI is enabled via URL (e.g., ?debug or ?debug=1).
  const debugEnabled = isDebugEnabled();
  if (debugEnabled && dom.selfTestGroup) {
    dom.selfTestGroup.classList.remove("hidden");
  }

  const urlHadSettingsParams = hasKnownSettingsParams();
  if (urlHadSettingsParams) {
    const restored = applySettingsFromUrl(dom, { maxGrid });
    if (restored.gridSize != null) state.settings.gridSize = restored.gridSize;
    if (restored.initSize != null) state.settings.initSize = restored.initSize;
    if (restored.density != null) state.settings.density = restored.density;
  }

  // Keep current size within limits.
  const currentSize = parseInt(sizeInput.value, 10);
  if (!isNaN(currentSize) && currentSize > maxGrid) {
    sizeInput.value = String(maxGrid);
    state.settings.gridSize = maxGrid;
  }

  // Change detection / auto-stop toggle (default is checked in HTML).
  if (stableStopCheckbox) {
    renderer.setChangeDetectionEnabled(stableStopCheckbox.checked);
  }

  // Check fullscreen support and disable button if not available.
  if (fullscreenBtn && !fullscreen.isSupported()) {
    fullscreenBtn.disabled = true;
    fullscreenBtn.title = "Fullscreen not supported on this device";
  }

  // Initial layout pass.
  // Use rAF so measurements happen after the first layout.
  scheduleResizeWork();

  // Coalesce resize/orientation changes into a single rAF-driven pass.
  window.addEventListener("resize", scheduleResizeWork, { passive: true, signal: appSignal });
  window.addEventListener("orientationchange", scheduleResizeWork, { passive: true, signal: appSignal });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleResizeWork, { passive: true, signal: appSignal });
  }

  // Initialize cohesive UI controllers now that renderer/state exist.
  const gridSizeUi = createGridSizeController({
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
  });

  const densityUi = createDensityController({
    densitySlider,
    densityTip,
    state,
    toast,
    uiMsg,
    reset,
  });

  const rendererSettingsUi = createRendererSettingsHandlers({
    getRenderer: () => renderer,
    getScreenShow,
    requestRender,
    cellColorPicker,
    cellColorPicker2,
    bgColorPicker,
    bgColorPicker2,
    toroidalCheckbox,
    stableStopCheckbox,
    hazeSlider,
    lanternCheckbox,
    screenShowCheckbox,
    gridProjectionCheckbox,
  });

  const rulesUi = createRulesController({
    surviveInput,
    birthInput,
    presetSelect,
    getRenderer: () => renderer,
    toast,
    uiMsg,
  });

  // Install event listeners once controllers exist.
  installUiBindings({ gridSizeUi, densityUi, rendererSettingsUi, rulesUi });

  // Now that grid edge is finalized, tighten the Gen0 edge max to match.
  if (initSizeInput) initSizeInput.max = String(state.settings.gridSize);
  if (state.settings.initSize > state.settings.gridSize) {
    state.settings.initSize = state.settings.gridSize;
    if (initSizeInput) initSizeInput.value = String(state.settings.initSize);
  }

  // Resize GPU resources if grid edge differs from the renderer default.
  if (renderer && renderer.gridSize !== state.settings.gridSize) {
    try {
      renderer.setGridSize(state.settings.gridSize);
    } catch (e) {
      error(logMsg.GRID_ALLOC_FALLBACK, e);

      // Fall back to the maximum size we believe this device supports (or the current renderer size).
      const fallback =
        typeof renderer.getMaxSupportedGridSize === "function"
          ? renderer.getMaxSupportedGridSize()
          : renderer.gridSize;
      try {
        renderer.setGridSize(fallback);
        state.settings.gridSize = fallback;
        sizeInput.value = String(fallback);
        if (initSizeInput) initSizeInput.max = String(fallback);
        toast.show({ kind: "warn", message: uiMsg.gpu.gridSizeReduced(fallback) });
      } catch {
        // If even fallback fails, treat this as unsupported.
        showNotSupportedMessage(
          "Failed to allocate GPU resources for the configured grid size. Please reload and use a smaller grid.",
        );
        return null;
      }
    }
  }

  // Initialize run state.settings.speed from the slider.
  refreshSpeedFromSlider();

  // Apply Settings toggles/colors/rules to the renderer.
  rendererSettingsUi.handleStableStopChange();
  rendererSettingsUi.handleToroidalChange();
  rendererSettingsUi.handleCellColorCommit();
  rendererSettingsUi.handleBgColorCommit();
  rendererSettingsUi.handleHazeChange();
  rendererSettingsUi.handleLanternChange();
  rendererSettingsUi.handleScreenShowChange();
  rendererSettingsUi.handleGridProjectionChange();
  rulesUi.handleRuleInputChange();

  await renderer.randomize(state.settings.density, state.settings.initSize);
  clearStickyError();

  state.sim.population = renderer.population;
  state.sim.populationGeneration = state.sim.generation;
  updateStats();

  // If the page was opened with Settings in the URL, apply them once and then
  // clean the address bar to avoid a "sticky" parametrized URL.
  //
  // In debug mode, preserve only the `debug` flag so developers can keep it on
  // while still avoiding sticky Settings parameters.
  if (urlHadSettingsParams) {
    stripAllQueryParamsFromAddressBarExcept(debugEnabled ? ["debug"] : []);
  }

  // Kick the first frame.
  requestRender();

  return { gridSizeUi, densityUi, rendererSettingsUi, rulesUi };
}
