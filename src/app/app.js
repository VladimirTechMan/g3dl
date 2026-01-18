/**
 * Game of 3D Life - Main Application
 * Uses WebGPU for GPU-accelerated simulation and rendering
 */

import { WebGPURenderer } from "../gpu/renderer.js";
import { assertRendererApi } from "../gpu/rendererApi.js";
import { dom } from "../ui/dom.js";
import { copySettingsUrlToClipboard } from "./settings.js";
import { LoopController } from "./loop.js";
import { createAppState } from "./state.js";
import { bindUI } from "../ui/bindings.js";
import { createToastController } from "../ui/toast.js";
import { OrbitControls } from "./orbitControls.js";
import { ScreenShowController } from "./screenshow/controller.js";
import { destroyCssLengthProbe } from "./cssLength.js";
import { createFullscreenController } from "./fullscreen.js";
import { createKeyDownHandler } from "./hotkeys.js";
import { createStatsViewportPin, createResizeWorkScheduler } from "./layout.js";
import { createSimController } from "./simControl.js";
import { createStatsController } from "./statsUi.js";
import { createLoopHooks } from "./loopHooks.js";
import { runStartupSequence } from "./startup.js";
import { debugLog, debugWarn, error } from "../util/log.js";
import { LOG_MSG } from "../util/messages.js";
import { UI_MSG } from "./messages.js";

// DOM Elements (cached)
const {
  canvas,
  app,
  fullscreenBtn,
  fullscreenEnterIcon,
  fullscreenExitIcon,
  settingsPanel,
  playIcon,
  pauseIcon,
  speedSlider,
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
  selfTestGroup,
  selfTestBtn,
  gridProjectionCheckbox,
  generationDisplay,
  populationDisplay,
  statsPanel,
  header,
} = dom;

/**
 * App lifetime controller used to manage global event listeners and teardown.
 *
 * All "global" listeners in this module should be registered with APP_SIGNAL so they
 * are removed automatically when destroyApp() runs (e.g., on page unload or in an SPA
 * unmount scenario).
 */
const APP_ABORT = new AbortController();
const APP_SIGNAL = APP_ABORT.signal;

// Non-fatal, user-visible feedback (e.g., fullscreen failures) that would otherwise
// only be visible in the console. Safe no-op if the DOM elements are absent.
let hasStickyError = false;

// Debug-only: set to true while the correctness self-test is running.
// OrbitControls uses this to suppress navigation while tests are in progress.
let isSelfTesting = false;


const toast = createToastController(dom, {
  signal: APP_SIGNAL,
  onHide: () => {
    // If the user dismisses an error toast, consider the sticky error acknowledged.
    hasStickyError = false;
  },
});

// Fullscreen is gesture-gated in many browsers; centralize feature detection and
// error handling in one place.
const fullscreen = createFullscreenController({
  appEl: app || null,
  canvas: canvas || null,
  enterIcon: fullscreenEnterIcon,
  exitIcon: fullscreenExitIcon,
  toast,
  debugWarn,
  signal: APP_SIGNAL,
});

function clearStickyError() {
  if (!hasStickyError) return;
  const s = typeof toast.getState === "function" ? toast.getState() : null;
  // Only hide if the currently shown toast is the sticky error; do not stomp over newer info/warn toasts.
  if (s && s.kind === "error") toast.hide();
  hasStickyError = false;
}

// iOS visual viewport pinning for the bottom-left stats HUD.
// This is a safe no-op on non-iOS browsers or when visualViewport is unavailable.
const statsViewportPin = createStatsViewportPin({
  statsPanel: statsPanel || null,
  signal: APP_SIGNAL,
});
const scheduleStatsViewportPin = statsViewportPin.schedule;
const cancelStatsViewportPin = statsViewportPin.cancel;


// Speed slider mapping
// The UI control is "Run state.settings.speed" (higher = faster). Internally we keep a per-step delay in milliseconds.
// We use a hyperbolic mapping so the default value remains unchanged (value 300 -> 300 ms delay).
const SPEED_REF_VALUE = 300;
const SPEED_REF_DELAY_MS = 300;

function delayFromSpeedSliderValue(raw) {
  const v = Math.max(1, parseInt(raw, 10) || SPEED_REF_VALUE);
  // delay decreases as v increases
  return Math.max(0, Math.round((SPEED_REF_VALUE * SPEED_REF_DELAY_MS) / v));
}

function refreshSpeedFromSlider() {
  state.settings.speed = delayFromSpeedSliderValue(speedSlider.value);
}

async function handleCopyUrlButton() {
  const ok = await copySettingsUrlToClipboard(dom, {
    fallbackGridSize: state.settings.gridSize,
    fallbackInitSize: state.settings.initSize,
    fallbackDensity: state.settings.density,
  });

  // Surface clipboard failures to the user (mobile browsers often hide console output).
  // For success, the button label swap is sufficient and avoids toast noise.
  if (!ok) {
    toast.show({ kind: "warn", message: UI_MSG.clipboard.failed });
  }

  return ok;
}


/**
 * Coalesced resize/orientation work scheduler.
 *
 * Initialized after requestRender() is defined (so we can inject it).
 */
let scheduleResizeWork = () => {};
let cancelResizeWork = () => {};

// State
let renderer = null;
let loop = null;
let orbitControls = null;
let screenShow = null;

// Simulation controller: step/run/reset + sticky error policy.
let simControl = null;

// UI controllers that encapsulate cohesive handler logic.
let gridSizeUi = null;
let densityUi = null;
let rendererSettingsUi = null;
let rulesUi = null;

// UI bindings are installed once during init(); kept here so destroyApp() can tear them down.
let uiBindings = null;
let appDestroyed = false;

/**
 * Tear down global listeners and stop any scheduled work.
 *
 * This is primarily future-proofing for SPA-style mounts/unmounts and for defensive
 * cleanup on page unload. It is safe to call multiple times.
 */
function destroyApp(_reason = "") {
  if (appDestroyed) return;
  appDestroyed = true;

  // Stop global listeners first to prevent late resize/interaction events from
  // racing with teardown logic.
  try {
    APP_ABORT.abort();
  } catch (_) {
    // ignore
  }

  try {
    destroyCssLengthProbe();
  } catch (_) {
    // ignore
  }

  // Cancel any coalesced resize/layout work that has not run yet.
  try {
    cancelResizeWork();
  } catch (_) {
    // ignore
  }

  // Cancel any pending iOS visualViewport pin rAF (safe no-op on non-iOS).
  try {
    cancelStatsViewportPin();
  } catch (_) {
    // ignore
  }

  try {
    // Stop autopilot and clear any pending fade timers.
    if (screenShow) screenShow.stop(true);
  } catch (_) {
    // ignore
  }

  try {
    if (loop && typeof loop.destroy === "function") loop.destroy();
    else if (loop) loop.stopPlaying();
  } catch (_) {
    // ignore
  }

  try {
    if (orbitControls) orbitControls.destroy();
  } catch (_) {
    // ignore
  }

  try {
    if (uiBindings && typeof uiBindings.destroy === "function") uiBindings.destroy();
  } catch (_) {
    // ignore
  }

  try {
    if (densityUi && typeof densityUi.destroy === "function") densityUi.destroy();
  } catch (_) {
    // ignore
  }

  try {
    if (renderer && typeof renderer.destroy === "function") renderer.destroy();
  } catch (_) {
    // ignore
  }

  renderer = null;
  loop = null;
  orbitControls = null;
  screenShow = null;
  gridSizeUi = null;
  densityUi = null;
  rendererSettingsUi = null;
  rulesUi = null;
  uiBindings = null;
}

// Defensive cleanup on navigation away.
window.addEventListener(
  "pagehide",
  (e) => {
    // If the page is being placed into the back/forward cache (bfcache), avoid tearing
    // down; the runtime will resume with listeners intact when restored.
    if (e && e.persisted) return;
    destroyApp("pagehide");
  },
  { passive: true, signal: APP_SIGNAL },
);
window.addEventListener("beforeunload", () => destroyApp("beforeunload"), {
  signal: APP_SIGNAL,
});

// Central mutable state (simulation + settings + screenshow).
const state = createAppState();

// HUD stats rendering is simple and widely used (including from loop hooks).
// Centralize it in a tiny controller.
const statsUi = createStatsController({
  state,
  generationEl: generationDisplay || null,
  populationEl: populationDisplay || null,
  scheduleStatsViewportPin,
});

// Injected by bindUI(); no-op until listeners are installed.
// Used for auto-closing Settings/Help when starting a run or stepping.
let closeSettingsAndHelpPanels = () => {};

function requestRender(immediate = false) {
  if (!loop) return;
  loop.requestRender(immediate);
}

// Initialize the coalesced resize/orientation scheduler once requestRender() exists.
{
  const sched = createResizeWorkScheduler({
    headerEl: header || null,
    scheduleStatsViewportPin,
    getLoop: () => loop,
    requestRender,
  });
  scheduleResizeWork = sched.schedule;
  cancelResizeWork = sched.cancel;
}

// Create the simulation controller early so loop hooks can surface errors even
// during initialization.
simControl = createSimController({
  state,
  getRenderer: () => renderer,
  getLoop: () => loop,
  getScreenShow: () => screenShow,
  closeSettingsAndHelpPanels: () => closeSettingsAndHelpPanels(),
  clearStickyError,
  requestRender,
  updateStats,
  toast,
  uiMsg: UI_MSG,
  logMsg: LOG_MSG,
  error,
  debugWarn,
  getHasStickyError: () => hasStickyError,
  setHasStickyError: (v) => {
    hasStickyError = !!v;
  },
});

// Global hotkeys (space: run/pause; s: step; r: reset; f: fullscreen; c/b: camera reset).
const handleKeyDown = createKeyDownHandler({
  settingsPanel: settingsPanel || null,
  getScreenShowNavLocked: () => (screenShow ? screenShow.isNavLocked() : false),
  togglePlay,
  step,
  reset,
  toggleFullscreen: fullscreen.toggleFullscreen,
  getRenderer: () => renderer,
  requestRender,
});

/**
 * Stop play mode.
 *
 * All scheduler state lives in the LoopController; UI side-effects are handled
 * via the loop's onPlayStateChanged hook.
 */
function stopPlaying() {
  simControl?.stopPlaying?.();
}

/**
 * Disable Screen show due to the grid becoming empty.
 *
 * This is used to enforce the policy:
 * - Stable configurations do not stop Screen show (it continues to run).
 * - Empty configurations stop Screen show (and play mode), because there is nothing to view.
 *
 * The helper keeps the UI checkbox, state, and renderer overrides consistent.
 */
function disableScreenShowDueToEmpty() {
  if (!state.screenshow.enabled) return;

  // Keep the checkbox in sync without relying on firing a DOM change event.
  if (screenShowCheckbox) screenShowCheckbox.checked = false;

  if (screenShow) screenShow.setEnabled(false);

  requestRender(true);
}

/**
 * Wait until all queued GPU steps finish (if any).
 */
async function waitForIdle() {
  if (!simControl) return;
  await simControl.waitForIdle();
}

/**
 * Queue exactly one simulation step, ensuring steps never overlap.
 * Returns the renderer's "changed" value for that step.
 */
function queueStep(syncStats = true) {
  if (!simControl) return Promise.resolve(true);
  return simControl.queueStep(syncStats);
}

/**
 * Surface a fatal simulation step failure to the user.
 *
 * This should be rare. If it occurs, the most likely causes are:
 * - a WebGPU runtime/device problem (e.g., memory pressure), or
 * - a cross-browser shader/validation issue.
 *
 * The loop controller already stops play mode on step failures.
 * This handler should remain side-effect light to avoid compounding failures.
 *
 * @param {any} err
 */
function handleStepError(err) {
  simControl?.handleStepError?.(err);
}

// Input (pointer/touch/mouse) state is managed by OrbitControls.

/**
 * Initialize the application
 */
async function init() {
  if (!navigator.gpu) {
    showNotSupportedMessage("WebGPU is not supported in this browser.");
    return;
  }

  try {
    renderer = new WebGPURenderer(canvas);
    // Fail fast if a refactor accidentally removed/renamed required methods.
    assertRendererApi(renderer);
    await renderer.init();
    debugLog("WebGPU renderer initialized successfully");

    // Main loop controller: owns scheduling of steps and rendering.
    loop = new LoopController({
      renderer,
      hooks: createLoopHooks({
        state,
        playIcon: playIcon || null,
        pauseIcon: pauseIcon || null,
        getRenderer: () => renderer,
        getOrbitControls: () => orbitControls,
        getScreenShow: () => screenShow,
        updateStats,
        stopPlaying,
        disableScreenShowDueToEmpty,
        handleStepError,
      }),
    });
    // Screen show controller (camera autopilot)
    screenShow = new ScreenShowController({ state, renderer, canvas, requestRender });

    // Camera input controller (pointer/touch/mouse + wheel)
    orbitControls = new OrbitControls(canvas, renderer, {
      requestRender,
      isNavLocked: () => isSelfTesting || (screenShow ? screenShow.isNavLocked() : false),
    });

    if (screenShow) {
      screenShow.setOrbitControls(orbitControls);
      screenShow.updateNavLock();
    }

    renderer.onDeviceLost = (info) => {
      stopPlaying();
      showNotSupportedMessage(
        "WebGPU device was lost (typically due to backgrounding or memory pressure). Please reload the page.",
      );
    };
  } catch (e) {
    error(LOG_MSG.WEBGPU_INIT_FAILED, e);
    showNotSupportedMessage(e.message);
    return;
  }

  const startup = await runStartupSequence({
    dom,
    state,
    renderer,
    getScreenShow: () => screenShow,
    appSignal: APP_SIGNAL,
    scheduleResizeWork,
    requestRender,
    updateStats,
    clearStickyError,
    refreshSpeedFromSlider,
    sizeInput,
    initSizeInput,
    stableStopCheckbox,
    fullscreenBtn,
    fullscreen,
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
    lanternCheckbox,
    screenShowCheckbox,
    gridProjectionCheckbox,
    toast,
    uiMsg: UI_MSG,
    debugWarn,
    error,
    logMsg: LOG_MSG,
    waitForIdle,
    reset,
    installUiBindings,
    showNotSupportedMessage,
  });

  if (!startup) return;

  gridSizeUi = startup.gridSizeUi;
  densityUi = startup.densityUi;
  rendererSettingsUi = startup.rendererSettingsUi;
  rulesUi = startup.rulesUi;
}

/**
 * Show message when WebGPU is not available
 */
function showNotSupportedMessage(reason) {
  // Ensure we only ever have one overlay.
  const existing = document.getElementById("webgpu-not-supported");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "webgpu-not-supported";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.9); color: white; display: flex;
    align-items: center; justify-content: center; font-size: 18px;
    font-family: system-ui; text-align: center; padding: 20px; z-index: 10000;
  `;

  const card = document.createElement("div");
  card.style.maxWidth = "640px";

  const title = document.createElement("h2");
  title.textContent = "WebGPU Required";

  const details = document.createElement("p");
  details.textContent = String(reason || "WebGPU initialization failed.");

  const note = document.createElement("p");
  note.style.marginTop = "18px";
  note.style.color = "#aaa";
  note.textContent =
    "This app requires WebGPU and does not fall back to WebGL. Use a browser where WebGPU is available and enabled.";

  const hints = document.createElement("ul");
  hints.style.textAlign = "left";
  hints.style.display = "inline-block";
  hints.style.color = "#aaa";
  hints.style.marginTop = "10px";
  hints.style.lineHeight = "1.4";

  for (const text of [
    "Update to a recent version of your browser.",
    "Ensure WebGPU is enabled in the browser’s settings/flags (if applicable).",
    "If you’re in a private window or restrictive environment, try a normal window/profile.",
  ]) {
    const li = document.createElement("li");
    li.textContent = text;
    hints.appendChild(li);
  }

  card.appendChild(title);
  card.appendChild(details);
  card.appendChild(note);
  card.appendChild(hints);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

/**
 * Set up all event listeners
 */
function installUiBindings() {
  uiBindings = bindUI(dom, {
    step,
    togglePlay,
    reset,
    toggleFullscreen: fullscreen.toggleFullscreen,
    handleSpeedPreview,
    handleSpeedChange,
    handleSizeChange,
    validateSizeInput,
    handleSizeKeydown,
    handleInitSizeChange,
    validateInitSizeInput,
    handleInitSizeKeydown,
    handleDensityPreview,
    handleDensityChange,
    handleDensityPointerDown,
    handleDensityPointerUpGlobal,
    handleDensityBlur,
    handleDensityMouseLeave,
    handleCellColorChange,
    handleBgColorChange,
    handlePresetChange,
    handleRuleInputChange,
    handleRuleKeydown,
    handleLanternChange,
    handleScreenShowChange,
    handleGridProjectionChange,
    handleToroidalChange,
    handleStableStopChange,
    handleCopyUrlButton,
    handleSelfTestButton,
    handleKeyDown,

    // Allow wheel zoom even when the cursor is outside the canvas (e.g., over UI panels).
    routeWheelToScene: (e) => {
      e.preventDefault();
      if (orbitControls) orbitControls.zoomFromWheelDelta(e.deltaY, true);
    },
  });

  closeSettingsAndHelpPanels = uiBindings.closeSettingsAndHelpPanels;
  return uiBindings;
}

/**
 * Debug-only: run the correctness self-test suite.
 *
 * The underlying test harness is dynamically imported and therefore does not
 * impact normal load/startup costs.
 */
async function handleSelfTestButton() {
  // The button exists in the DOM but is hidden unless ?debug=1 is present.
  if (!selfTestBtn) return;
  if (selfTestGroup && selfTestGroup.hidden) return;
  if (isSelfTesting) return;
  if (!renderer || !renderer.device) {
    toast.show({ kind: "error", message: "Self-test unavailable: WebGPU not initialized." });
    return;
  }

  isSelfTesting = true;

  const prevLabel = selfTestBtn.textContent;
  const prevDisabled = selfTestBtn.disabled;
  const wasPlaying = !!loop?.isPlaying;

  // Disable UI interactivity while testing (keep the UI responsive but prevent state changes).
  /** @type {Array<[HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement, boolean]>} */
  const disabledSnapshot = [];
  const candidates = document.querySelectorAll(
    "#controls button, #controls input, #controls select, #controls textarea," +
      "#header button, #header input, #header select, #header textarea," +
      "#settings-panel button, #settings-panel input, #settings-panel select, #settings-panel textarea," +
      "#help-panel button, #help-panel input, #help-panel select, #help-panel textarea," +
      "#about-panel button, #about-panel input, #about-panel select, #about-panel textarea",
  );

  for (const el of candidates) {
    // @ts-ignore - querySelectorAll type does not refine to elements with `disabled`.
    if (typeof el.disabled !== "boolean") continue;
    // @ts-ignore
    disabledSnapshot.push([el, el.disabled]);
    // @ts-ignore
    el.disabled = true;
  }

  // Keep the Self-test button label visible and stable while disabled.
  selfTestBtn.disabled = true;
  selfTestBtn.textContent = "Testing...";

  const yieldToUi = () => new Promise((r) => requestAnimationFrame(() => r()));

  try {
    // Stop the main simulation loop to reduce GPU contention during tests.
    simControl?.stopPlaying?.();
    await simControl?.waitForIdle?.();
    orbitControls?.cancelInteraction?.();

    // Give the browser one frame to paint the updated button text.
    await yieldToUi();

    const { runSelfTestSuite } = await import("./selfTest/selfTestSuite.js");
    const result = await runSelfTestSuite({
      device: renderer.device,
      workgroupSize: renderer.workgroupSize,
      yieldToUi,
    });

    if (result.ok) {
      toast.show({ kind: "success", message: result.message || "Self-test passed." });
      if (wasPlaying && loop && !loop.isPlaying) loop.startPlaying();
    } else {
      toast.show({ kind: "error", message: result.message || "Self-test failed." });
    }
  } catch (e) {
    debugWarn("Self-test failed:", e?.message || e);
    toast.show({
      kind: "error",
      message:
        "Self-test error. Check the console for details (this often indicates a WebGPU or shader issue).",
    });
  } finally {
    // Restore disabled states.
    for (const [el, wasDisabled] of disabledSnapshot) {
      try {
        el.disabled = wasDisabled;
      } catch (_) {}
    }

    // Restore button label/disabled state.
    try {
      selfTestBtn.textContent = prevLabel;
      selfTestBtn.disabled = prevDisabled;
    } catch (_) {}

    isSelfTesting = false;
  }
}

/**
 * Rules UI handlers.
 *
 * The actual validation/parsing/preset matching logic is implemented in rulesUi.js
 * for better module cohesion. These thin wrappers preserve the bindUI() contract.
 */
function handlePresetChange() {
  rulesUi?.handlePresetChange?.();
}

function handleRuleInputChange(e) {
  rulesUi?.handleRuleInputChange?.(e);
}

function handleRuleKeydown(e) {
  rulesUi?.handleRuleKeydown?.(e);
}

/**
 * Advance one state.sim.generation
 */
async function step() {
  if (!simControl) return;
  await simControl.step();
}

/**
 * Toggle play/pause
 */
function togglePlay() {
  simControl?.togglePlay?.();
}

/**
 * Reset to new random state.
 *
 * This can be triggered from UI events that do not await the returned promise.
 * Therefore this function must not throw (to avoid unhandled promise rejections).
 *
 * @param {{ showToastOnFailure?: boolean }=} opts
 * @returns {Promise<boolean>} true on success, false on failure
 */
async function reset(opts = {}) {
  if (!simControl) return false;
  return await simControl.reset(opts);
}

/**
 * Update stats display
 */
function updateStats() {
  statsUi.updateStats();
}

/**
 * Preview state.settings.speed value while dragging.
 * We update the internal delay immediately, but we only reschedule the running timer on `change`.
 */
function handleSpeedPreview() {
  refreshSpeedFromSlider();
}

/**
 * Handle state.settings.speed slider change (on release)
 */
function handleSpeedChange() {
  refreshSpeedFromSlider();

  // If we're currently waiting for the next tick (timer pending), reschedule it.
  // If a step is in-flight, the new state.settings.speed will apply on the next scheduled tick.
  if (loop) loop.rescheduleNextTick();
}

/**
 * Handle grid size input change (delegated to the grid-size controller).
 */
async function handleSizeChange() {
  if (!gridSizeUi) return;
  return await gridSizeUi.handleSizeChange();
}

/**
 * Validate size input (delegated).
 */
function validateSizeInput() {
  if (!gridSizeUi) return;
  gridSizeUi.validateSizeInput();
}

/**
 * Handle Enter key on grid size input (delegated).
 */
function handleSizeKeydown(e) {
  if (!gridSizeUi) return;
  gridSizeUi.handleSizeKeydown(e);
}

/**
 * Handle initial size input change (delegated).
 */
async function handleInitSizeChange() {
  if (!gridSizeUi) return;
  return await gridSizeUi.handleInitSizeChange();
}

/**
 * Validate init size input (delegated).
 */
function validateInitSizeInput() {
  if (!gridSizeUi) return;
  gridSizeUi.validateInitSizeInput();
}

/**
 * Handle Enter key on initial size input (delegated).
 */
function handleInitSizeKeydown(e) {
  if (!gridSizeUi) return;
  gridSizeUi.handleInitSizeKeydown(e);
}

/**
 * Density (Gen0) handlers are delegated to a dedicated controller.
 */
function handleDensityPreview() {
  if (!densityUi) return;
  densityUi.handleDensityPreview();
}

async function handleDensityChange() {
  if (!densityUi) return;
  return await densityUi.handleDensityChange();
}

function handleDensityPointerDown(e) {
  if (!densityUi) return;
  densityUi.handleDensityPointerDown(e);
}

function handleDensityPointerUpGlobal() {
  if (!densityUi) return;
  densityUi.handleDensityPointerUpGlobal();
}

function handleDensityBlur() {
  if (!densityUi) return;
  densityUi.handleDensityBlur();
}

function handleDensityMouseLeave() {
  if (!densityUi) return;
  densityUi.handleDensityMouseLeave();
}

/**
 * Renderer setting handlers (delegated).
 */
function handleCellColorChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleCellColorChange();
}

function handleBgColorChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleBgColorChange();
}

function handleLanternChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleLanternChange();
}

function handleScreenShowChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleScreenShowChange();
}

function handleGridProjectionChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleGridProjectionChange();
}

function handleToroidalChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleToroidalChange();
}

function handleStableStopChange() {
  if (!rendererSettingsUi) return;
  rendererSettingsUi.handleStableStopChange();
}

/**
 * Main render loop
 */

// Start the application
init().catch((err) => {
  error(LOG_MSG.INIT_FAILED, err);
});
