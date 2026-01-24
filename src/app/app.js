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
  fullscreenEnterIcon,
  fullscreenExitIcon,
  settingsPanel,
  playIcon,
  pauseIcon,
  speedSlider,
  screenShowCheckbox,
  selfTestGroup,
  selfTestBtn,
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
 * App ctx (mutable) state.
 *
 * This keeps cross-cutting controllers/resources in one place so the module
 * does not rely on a large set of unrelated top-level `let` bindings.
 *
 * Note: We intentionally mutate fields on this object (rather than rebinding)
 * to keep dependency closures stable.
 */
const ctx = {
  /**
   * Coalesced resize/orientation work scheduler.
   *
   * Initialized after requestRender() is defined (so we can inject it).
   */
  scheduleResizeWork: () => {},
  cancelResizeWork: () => {},

  // Core ctx controllers/resources (created during init()).
  renderer: null,
  loop: null,
  orbitControls: null,
  screenShow: null,

  // Simulation controller: step/run/reset + sticky error policy.
  simControl: null,

  // UI controllers that encapsulate cohesive handler logic.
  ui: {
    gridSizeUi: null,
    densityUi: null,
    rendererSettingsUi: null,
    rulesUi: null,
  },

  // UI bindings are installed once during init(); kept so destroyApp() can tear them down.
  uiBindings: null,

  // Injected by bindUI(); no-op until listeners are installed.
  // Used for auto-closing Settings/Help when starting a run or stepping.
  closeSettingsAndHelpPanels: () => {},

  destroyed: false,
};

/**
 * Tear down global listeners and stop any scheduled work.
 *
 * This is primarily future-proofing for SPA-style mounts/unmounts and for defensive
 * cleanup on page unload. It is safe to call multiple times.
 */
function destroyApp(_reason = "") {
  if (ctx.destroyed) return;
  ctx.destroyed = true;

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
    ctx.cancelResizeWork();
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
    if (ctx.screenShow) ctx.screenShow.stop(true);
  } catch (_) {
    // ignore
  }

  try {
    if (ctx.loop && typeof ctx.loop.destroy === "function") ctx.loop.destroy();
    else if (ctx.loop) ctx.loop.stopPlaying();
  } catch (_) {
    // ignore
  }

  try {
    if (ctx.orbitControls) ctx.orbitControls.destroy();
  } catch (_) {
    // ignore
  }

  try {
    if (ctx.uiBindings && typeof ctx.uiBindings.destroy === "function") ctx.uiBindings.destroy();
  } catch (_) {
    // ignore
  }

  try {
    if (ctx.ui.densityUi && typeof ctx.ui.densityUi.destroy === "function") ctx.ui.densityUi.destroy();
  } catch (_) {
    // ignore
  }

  try {
    if (ctx.renderer && typeof ctx.renderer.destroy === "function") ctx.renderer.destroy();
  } catch (_) {
    // ignore
  }

  ctx.renderer = null;
  ctx.loop = null;
  ctx.orbitControls = null;
  ctx.screenShow = null;
  ctx.ui.gridSizeUi = null;
  ctx.ui.densityUi = null;
  ctx.ui.rendererSettingsUi = null;
  ctx.ui.rulesUi = null;
  ctx.uiBindings = null;
}

// Defensive cleanup on navigation away.
window.addEventListener(
  "pagehide",
  (e) => {
    // If the page is being placed into the back/forward cache (bfcache), avoid tearing
    // down but suspend GPU work. The ctx will resume with listeners intact when restored.
    if (e && e.persisted) {
      suspendForBackground("pagehide-bfcache");
      return;
    }
    destroyApp("pagehide");
  },
  { passive: true, signal: APP_SIGNAL },
);

// Resume from bfcache restoration.
window.addEventListener(
  "pageshow",
  (e) => {
    if (e && e.persisted) {
      resumeFromBackground("pageshow-bfcache");
    }
  },
  { passive: true, signal: APP_SIGNAL },
);
window.addEventListener("beforeunload", () => destroyApp("beforeunload"), {
  signal: APP_SIGNAL,
});

// Central mutable state (simulation + settings + screenshow).
const state = createAppState();

// ------------------------------------------------------------
// Visibility/backgrounding policy
// ------------------------------------------------------------

// When the document is hidden (tab backgrounded, app switched, screen locked),
// we proactively suspend GPU work to reduce battery usage and lower the risk of
// WebGPU device loss on mobile browsers.
//
// Policy summary:
// - On hide/freeze: pause play mode and stop animation-driven rendering.
// - On show/resume: resume to the prior play state (auto-resume) and render immediately.
// - Lantern timebase is frozen while hidden so it doesn't "jump" on resume.
let _visSuspended = false;
let _wasPlayingBeforeVisSuspend = false;

/**
 * Suspend simulation and rendering due to backgrounding.
 *
 * This function is idempotent.
 *
 * @param {string} reason
 */
function suspendForBackground(reason = "") {
  if (_visSuspended) return;
  _visSuspended = true;

  // Snapshot play state before stopping it.
  _wasPlayingBeforeVisSuspend = !!(ctx.loop && ctx.loop.isPlaying);

  try {
    // Freeze the visualization timebase so lantern flicker does not jump when returning.
    if (ctx.renderer && typeof ctx.renderer.pauseTimebase === "function") ctx.renderer.pauseTimebase();
  } catch (_) {
    // ignore
  }

  try {
    // Cancel active gestures immediately to avoid stuck pointer states after backgrounding.
    ctx.orbitControls?.cancelInteraction?.();
  } catch (_) {
    // ignore
  }

  // Screen show uses timers for fade/teleport sequencing. Clear them explicitly so
  // no background timers keep firing while hidden. Unlike a user-initiated pause,
  // we preserve the current pass so Screen show can resume exactly where it stopped.
  try {
    ctx.screenShow?.pauseTimebase?.();
  } catch (_) {
    // ignore
  }

  try {
    // Stop play ticks and animation-driven rendering.
    if (ctx.loop && typeof ctx.loop.setSuspended === "function") ctx.loop.setSuspended(true);
    else ctx.loop?.stopPlaying?.();
  } catch (_) {
    // ignore
  }

  void reason;
}

/**
 * Resume from a previously suspended background state.
 *
 * This function is idempotent.
 *
 * @param {string} reason
 */
function resumeFromBackground(reason = "") {
  if (!_visSuspended) return;
  _visSuspended = false;

  try {
    if (ctx.renderer && typeof ctx.renderer.resumeTimebase === "function") ctx.renderer.resumeTimebase();
  } catch (_) {
    // ignore
  }

  try {
    ctx.screenShow?.resumeTimebase?.();
  } catch (_) {
    // ignore
  }

  try {
    if (ctx.loop && typeof ctx.loop.setSuspended === "function") ctx.loop.setSuspended(false);
  } catch (_) {
    // ignore
  }

  // Ensure the canvas is refreshed promptly after returning to the foreground.
  requestRender(true);

  // Auto-resume if the user was playing before backgrounding.
  const shouldResumePlay = _wasPlayingBeforeVisSuspend;
  _wasPlayingBeforeVisSuspend = false;

  if (shouldResumePlay && ctx.loop && !ctx.loop.isPlaying) {
    ctx.loop.startPlaying();
  }

  void reason;
}

/**
 * Install lifecycle listeners that drive the backgrounding policy.
 */
function installVisibilityPolicy() {
  // Page Visibility API (broad support).
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) suspendForBackground("visibilitychange");
      else resumeFromBackground("visibilitychange");
    },
    { signal: APP_SIGNAL },
  );

  // Page Lifecycle API (best-effort; supported in Chromium-based browsers).
  // These events can fire without a visibilitychange in some cases.
  document.addEventListener(
    "freeze",
    () => suspendForBackground("freeze"),
    { signal: APP_SIGNAL },
  );
  document.addEventListener(
    "resume",
    () => resumeFromBackground("resume"),
    { signal: APP_SIGNAL },
  );

  // If the page is already hidden at install time (rare), suspend immediately.
  if (document.hidden) suspendForBackground("initial-hidden");
}

installVisibilityPolicy();

// HUD stats rendering is simple and widely used (including from loop hooks).
// Centralize it in a tiny controller.
const statsUi = createStatsController({
  state,
  generationEl: generationDisplay || null,
  populationEl: populationDisplay || null,
  scheduleStatsViewportPin,
});


function requestRender(immediate = false) {
  if (!ctx.loop) return;
  ctx.loop.requestRender(immediate);
}

// Initialize the coalesced resize/orientation scheduler once requestRender() exists.
{
  const sched = createResizeWorkScheduler({
    headerEl: header || null,
    scheduleStatsViewportPin,
    getLoop: () => ctx.loop,
    requestRender,
  });
  ctx.scheduleResizeWork = sched.schedule;
  ctx.cancelResizeWork = sched.cancel;
}

// Create the simulation controller early so loop hooks can surface errors even
// during initialization.
ctx.simControl = createSimController({
  state,
  getRenderer: () => ctx.renderer,
  getLoop: () => ctx.loop,
  getScreenShow: () => ctx.screenShow,
  closeSettingsAndHelpPanels: () => ctx.closeSettingsAndHelpPanels(),
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
  getScreenShowNavLocked: () => (ctx.screenShow ? ctx.screenShow.isNavLocked() : false),
  togglePlay,
  step,
  reset,
  toggleFullscreen: fullscreen.toggleFullscreen,
  getRenderer: () => ctx.renderer,
  requestRender,
});

/**
 * Stop play mode.
 *
 * All scheduler state lives in the LoopController; UI side-effects are handled
 * via the loop's onPlayStateChanged hook.
 */
function stopPlaying() {
  ctx.simControl?.stopPlaying?.();
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

  if (ctx.screenShow) ctx.screenShow.setEnabled(false);

  requestRender(true);
}

/**
 * Wait until all queued GPU steps finish (if any).
 */
async function waitForIdle() {
  if (!ctx.simControl) return;
  await ctx.simControl.waitForIdle();
}

/**
 * Queue exactly one simulation step, ensuring steps never overlap.
 * Returns the renderer's "changed" value for that step.
 */
function queueStep(syncStats = true) {
  if (!ctx.simControl) return Promise.resolve(true);
  return ctx.simControl.queueStep(syncStats);
}

/**
 * Surface a fatal simulation step failure to the user.
 *
 * This should be rare. If it occurs, the most likely causes are:
 * - a WebGPU ctx/device problem (e.g., memory pressure), or
 * - a cross-browser shader/validation issue.
 *
 * The loop controller already stops play mode on step failures.
 * This handler should remain side-effect light to avoid compounding failures.
 *
 * @param {any} err
 */
function handleStepError(err) {
  ctx.simControl?.handleStepError?.(err);
}

// Input (pointer/touch/mouse) state is managed by OrbitControls.


/**
 * Fade out and remove the initial loading overlay, if present.
 */
function hideLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  if (!overlay) return;
  if (overlay.classList.contains("is-hidden")) return;

  overlay.classList.add("is-hidden");
  // Remove from the DOM after the fade to avoid blocking focus/interaction.
  window.setTimeout(() => overlay.remove(), 220);
}

/**
 * Initialize the application
 */
async function init() {
  if (!navigator.gpu) {
    showNotSupportedMessage("WebGPU is not supported in this browser.");
    return;
  }

  try {
    ctx.renderer = new WebGPURenderer(canvas);
    // Fail fast if a refactor accidentally removed/renamed required methods.
    assertRendererApi(ctx.renderer);
    await ctx.renderer.init();
    debugLog("WebGPU renderer initialized successfully");

    // Main loop controller: owns scheduling of steps and rendering.
    ctx.loop = new LoopController({
      renderer: ctx.renderer,
      hooks: createLoopHooks({
        state,
        playIcon: playIcon || null,
        pauseIcon: pauseIcon || null,
        getRenderer: () => ctx.renderer,
        getOrbitControls: () => ctx.orbitControls,
        getScreenShow: () => ctx.screenShow,
        updateStats,
        stopPlaying,
        disableScreenShowDueToEmpty,
        handleStepError,
      }),
    });
    // Screen show controller (camera autopilot)
    ctx.screenShow = new ScreenShowController({ state, renderer: ctx.renderer, canvas, requestRender });

    // Camera input controller (pointer/touch/mouse + wheel)
    ctx.orbitControls = new OrbitControls(canvas, ctx.renderer, {
      requestRender,
      isNavLocked: () => isSelfTesting || (ctx.screenShow ? ctx.screenShow.isNavLocked() : false),
    });

    if (ctx.screenShow) {
      ctx.screenShow.setOrbitControls(ctx.orbitControls);
      ctx.screenShow.updateNavLock();
    }

    ctx.renderer.onDeviceLost = (info) => {
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
    renderer: ctx.renderer,
    getScreenShow: () => ctx.screenShow,
    appSignal: APP_SIGNAL,
    scheduleResizeWork: ctx.scheduleResizeWork,
    requestRender,
    updateStats,
    clearStickyError,
    refreshSpeedFromSlider,
    fullscreen,
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

  ctx.ui.gridSizeUi = startup.gridSizeUi;
  ctx.ui.densityUi = startup.densityUi;
  ctx.ui.rendererSettingsUi = startup.rendererSettingsUi;
  ctx.ui.rulesUi = startup.rulesUi;

  hideLoadingOverlay();
}

/**
 * Show message when WebGPU is not available
 */
function showNotSupportedMessage(reason) {
  hideLoadingOverlay();
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
 * @typedef {Object} UiControllers
 * @property {any} gridSizeUi
 * @property {any} densityUi
 * @property {any} rendererSettingsUi
 * @property {any} rulesUi
 */

/**
 * Set up all event listeners.
 *
 * This is called once, after cohesive UI controllers exist. We build the
 * bindUI() handler table here (using closures over controllers) to avoid
 * scattering thin delegator functions throughout app.js.
 *
 * @param {UiControllers} controllers
 */
function installUiBindings(controllers) {
  const { gridSizeUi, densityUi, rendererSettingsUi, rulesUi } = controllers;

  ctx.uiBindings = bindUI(dom, {
    step,
    togglePlay,
    reset,
    toggleFullscreen: fullscreen.toggleFullscreen,
    handleSpeedPreview,
    handleSpeedChange,

    // Grid size + Gen0 init-size controls
    handleSizeChange: () => gridSizeUi.handleSizeChange(),
    validateSizeInput: () => gridSizeUi.validateSizeInput(),
    handleSizeKeydown: (e) => gridSizeUi.handleSizeKeydown(e),
    handleInitSizeChange: () => gridSizeUi.handleInitSizeChange(),
    validateInitSizeInput: () => gridSizeUi.validateInitSizeInput(),
    handleInitSizeKeydown: (e) => gridSizeUi.handleInitSizeKeydown(e),

    // Density (Gen0 fill)
    handleDensityPreview: () => densityUi.handleDensityPreview(),
    handleDensityChange: () => densityUi.handleDensityChange(),
    handleDensityPointerDown: (e) => densityUi.handleDensityPointerDown(e),
    handleDensityPointerUpGlobal: () => densityUi.handleDensityPointerUpGlobal(),
    handleDensityBlur: () => densityUi.handleDensityBlur(),
    handleDensityMouseLeave: () => densityUi.handleDensityMouseLeave(),

    // Renderer/visual settings
    handleCellColorChange: () => rendererSettingsUi.handleCellColorChange(),
    handleBgColorChange: () => rendererSettingsUi.handleBgColorChange(),
    handleHazePreview: () => rendererSettingsUi.handleHazePreview(),
    handleHazeChange: () => rendererSettingsUi.handleHazeChange(),
    handleHazePointerDown: (e) => rendererSettingsUi.handleHazePointerDown(e),
    handleHazePointerUpGlobal: () => rendererSettingsUi.handleHazePointerUpGlobal(),
    handleHazeBlur: () => rendererSettingsUi.handleHazeBlur(),
    handleHazeMouseLeave: () => rendererSettingsUi.handleHazeMouseLeave(),
    handleLanternChange: () => rendererSettingsUi.handleLanternChange(),
    handleScreenShowChange: () => rendererSettingsUi.handleScreenShowChange(),
    handleGridProjectionChange: () => rendererSettingsUi.handleGridProjectionChange(),
    handleToroidalChange: () => rendererSettingsUi.handleToroidalChange(),
    handleStableStopChange: () => rendererSettingsUi.handleStableStopChange(),

    // Rules
    handlePresetChange: () => rulesUi.handlePresetChange(),
    handleRuleInputChange: (e) => rulesUi.handleRuleInputChange(e),
    handleRuleKeydown: (e) => rulesUi.handleRuleKeydown(e),

    handleCopyUrlButton,
    handleSelfTestButton,
    handleKeyDown,

    // Allow wheel zoom even when the cursor is outside the canvas (e.g., over UI panels).
    routeWheelToScene: (e) => {
      e.preventDefault();
      if (ctx.orbitControls) ctx.orbitControls.zoomFromWheelDelta(e.deltaY, true);
    },
  });

  ctx.closeSettingsAndHelpPanels = ctx.uiBindings.closeSettingsAndHelpPanels;
  return ctx.uiBindings;
}

/**
 * Debug-only: run the correctness self-test suite.
 *
 * The underlying test harness is dynamically imported and therefore does not
 * impact normal load/startup costs.
 */
async function handleSelfTestButton() {
  // The button exists in the DOM but is hidden unless debug mode is enabled via the URL (e.g., ?debug or ?debug=1).
  if (!selfTestBtn) return;
  if (selfTestGroup && selfTestGroup.classList.contains("hidden")) return;
  if (isSelfTesting) return;
  if (!ctx.renderer || !ctx.renderer.device) {
    toast.show({ kind: "error", message: "Self-test unavailable: WebGPU not initialized." });
    return;
  }

  isSelfTesting = true;

  const prevLabel = selfTestBtn.textContent;
  const prevDisabled = selfTestBtn.disabled;
  const wasPlaying = !!ctx.loop?.isPlaying;

  // Disable UI interactivity while testing (keep the UI responsive but prevent state changes).
  /** @type {Array<[HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement, boolean]>} */
  const disabledSnapshot = [];
  const candidates = document.querySelectorAll(
    "#controls button, #controls input, #controls select, #controls textarea," +
      "#header button, #header input, #header select, #header textarea," +
      "#settings-panel button, #settings-panel input, #settings-panel select, #settings-panel textarea," +
      "#help-panel button, #help-panel input, #help-panel select, #help-panel textarea",
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
    ctx.simControl?.stopPlaying?.();
    await ctx.simControl?.waitForIdle?.();
    ctx.orbitControls?.cancelInteraction?.();

    // Give the browser one frame to paint the updated button text.
    await yieldToUi();

    const { runSelfTestSuite } = await import("./selfTest/selfTestSuite.js");
    const result = await runSelfTestSuite({
      device: ctx.renderer.device,
      workgroupSize: ctx.renderer.workgroupSize,
      yieldToUi,
    });

    if (result.ok) {
      toast.show({ kind: "success", message: result.message || "Self-test passed." });
      if (wasPlaying && ctx.loop && !ctx.loop.isPlaying) ctx.loop.startPlaying();
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
 * Advance one state.sim.generation
 */
async function step() {
  if (!ctx.simControl) return;
  await ctx.simControl.step();
}

/**
 * Toggle play/pause
 */
function togglePlay() {
  ctx.simControl?.togglePlay?.();
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
  if (!ctx.simControl) return false;
  return await ctx.simControl.reset(opts);
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
  if (ctx.loop) ctx.loop.rescheduleNextTick();
}

/**
 * Main render loop
 */

// Start the application
init().catch((err) => {
  error(LOG_MSG.INIT_FAILED, err);
  showNotSupportedMessage(err?.message || "Initialization failed.");
});
