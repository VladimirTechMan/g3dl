/**
 * Game of 3D Life - Main Application
 * Uses WebGPU for GPU-accelerated simulation and rendering
 */

import { WebGPURenderer } from "../gpu/renderer.js";
import { assertRendererApi } from "../gpu/rendererApi.js";
import { dom } from "../ui/dom.js";
import {
  RULE_PRESETS,
  normalizeRule,
  hasKnownSettingsParams,
  applySettingsFromUrl,
  copySettingsUrlToClipboard,
  stripAllQueryParamsFromAddressBar,
} from "./settings.js";
import { LoopController } from "./loop.js";
import { createAppState } from "./state.js";
import { bindUI } from "../ui/bindings.js";
import { createToastController } from "../ui/toast.js";
import { OrbitControls } from "./orbitControls.js";
import { ScreenShowController } from "./screenshow/controller.js";
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
  controls,
  buttonRow,
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

const toast = createToastController(dom, {
  signal: APP_SIGNAL,
  onHide: () => {
    // If the user dismisses an error toast, consider the sticky error acknowledged.
    hasStickyError = false;
  },
});

function clearStickyError() {
  if (!hasStickyError) return;
  const s = typeof toast.getState === "function" ? toast.getState() : null;
  // Only hide if the currently shown toast is the sticky error; do not stomp over newer info/warn toasts.
  if (s && s.kind === "error") toast.hide();
  hasStickyError = false;
}


/**
 * Resolve CSS length expressions (including `var(...)`, `env(...)`, `calc(...)`, `max(...)`)
 * into device pixels by applying them to a real CSS property and reading the computed style.
 *
 * This is necessary because custom properties returned by getComputedStyle() are not resolved,
 * so values like `max(24px, calc(env(...) + 24px))` cannot be parsed with parseFloat().
 */
let _cssLengthProbeEl = null;
function resolveCssLengthPx(expr, { axis = "left", fallbackPx = 0 } = {}) {
  // Ensure we only touch the DOM after it exists.
  const parent = document.body || document.documentElement;
  if (!_cssLengthProbeEl && parent) {
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.visibility = "hidden";
    el.style.pointerEvents = "none";
    el.style.width = "0";
    el.style.height = "0";
    el.style.left = "0";
    el.style.top = "0";
    parent.appendChild(el);
    _cssLengthProbeEl = el;
  }

  const el = _cssLengthProbeEl;
  if (!el) return fallbackPx;

  // Map axis => padding property.
  const prop =
    axis === "right"
      ? "paddingRight"
      : axis === "bottom"
        ? "paddingBottom"
        : "paddingLeft";

  el.style[prop] = expr;
  const cs = getComputedStyle(el);
  const raw =
    prop === "paddingRight"
      ? cs.paddingRight
      : prop === "paddingBottom"
        ? cs.paddingBottom
        : cs.paddingLeft;

  const px = parseFloat(raw);
  return Number.isFinite(px) ? px : fallbackPx;
}

// iOS/iPadOS detection (including iPadOS reporting as Mac)
const IS_IOS = (() => {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouch = navigator.maxTouchPoints || 0;
  const isAppleMobile = /iPad|iPhone|iPod/i.test(ua);
  const isIPadOS13Plus = platform === "MacIntel" && maxTouch > 1;
  return isAppleMobile || isIPadOS13Plus;
})();

/**
 * iOS Safari quirk: while pinch-zoomed, `position: fixed` is effectively anchored to the *layout* viewport,
 * which allows HUD elements to be panned completely off-screen. To keep the bottom-left stats HUD visible
 * (and usable as a "safe pinch zone"), we re-anchor it to the *visual* viewport using `visualViewport`.
 *
 * This does not attempt to control Safari zoom; it only keeps the stats panel in view.
 */
function createStatsViewportPin({ signal }) {
  if (!IS_IOS || !statsPanel || !window.visualViewport) return () => {};

  const vv = window.visualViewport;
  let rafId = 0;

  function update() {
    rafId = 0;

    // IMPORTANT: use the same responsive inset values as the CSS, so the pinned position matches
    // the on-screen layout (including the tighter 12px corner spacing on mobile).
    const insetBottom = resolveCssLengthPx("var(--stats-inset-bottom)", { axis: "bottom", fallbackPx: 24 });
    const insetLeft = resolveCssLengthPx("var(--stats-inset-left)", { axis: "left", fallbackPx: 24 });

    const left = Math.max(0, vv.offsetLeft + insetLeft);
    const top = Math.max(
      0,
      vv.offsetTop + vv.height - insetBottom - statsPanel.offsetHeight,
    );

    // Use top/left to avoid iOS fixed+bottom issues while zoomed/panned.
    statsPanel.style.left = `${left}px`;
    statsPanel.style.top = `${top}px`;
    statsPanel.style.right = "auto";
    statsPanel.style.bottom = "auto";
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(update);
  }

  // Keep the panel pinned during visual viewport panning/zooming.
  vv.addEventListener("resize", schedule, { passive: true, signal });
  vv.addEventListener("scroll", schedule, { passive: true, signal });

  // Initial placement
  schedule();
  return schedule;
}

const scheduleStatsViewportPin = createStatsViewportPin({ signal: APP_SIGNAL });

// Game rule presets (definition lives in settings.js)
const presets = RULE_PRESETS;

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
  // The button label already provides a brief indication; the toast adds a clearer explanation.
  if (ok) {
    toast.show({ kind: "info", message: UI_MSG.clipboard.copied });
  } else {
    toast.show({
      kind: "warn",
      message: UI_MSG.clipboard.failed,
    });
  }

  return ok;
}

// Controls width: keep the panel width aligned to the top button row, even when Settings/Help are open.
function syncControlsWidthToButtonRow() {
  if (!controls || !buttonRow) return;

  const cs = getComputedStyle(controls);
  const padX =
    (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const borderX =
    (parseFloat(cs.borderLeftWidth) || 0) +
    (parseFloat(cs.borderRightWidth) || 0);
  const minW = parseFloat(cs.minWidth) || 0;

  // Compute the *intrinsic* width of the visible button row (content + gap + padding),
  // independent of any previously forced panel width.
  const rowStyle = getComputedStyle(buttonRow);
  const gap =
    parseFloat(rowStyle.columnGap) ||
    parseFloat(rowStyle.gap) ||
    0;

  const rowPadX =
    (parseFloat(rowStyle.paddingLeft) || 0) +
    (parseFloat(rowStyle.paddingRight) || 0);

  const visibleButtons = Array.from(buttonRow.children).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    return getComputedStyle(el).display !== "none";
  });

  let contentW = 0;
  for (const el of visibleButtons) {
    contentW += el.getBoundingClientRect().width;
  }
  if (visibleButtons.length > 1) contentW += gap * (visibleButtons.length - 1);

  const rowW = Math.ceil(contentW + rowPadX);
  let target = Math.ceil(rowW + padX + borderX);
  target = Math.max(minW, target);

  // Mirror CSS:
  //   max-width: calc(100vw - var(--hud-inset-left) - var(--hud-inset-right));
  // Use visualViewport width when available (mobile pinch/zoom), otherwise fallback to layout viewport.
  const viewportW = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const insetLeft = resolveCssLengthPx("var(--hud-inset-left)", { axis: "left", fallbackPx: 24 });
  const insetRight = resolveCssLengthPx("var(--hud-inset-right)", { axis: "right", fallbackPx: 24 });
  const maxAllowed = Math.max(0, viewportW - insetLeft - insetRight);
  target = Math.min(target, maxAllowed);

  controls.style.width = `${target}px`;
}

/**
 * Coalesce resize/orientation events into a single rAF pass.
 * This avoids redundant layout reads on mobile and ensures swapchain reconfigure
 * (via loop.notifyResizeEvent()) happens at most once per frame.
 */
let resizeWorkRafId = 0;
function scheduleResizeWork() {
  if (resizeWorkRafId) return;
  resizeWorkRafId = requestAnimationFrame(() => {
    resizeWorkRafId = 0;
    matchHeaderWidths();
    syncControlsWidthToButtonRow();
    scheduleStatsViewportPin();
    if (loop) loop.notifyResizeEvent();
    else requestRender(true);
  });
}


// State
let renderer = null;
let loop = null;
let orbitControls = null;
let screenShow = null;

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
    if (_cssLengthProbeEl && _cssLengthProbeEl.parentNode) {
      _cssLengthProbeEl.parentNode.removeChild(_cssLengthProbeEl);
    }
    _cssLengthProbeEl = null;
  } catch (_) {
    // ignore
  }

  // Cancel any coalesced resize pass that has not run yet.
  try {
    if (resizeWorkRafId) {
      cancelAnimationFrame(resizeWorkRafId);
      resizeWorkRafId = 0;
    }
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
    if (renderer && typeof renderer.destroy === "function") renderer.destroy();
  } catch (_) {
    // ignore
  }

  renderer = null;
  loop = null;
  orbitControls = null;
  screenShow = null;
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

// Injected by bindUI(); no-op until listeners are installed.
// Used for auto-closing Settings/Help when starting a run or stepping.
let closeSettingsAndHelpPanels = () => {};

function requestRender(immediate = false) {
  if (!loop) return;
  loop.requestRender(immediate);
}

/**
 * Stop play mode.
 *
 * All scheduler state lives in the LoopController; UI side-effects are handled
 * via the loop's onPlayStateChanged hook.
 */
function stopPlaying() {
  if (loop) loop.stopPlaying();
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
  if (!loop) return;
  await loop.waitForIdle();
}

/**
 * Queue exactly one simulation step, ensuring steps never overlap.
 * Returns the renderer's "changed" value for that step.
 */
function queueStep(syncStats = true) {
  if (!loop) return Promise.resolve(true);
  return loop.queueStep(syncStats);
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
  const message = UI_MSG.sim.stepFailed;

  // Avoid spamming the user if the same sticky error is already visible.
  if (hasStickyError) {
    const s = typeof toast.getState === "function" ? toast.getState() : null;
    if (s && s.kind === "error" && s.message === message) return;
  }

  hasStickyError = true;

  // Make the issue visible on mobile. Errors remain until dismissed.
  toast.show({ kind: "error", message });
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
      hooks: {
        isInteracting: () => (orbitControls ? orbitControls.isInteracting() : false),
        updateScreenShow: (ts) => (screenShow ? screenShow.update(ts) : false),
        updateInertia: () => {
          // Apply inertial camera motion only when the user has control (i.e., Screen show is not actively driving the camera)
          // and the user is not currently interacting (dragging/pinching).
          const navLocked = !!(screenShow && screenShow.isNavLocked());
          if (navLocked) return false;
          if (orbitControls && orbitControls.isInteracting()) return false;
          return renderer.updateInertia();
        },
        getSpeedDelayMs: () => state.settings.speed,
        getAutoStopEnabled: () => {
          // Auto-stop (stable configuration) is disabled while Screen show is actively running.
          // Empty grids are still auto-stopped by the loop controller.
          return !(screenShow && screenShow.isNavLocked());
        },
        onPlayStateChanged: (playing) => {
          state.sim.isPlaying = playing;
          playIcon.hidden = playing;
          pauseIcon.hidden = !playing;
          document.body.classList.toggle("playing", playing);
          if (screenShow) screenShow.onPlayStateChanged(playing);
        },
        onAfterStep: ({ syncStats, changed }) => {
          state.sim.generation = renderer.generation;

          // In async-stats mode, renderer.population may lag; only update HUD when stats are fresh.
          const statsFresh = renderer.statsValidGeneration === state.sim.generation;
          if (statsFresh) {
            state.sim.population = renderer.population;
            state.sim.populationGeneration = state.sim.generation;
          }

          updateStats();
          if (statsFresh && state.screenshow.enabled && state.sim.population === 0) {
            disableScreenShowDueToEmpty();
          }
          return { statsFresh, population: state.sim.population };
        },
        onPopulationReadback: (res) => {
          // Accept monotonic updates only (avoid showing older readbacks that complete late).
          if (
            res.generation >= state.sim.populationGeneration &&
            res.generation <= state.sim.generation
          ) {
            state.sim.population = res.population;
            state.sim.populationGeneration = res.generation;
            updateStats();

            // Auto-stop on empty even when stats are sampled asynchronously (fast-play mode).
            // This ensures Screen show (and play mode) exits promptly when the grid becomes empty.
            if (res.population === 0) {
              if (state.screenshow.enabled) disableScreenShowDueToEmpty();
              if (state.sim.isPlaying) stopPlaying();
            }
          }
        },
        onStepError: (err) => {
          handleStepError(err);
        },
      },
    });
    // Screen show controller (camera autopilot)
    screenShow = new ScreenShowController({ state, renderer, canvas, requestRender });

    // Camera input controller (pointer/touch/mouse + wheel)
    orbitControls = new OrbitControls(canvas, renderer, {
      requestRender,
      isNavLocked: () => (screenShow ? screenShow.isNavLocked() : false),
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

  // Apply device-derived maximum grid size to the UI.
  const maxGrid =
    typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;
  sizeInput.max = String(maxGrid);

  // Keep the Gen0 edge input's HTML constraint in sync with the actual grid limit.
  //
  // Notes:
  // - The HTML `max` attribute participates in browser-native constraint validation.
  // - If it is stale (e.g., left at the initial HTML value), the control can remain
  //   "invalid" even when our JS logic would accept/clamp it.
  // - We temporarily allow up to maxGrid so URL-restored values are not prematurely
  //   clamped to a stale smaller max; we then tighten to the current grid size.
  if (initSizeInput) initSizeInput.max = String(maxGrid);

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

  // Check fullscreen support and disable button if not available
  if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) {
    fullscreenBtn.disabled = true;
    fullscreenBtn.title = "Fullscreen not supported on this device";
  }

  // Initial layout pass.
  // Use rAF so measurements happen after the first layout.
  scheduleResizeWork();

  // Coalesce resize/orientation changes into a single rAF-driven pass.
  window.addEventListener("resize", scheduleResizeWork, { passive: true, signal: APP_SIGNAL });
  window.addEventListener("orientationchange", scheduleResizeWork, {
    passive: true,
    signal: APP_SIGNAL,
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleResizeWork, {
      passive: true,
      signal: APP_SIGNAL,
    });
  }

  setupEventListeners();
  // Screen show nav lock is applied once ScreenShowController is constructed.
  // Apply Settings values that do not have dedicated init paths.
  // (Important for URL-restored colors/rules.)
  state.settings.gridSize = parseInt(sizeInput.value, 10) || state.settings.gridSize;
  state.settings.initSize = parseInt(initSizeInput.value, 10) || state.settings.initSize;

  // Now that grid edge is finalized, tighten the Gen0 edge max to match.
  if (initSizeInput) initSizeInput.max = String(state.settings.gridSize);
  if (state.settings.initSize > state.settings.gridSize) {
    state.settings.initSize = state.settings.gridSize;
    initSizeInput.value = String(state.settings.initSize);
  }

  // Resize GPU resources if grid edge differs from the renderer default.
  if (renderer && renderer.gridSize !== state.settings.gridSize) {
    try {
      renderer.setGridSize(state.settings.gridSize);
    } catch (e) {
      error(LOG_MSG.GRID_ALLOC_FALLBACK, e);
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
        toast.show({
          kind: "warn",
          message: UI_MSG.gpu.gridSizeReduced(fallback),
        });
      } catch {
        // If even fallback fails, treat this as unsupported.
        showNotSupportedMessage(
          "Failed to allocate GPU resources for the configured grid size. Please reload and use a smaller grid.",
        );
        return;
      }
    }
  }

  // Initialize run state.settings.speed from the slider (mapping: left = slower, right = faster).
  refreshSpeedFromSlider();

  // Apply Settings toggles/colors/rules to the renderer
  handleStableStopChange();
  handleToroidalChange();
  handleCellColorChange();
  handleBgColorChange();
  handleLanternChange();
  handleScreenShowChange();
  handleGridProjectionChange();
  handleRuleInputChange();

  await renderer.randomize(state.settings.density, state.settings.initSize);
  clearStickyError();
  state.sim.population = renderer.population;
  state.sim.populationGeneration = state.sim.generation;
  updateStats();

  // If the page was opened with Settings in the URL (query parameters), apply them once and
  // then clean the address bar to avoid a "sticky" parametrized URL.
  // (Sharing is done explicitly via the "Copy URL with settings" button.)
  if (urlHadSettingsParams) {
    stripAllQueryParamsFromAddressBar();
  }

  // Kick the first frame.
  requestRender();
}

/**
 * Match header title width to credit line
 */
function matchHeaderWidths() {
  const h1 = header.querySelector("h1");
  const credit = header.querySelector(".credit");
  if (h1 && credit) {
    // Temporarily make header visible for measurement if hidden
    const wasHidden = getComputedStyle(header).display === "none";
    if (wasHidden) {
      header.style.visibility = "hidden";
      header.style.display = "block";
      header.style.position = "absolute";
    }

    // Reset font size first
    h1.style.fontSize = "";
    h1.style.letterSpacing = "";

    // Measure
    const creditWidth = credit.offsetWidth;
    const h1Width = h1.offsetWidth;

    if (h1Width > 0 && creditWidth > 0 && h1Width !== creditWidth) {
      // Calculate scale factor
      const currentSize = parseFloat(getComputedStyle(h1).fontSize);
      const ratio = creditWidth / h1Width;
      const newSize = currentSize * ratio;
      // Clamp to reasonable sizes
      h1.style.fontSize = Math.min(Math.max(newSize, 12), 32) + "px";
    }

    // Restore hidden state
    if (wasHidden) {
      header.style.visibility = "";
      header.style.display = "";
      header.style.position = "";
    }
  }
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
function setupEventListeners() {
  uiBindings = bindUI(dom, {
    step,
    togglePlay,
    reset,
    toggleFullscreen,
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
 * Parse rules from input fields
 */
function parseRuleNumbers(str, opts = undefined) {
  const { allowTrailingHyphen = true } = opts || {};
  // Allow only digits, commas, hyphens, and whitespace.
  //
  // Rule syntax (post-sanitization):
  // - Single values:   "0", "13"
  // - Ranges:          "5-7"
  //
  // Notes on validation:
  // - Negative tokens like "-1" are invalid (not treated as partial ranges).
  // - A trailing hyphen like "5-" may be tolerated while typing and ignored until completed.
  //   On commit (blur/change), callers should set allowTrailingHyphen=false to treat it as invalid.
  const sanitized0 = String(str || "").replace(/[^0-9,\-\s]/g, "");
  // Normalize common range typing with spaces, e.g., "5 - 7" -> "5-7".
  const sanitized = sanitized0.replace(/(\d)\s*-\s*(\d)/g, "$1-$2");

  /** @type {Set<number>} */
  const values = new Set();
  let hasError = false;

  const tokens = sanitized.split(/[\s,]+/).filter((t) => t.length > 0);

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;

    // Disallow standalone '-' or tokens that begin with '-' (negative numbers are invalid).
    if (/^-+$/.test(token) || token.startsWith("-")) {
      hasError = true;
      break;
    }

    if (token.includes("-")) {
      // Tolerate an in-progress range while typing (e.g., "5-") if explicitly allowed.
      if (token.endsWith("-")) {
        if (allowTrailingHyphen && /^\d+-$/.test(token)) {
          continue;
        }
        hasError = true;
        break;
      }

      // Strict range format: N-M
      if (!/^\d+-\d+$/.test(token)) {
        hasError = true;
        break;
      }

      const [a, b] = token.split("-", 2);
      const start = parseInt(a, 10);
      const end = parseInt(b, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        hasError = true;
        break;
      }

      // Hard bounds: 3D Moore neighborhood has 26 neighbors (0..26).
      if (start < 0 || start > 26 || end < 0 || end > 26) {
        hasError = true;
        break;
      }
      // Descending ranges are invalid (e.g., 5-2).
      if (start > end) {
        hasError = true;
        break;
      }

      // Range is now guaranteed to be at most 27 items; safe to expand.
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
    } else {
      // Single value token
      if (!/^\d+$/.test(token)) {
        hasError = true;
        break;
      }
      const n = parseInt(token, 10);
      if (n < 0 || n > 26) {
        hasError = true;
        break;
      }
      values.add(n);
    }
  }

  const list = Array.from(values).sort((a, b) => a - b);

  return {
    sanitized,
    values: list,
    hasError,
    // For callers that want "blank is not valid", but note: we don't mark blank as an error.
    isNonEmpty: sanitized.trim() !== "",
  };
}

/**
 * Parse and apply Survival/Birth rules to the renderer.

 *
 * This is intentionally defensive: even if called accidentally with an invalid
 * string, it must never do unbounded work (e.g., expanding a huge range).
 */
function parseRules() {
  const surviveParsed = parseRuleNumbers(surviveInput.value);
  const birthParsed = parseRuleNumbers(birthInput.value);

  if (!surviveParsed.hasError && surviveParsed.isNonEmpty && surviveParsed.values.length > 0) {
    renderer.setSurviveRule(surviveParsed.values);
  }

  if (!birthParsed.hasError && birthParsed.isNonEmpty && birthParsed.values.length > 0) {
    renderer.setBirthRule(birthParsed.values);
  }
}

/**
 * Validate and sanitize rule input - only allow valid characters and values 0-26
 */
function validateRuleInput(input, opts = undefined) {
  const parsed = parseRuleNumbers(input.value, opts);

  // Update the input value to sanitized version (remove invalid chars only)
  if (input.value !== parsed.sanitized) {
    input.value = parsed.sanitized;
  }

  const isValid = !parsed.hasError && parsed.isNonEmpty;

  // Update visual feedback:
  // - Blank input is treated as "not applied" but not visually invalid.
  setInvalid(
    input.parentElement,
    !(isValid || parsed.sanitized.trim() === "")
  );

  return isValid;
}


/**
 * Handle preset selection change
 */
function handlePresetChange() {
  const preset = presetSelect.value;
  if (preset !== "custom" && presets[preset]) {
    surviveInput.value = presets[preset].survive;
    birthInput.value = presets[preset].birth;
    setInvalid(surviveInput.parentElement, false);
    setInvalid(birthInput.parentElement, false);
    parseRules();
  }
}

/**
 * Handle manual rule input change.
 *
 * This handler is bound to both:
 * - `input`: live validation / preset matching (no toast feedback)
 * - `change`: commit/blur (safe place for user-visible warnings)
 */
function handleRuleInputChange(e) {
  const isCommit = !!(e && e.type === "change");
  const parseOpts = { allowTrailingHyphen: !isCommit };

  // Validate inputs (sanitizes and updates invalid highlighting).
  const surviveValid = validateRuleInput(surviveInput, parseOpts);
  const birthValid = validateRuleInput(birthInput, parseOpts);

  // Parse again after sanitization so error detection matches the current value.
  const surviveParsed = parseRuleNumbers(surviveInput.value, parseOpts);
  const birthParsed = parseRuleNumbers(birthInput.value, parseOpts);

  // Invalid values (out of range, descending ranges, etc.).
  if (surviveParsed.hasError || birthParsed.hasError) {
    presetSelect.value = "custom";

    // Avoid spamming while typing; only toast on commit/blur.
    if (isCommit) {
      const which = [
        surviveParsed.hasError ? "Survival" : null,
        birthParsed.hasError ? "Birth" : null,
      ]
        .filter(Boolean)
        .join(" and ");

      toast.show({
        kind: "warn",
        message: UI_MSG.rules.invalid(which),
      });
    }

    return;
  }

  // Blank input is treated as "not applied" (no error), but it's not a valid rule.
  // Preserve the existing behavior: do not apply, and switch to custom.
  if (!surviveValid || !birthValid) {
    presetSelect.value = "custom";
    return;
  }

  // Normalize current values for comparison
  const currentSurvive = normalizeRule(surviveInput.value);
  const currentBirth = normalizeRule(birthInput.value);

  let matchedPreset = "custom";
  for (const [key, value] of Object.entries(presets)) {
    const presetSurvive = normalizeRule(value.survive);
    const presetBirth = normalizeRule(value.birth);
    if (presetSurvive === currentSurvive && presetBirth === currentBirth) {
      matchedPreset = key;
      break;
    }
  }

  presetSelect.value = matchedPreset;
  parseRules();
}

function handleRuleKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    // Apply via the 'change' event that fires on blur
    e.target.blur();
  }
}

/**
 * Advance one state.sim.generation
 */
async function step() {
  // Stepping is an explicit action: collapse panels that might occlude the scene.
  closeSettingsAndHelpPanels();

  // If the user is retrying after an error, clear any previously shown sticky error.
  clearStickyError();
  // Stop play mode and wait for any in-flight step
  stopPlaying();
  await waitForIdle();

  try {
    await queueStep(true);
  } catch (err) {
    error(LOG_MSG.SIM_STEP_ERROR, err);
    handleStepError(err);
  }
}

/**
 * Toggle fullscreen mode
 */
function getFullscreenElement() {
  return (
    document.fullscreenElement || document.webkitFullscreenElement || null
  );
}

function updateFullscreenIcons() {
  const fs = !!getFullscreenElement();
  fullscreenEnterIcon.hidden = fs;
  fullscreenExitIcon.hidden = !fs;
}

function requestFullscreen(el) {
  const fn =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    document.documentElement.requestFullscreen ||
    document.documentElement.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error("Fullscreen API not supported"));
  return fn.call(el);
}

function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (!fn) return Promise.reject(new Error("Fullscreen API not supported"));
  return fn.call(document);
}

/**
 * Produce a short, user-facing message for fullscreen failures.
 *
 * Notes:
 * - Many browsers reject fullscreen requests unless they are the direct result
 *   of a user gesture.
 * - Error objects vary across implementations; we rely primarily on `name` and
 *   fallback to `message`.
 *
 * @param {any} err
 * @param {{ exiting?: boolean }=} opts
 */
function describeFullscreenError(err, opts = {}) {
  const exiting = !!opts.exiting;
  const action = exiting ? "Exit fullscreen" : "Fullscreen";
  const name = err && typeof err.name === "string" ? err.name : "";
  const msg = err && typeof err.message === "string" ? err.message : "";

  if (name === "NotAllowedError") {
    return exiting
      ? "Exit fullscreen was blocked by the browser."
      : "Fullscreen was blocked by the browser. Try again after a direct tap/click.";
  }

  if (name === "NotSupportedError") {
    return `${action} is not supported on this device.`;
  }

  if (msg) {
    // Keep the message compact; browsers sometimes include long stack-like text.
    const compact = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
    return `${action} failed: ${compact}`;
  }

  return `${action} is not available on this device.`;
}

function toggleFullscreen() {
  if (!getFullscreenElement()) {
    requestFullscreen(app || canvas)
      .then(updateFullscreenIcons)
      .catch((err) => {
        debugWarn("Fullscreen error:", err);
        toast.show({
          kind: "warn",
          message: describeFullscreenError(err),
          autoHideMs: 6000,
        });
      });
  } else {
    exitFullscreen()
      .then(updateFullscreenIcons)
      .catch((err) => {
        debugWarn("Exit fullscreen error:", err);
        toast.show({
          kind: "warn",
          message: describeFullscreenError(err, { exiting: true }),
          autoHideMs: 6000,
        });
      });
  }
}

document.addEventListener("fullscreenchange", updateFullscreenIcons, {
  signal: APP_SIGNAL,
});
document.addEventListener("webkitfullscreenchange", updateFullscreenIcons, {
  signal: APP_SIGNAL,
});

/**
 * Toggle play/pause
 */
function togglePlay() {
  if (!renderer || !loop) return;

  if (loop.isPlaying) {
    stopPlaying();
    return;
  }

  // Starting a run should focus the scene: auto-close Settings and Help.
  closeSettingsAndHelpPanels();

  // If the user is retrying after an error, clear any previously shown sticky error.
  clearStickyError();

  // Screen show starts with Run and runs until paused/stepped/reset.
  if (state.screenshow.enabled) {
    if (screenShow) screenShow.startFromRun();
  }

  loop.startPlaying();
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
  const { showToastOnFailure = true } = opts;

  stopPlaying();
  await waitForIdle();

  renderer.resetView();
  state.sim.generation = 0;

  try {
    await renderer.randomize(state.settings.density, state.settings.initSize);
  } catch (e) {
    debugWarn("Randomize/reset error:", e?.message || e);

    if (showToastOnFailure) {
      toast.show({
        kind: "warn",
        message: UI_MSG.gpu.allocGeneric,
      });
    }

    return false;
  }

  clearStickyError();
  state.sim.population = renderer.population;
  state.sim.populationGeneration = state.sim.generation;
  updateStats();
  requestRender();
  return true;
}

/**
 * Update stats display
 */
function updateStats() {
  generationDisplay.textContent = state.sim.generation.toLocaleString();
  populationDisplay.textContent = state.sim.population.toLocaleString();
  scheduleStatsViewportPin();
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
 * Handle grid size input change
 */
async function handleSizeChange() {
  const prevSize = state.settings.gridSize;
  let value = parseInt(sizeInput.value, 10);
  const wrapper = sizeInput.parentElement;

  const max =
    renderer && typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;

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
      message: UI_MSG.gpu.gridSizeClamped(max),
    });
  }

  // Keep Gen0 edge HTML constraint in sync with the intended logical maximum.
  // This prevents browser-native constraint validation (based on the `max` attribute)
  // from disagreeing with the app's clamping rules.
  if (initSizeInput) initSizeInput.max = String(value);

  if (state.settings.initSize > value) {
    state.settings.initSize = value;
    initSizeInput.value = state.settings.initSize;
    setInvalid(initSizeInput.parentElement, false);
  }

  // Only apply changes if simulation is not running
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
      // Most common cause: the requested size exceeds the device's practical GPU limits.
      debugWarn("Grid size error:", e?.message || e);

      toast.show({
        kind: "warn",
        message: UI_MSG.gpu.gridSizeAllocFail(value, prevSize),
      });

      // Revert to previous grid size
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
      message: UI_MSG.sim.stopToApply.gridSize,
    });
  }
}

/**
 * Toggle invalid UI state on an input wrapper.
 * @param {HTMLElement | null} wrapper
 * @param {boolean} isInvalid
 */
function setInvalid(wrapper, isInvalid) {
  if (!wrapper) return;
  wrapper.classList.toggle("invalid", isInvalid);
}

/**
 * Handle Enter key on an input by blurring it, which triggers 'change' handlers.
 * @param {KeyboardEvent} e
 * @param {HTMLInputElement} input
 */
function blurOnEnter(e, input) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  input.blur();
}

/**
 * Validate size input
 */
function validateSizeInput() {
  const value = parseInt(sizeInput.value, 10);
  const wrapper = sizeInput.parentElement;

  const max =
    renderer && typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;

  setInvalid(wrapper, isNaN(value) || value < 4 || value > max);
}

/**
 * Handle Enter key on grid size input
 */
function handleSizeKeydown(e) {
  blurOnEnter(e, sizeInput);
}

/**
 * Handle initial size input change.
 *
 * The initial size controls the edge length of the randomized Gen0 cube.
 * It is clamped to [2, gridSize]. When the simulation is running, the value
 * is stored but not applied until the user resets.
 */
async function handleInitSizeChange() {
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

  // Compute the effective maximum: the Gen0 edge cannot exceed the current grid edge.
  // We also respect the input's own `max` attribute (kept in sync with grid edge)
  // to avoid browser-native constraint validation disagreement.
  const maxAttr = parseInt(initSizeInput.max, 10);
  const max = Number.isFinite(maxAttr)
    ? Math.min(maxAttr, state.settings.gridSize)
    : state.settings.gridSize;

  /** @type {string | null} */
  let clampedMsg = null;

  if (value < 2) {
    value = 2;
    clampedMsg = UI_MSG.gpu.initSizeClampedMin;
  } else if (value > max) {
    value = max;
    clampedMsg = UI_MSG.gpu.initSizeClampedMax(max);
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

  // Only apply immediately when simulation is not running.
  if (state.sim.isPlaying) {
    toast.show({
      kind: "info",
      message: UI_MSG.sim.stopToApply.initSize,
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
    debugWarn("Init size apply error:", e?.message || e);

    // Revert UI/state to previous value.
    state.settings.initSize = prevInitSize;
    initSizeInput.value = String(prevInitSize);
    setInvalid(wrapper, false);

    toast.show({
      kind: "warn",
      message: UI_MSG.gpu.initSizeApplyFail(value, prevInitSize),
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
      error(LOG_MSG.RECOVER_INIT_SIZE_FAILED, e2);
      toast.show({
        kind: "error",
        message: UI_MSG.sim.recoverFailed,
      });
    }
  }
}

/**
 * Validate init size input
 */
function validateInitSizeInput() {
  const value = parseInt(initSizeInput.value, 10);
  const wrapper = initSizeInput.parentElement;

  // Use the same effective maximum as the clamping logic. The HTML `max` attribute
  // is updated to track the current grid edge, but we also fall back defensively
  // to the current grid size in case the DOM constraint drifts.
  const maxAttr = parseInt(initSizeInput.max, 10);
  const max = Number.isFinite(maxAttr)
    ? Math.min(maxAttr, state.settings.gridSize)
    : state.settings.gridSize;

  setInvalid(wrapper, isNaN(value) || value < 2 || value > max);
}

/**
 * Handle Enter key on initial size input
 */
function handleInitSizeKeydown(e) {
  blurOnEnter(e, initSizeInput);
}

let densityDragActive = false;

/**
 * Preview state.settings.density value while dragging (show tooltip only)
 */
function handleDensityPreview() {
  const previewValue = parseInt(densitySlider.value, 10);

  // Keep tip visible while the user is interacting with the slider.
  // (If a previous release scheduled a hide timeout, cancel it.)
  clearTimeout(densityTip.hideTimeout);

  densityTip.textContent = previewValue + "%";
  densityTip.classList.add("visible");
}

/**
 * Schedule hiding the Gen0 density tooltip.
 * @param {number} delayMs
 */
function scheduleDensityTipHide(delayMs) {
  clearTimeout(densityTip.hideTimeout);
  densityTip.hideTimeout = setTimeout(() => {
    densityTip.classList.remove("visible");
  }, delayMs);
}

/**
 * Handle state.settings.density slider change (on release).
 *
 * Note: some callers may trigger this from global pointerup handlers. To avoid
 * duplicate commits when both pointerup and native 'change' fire, we debounce
 * identical commits over a short window.
 */
let lastDensityCommitPct = null;
let lastDensityCommitTimeMs = 0;

async function handleDensityChange() {
  const prevDensity = state.settings.density;

  const sliderPct = parseInt(densitySlider.value, 10);
  if (!Number.isFinite(sliderPct)) return;

  // Debounce identical commits (pointerup-global + native 'change' double-fire).
  const now = performance.now();
  if (lastDensityCommitPct === sliderPct && now - lastDensityCommitTimeMs < 250) {
    return;
  }
  lastDensityCommitPct = sliderPct;
  lastDensityCommitTimeMs = now;

  state.settings.density = sliderPct / 100;
  densityTip.textContent = Math.round(state.settings.density * 100) + "%";

  scheduleDensityTipHide(1000);

  // Only apply density when simulation is not running.
  if (state.sim.isPlaying) {
    toast.show({
      kind: "info",
      message: UI_MSG.sim.stopToApply.density,
    });
    return;
  }

  const ok = await reset({ showToastOnFailure: false });
  if (ok) return;

  // Revert to previous value on failure.
  state.settings.density = prevDensity;
  const prevPct = Math.round(prevDensity * 100);
  densitySlider.value = String(prevPct);
  densityTip.textContent = prevPct + "%";

  toast.show({
    kind: "warn",
    message: UI_MSG.gpu.densityApplyFail(sliderPct, prevPct),
  });

  const restored = await reset({ showToastOnFailure: false });
  if (!restored) {
    toast.show({
      kind: "error",
      message: UI_MSG.sim.recoverFailed,
    });
  }
}


/**
 * Mark density slider interaction as active (for robust tooltip teardown).
 * This runs on pointerdown so we can reliably detect releases even if the pointer
 * leaves the slider element.
 */
function handleDensityPointerDown(e) {
  densityDragActive = true;

  // Attempt pointer capture so that some engines will still dispatch pointerup
  // to the slider even if the pointer leaves the control while dragging.
  try {
    if (densitySlider && densitySlider.setPointerCapture && e && e.pointerId != null) {
      densitySlider.setPointerCapture(e.pointerId);
    }
  } catch (_) {
    // Ignore capture failures (unsupported or blocked by the element).
  }

  clearTimeout(densityTip.hideTimeout);
  densityTip.classList.add("visible");
}

/**
 * Commit density if the slider value differs from state, then schedule tip hide.
 * This is wired to a global pointerup so the tip does not get stuck visible when
 * the release occurs outside the input element.
 */
function handleDensityPointerUpGlobal() {
  if (!densityTip.classList.contains("visible")) return;

  densityDragActive = false;

  const sliderPct = parseInt(densitySlider.value, 10);
  const statePct = Math.round(state.settings.density * 100);

  // If the release did not trigger a native 'change' (browser quirk), commit here.
  if (Number.isFinite(sliderPct) && sliderPct !== statePct) {
    void handleDensityChange();
    return;
  }

  scheduleDensityTipHide(600);
}

/**
 * Hide the density tip on focus loss (keyboard navigation, clicking elsewhere).
 */
function handleDensityBlur() {
  densityDragActive = false;

  if (!densityTip.classList.contains("visible")) return;

  scheduleDensityTipHide(250);
}

/**
 * Hide the density tip when the pointer leaves the slider (desktop hover case),
 * but do not interfere with an active drag.
 */
function handleDensityMouseLeave() {
  if (densityDragActive) return;
  if (!densityTip.classList.contains("visible")) return;

  scheduleDensityTipHide(250);
}

/**
 * Handle cell color picker change
 */
function handleCellColorChange() {
  renderer.setCellColors(cellColorPicker.value, cellColorPicker2.value);
  requestRender();
}

/**
 * Handle background color picker change
 */
function handleBgColorChange() {
  renderer.setBackgroundColors(bgColorPicker.value, bgColorPicker2.value);
  requestRender();
}

/**
 * Handle lantern lighting toggle
 */
function handleLanternChange() {
  renderer.setLanternLightingEnabled(
    !!(lanternCheckbox && lanternCheckbox.checked),
  );
  requestRender();
}

/**
 * Handle Screen show toggle.
 *
 * When enabled:
 *  - User camera controls are disabled (mouse/touch/scroll + camera hotkeys).
 *  - The camera is driven by the app while the simulation is running (Run mode).
 *  - The simulation state.settings.speed is unchanged.
 */
function handleScreenShowChange() {
  const enabled = !!(screenShowCheckbox && screenShowCheckbox.checked);
  if (screenShow) screenShow.setEnabled(enabled);

  requestRender(true);
}

/**
 * Toggle the optional grid boundary rendering.
 */
function handleGridProjectionChange() {
  renderer.setGridProjectionEnabled(
    !!(gridProjectionCheckbox && gridProjectionCheckbox.checked),
  );
  requestRender();
}

/**
 * Handle toroidal checkbox change
 */
function handleToroidalChange() {
  renderer.setToroidal(toroidalCheckbox.checked);
  requestRender();
}

function handleStableStopChange() {
  if (!renderer || !stableStopCheckbox) return;
  renderer.setChangeDetectionEnabled(stableStopCheckbox.checked);
}

/**
 * Keyboard shortcut handler
 */
function isTextEntryElement(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;

  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;

  if (tag !== "INPUT") return false;
  const type = (el.getAttribute("type") || "text").toLowerCase();

  // Treat most inputs as text-entry (to avoid stealing typed characters),
  // but allow hotkeys when sliders/checkboxes/color pickers have focus.
  return ![
    "button",
    "submit",
    "reset",
    "checkbox",
    "radio",
    "range",
    "color",
    "file",
  ].includes(type);
}

function handleKeyDown(e) {
  if (e.isComposing) return;

  // Do not intercept browser/OS shortcuts.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const active = document.activeElement;

  // If the user is typing (e.g., rules or size), do not steal keystrokes.
  if (isTextEntryElement(active)) return;

  // Blur focused buttons so Space/Enter doesn't double-trigger them.
  if (active && active.tagName === "BUTTON") {
    active.blur();
  }

  switch (e.key.toLowerCase()) {
    case " ":
      // If Settings are open, let Space perform native UI actions
      // (scroll the panel, toggle focused checkboxes, etc.) rather than
      // being treated as a global Run/Pause hotkey.
      if (settingsPanel && !settingsPanel.classList.contains("hidden")) {
        return;
      }
      e.preventDefault();
      togglePlay();
      break;
    case "s":
      e.preventDefault();
      step();
      break;
    case "r":
      e.preventDefault();
      reset();
      break;
    case "f":
      e.preventDefault();
      toggleFullscreen();
      break;
    case "c":
      if (screenShow && screenShow.isNavLocked()) break;
      e.preventDefault();
      renderer.resetPan();
      // If the simulation is paused and no other animation is active,
      // explicitly request a redraw so the user sees the centering immediately.
      requestRender(true);
      break;
    case "b":
      if (screenShow && screenShow.isNavLocked()) break;
      e.preventDefault();
      renderer.resetView();
      requestRender(true);
      break;
    default:
      // Do not block other keys; keep accessibility and native behaviors intact.
      break;
  }
}

/**
 * Main render loop
 */

// Start the application
init().catch((err) => {
  error(LOG_MSG.INIT_FAILED, err);
});
