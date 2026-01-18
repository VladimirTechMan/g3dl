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
  stripAllQueryParamsFromAddressBar,
} from "./settings.js";

import { createGridSizeController } from "./gridSizeUi.js";
import { createDensityController } from "./densityUi.js";
import { createRendererSettingsHandlers } from "./rendererSettingsUi.js";
import { createRulesController } from "./rulesUi.js";

/**
 * Returns true if the current URL enables debug UI.
 *
 * We treat this separately from Settings params: debug should not be stripped
 * from the address bar after restoring settings.
 */
function isDebugEnabledFromUrl(search = window.location.search) {
  const params = new URLSearchParams(search);
  const v = params.get("debug");
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

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
 * @property {() => void} installUiBindings
 * @property {(reason: any) => void} showNotSupportedMessage
 * @property {{ show: (o: { kind: "info"|"warn"|"error"|"success", message: string }) => void }} toast
 * @property {any} uiMsg
 * @property {any} logMsg
 * @property {(msg: any, err?: any) => void} error
 * @property {(msg: any, err?: any) => void} debugWarn
 * @property {() => Promise<void>} waitForIdle
 * @property {(opts?: { showToastOnFailure?: boolean }) => Promise<boolean>} reset
 * @property {any} fullscreen
 * @property {HTMLButtonElement|null} fullscreenBtn
 * @property {HTMLInputElement} sizeInput
 * @property {HTMLInputElement|null} initSizeInput
 * @property {HTMLInputElement|null} densitySlider
 * @property {HTMLElement|null} densityTip
 * @property {HTMLInputElement|null} cellColorPicker
 * @property {HTMLInputElement|null} cellColorPicker2
 * @property {HTMLInputElement|null} bgColorPicker
 * @property {HTMLInputElement|null} bgColorPicker2
 * @property {HTMLSelectElement|null} presetSelect
 * @property {HTMLInputElement|null} surviveInput
 * @property {HTMLInputElement|null} birthInput
 * @property {HTMLInputElement|null} toroidalCheckbox
 * @property {HTMLInputElement|null} stableStopCheckbox
 * @property {HTMLInputElement|null} lanternCheckbox
 * @property {HTMLInputElement|null} screenShowCheckbox
 * @property {HTMLInputElement|null} gridProjectionCheckbox
 */

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
    lanternCheckbox,
    screenShowCheckbox,
    gridProjectionCheckbox,
  } = deps;

  // Apply device-derived maximum grid size to the UI.
  const maxGrid =
    typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;

  sizeInput.max = String(maxGrid);

  // Keep the Gen0 edge input's HTML constraint in sync with the actual grid limit.
  if (initSizeInput) initSizeInput.max = String(maxGrid);

  // Debug UI is enabled via URL (e.g., ?debug=1). This is intentionally not
  // considered a "Settings" param because developers may want it to persist.
  const debugEnabled = isDebugEnabledFromUrl();
  if (debugEnabled && dom.selfTestGroup) {
    dom.selfTestGroup.hidden = false;
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
  installUiBindings();

  // Apply Settings values that do not have dedicated init paths.
  // (Important for URL-restored colors/rules.)
  state.settings.gridSize = parseInt(sizeInput.value, 10) || state.settings.gridSize;
  state.settings.initSize =
    (initSizeInput && parseInt(initSizeInput.value, 10)) || state.settings.initSize;

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
  rendererSettingsUi.handleCellColorChange();
  rendererSettingsUi.handleBgColorChange();
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
  if (urlHadSettingsParams && !debugEnabled) {
    stripAllQueryParamsFromAddressBar();
  }

  // Kick the first frame.
  requestRender();

  return { gridSizeUi, densityUi, rendererSettingsUi, rulesUi };
}
