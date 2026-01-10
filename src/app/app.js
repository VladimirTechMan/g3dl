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
  buildUrlWithSettings,
  createUrlSyncController,
  copySettingsUrlToClipboard,
  stripAllQueryParamsFromAddressBar,
} from "./settings.js";
import { LoopController } from "./loop.js";
import { createAppState } from "./state.js";
import { bindUI } from "../ui/bindings.js";
import { OrbitControls } from "./orbitControls.js";
import { ScreenShowController } from "./screenshow/controller.js";


// DOM Elements (cached)
const {
  canvas,
  app,
  stepBtn,
  playBtn,
  resetBtn,
  settingsBtn,
  helpBtn,
  fullscreenBtn,
  fullscreenEnterIcon,
  fullscreenExitIcon,
  settingsPanel,
  helpPanel,
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
  copyUrlBtn,
  gridProjectionCheckbox,
  generationDisplay,
  populationDisplay,
  statsPanel,
  infoBtn,
  header,
} = dom;

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
const scheduleStatsViewportPin = (() => {
  if (!IS_IOS || !statsPanel || !window.visualViewport) return () => {};

  const vv = window.visualViewport;
  let rafId = 0;

  function readCssPxVar(varName, fallbackPx) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallbackPx;
  }

  function update() {
    rafId = 0;

    // HUD insets are defined in CSS (including safe-area handling).
    const insetLeft = readCssPxVar("--hud-inset-left", 24);
    const insetBottom = readCssPxVar("--hud-inset-bottom", 24);

    // Position in layout CSS pixels, aligned to the *visual* viewport.
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

  vv.addEventListener("resize", schedule, { passive: true });
  vv.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("orientationchange", schedule, { passive: true });

  // Initial placement
  schedule();
  return schedule;
})();

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

// URL sync (disabled by default): call sites are preserved for easy experimentation.
let urlSync = null;
function requestUrlSync() {
  if (urlSync) urlSync.request();
}

async function handleCopyUrlButton() {
  return copySettingsUrlToClipboard(dom, {
    fallbackGridSize: state.settings.gridSize,
    fallbackInitSize: state.settings.initSize,
    fallbackDensity: state.settings.density,
  });
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

  const rowW = Math.ceil(buttonRow.scrollWidth);
  let target = Math.ceil(rowW + padX + borderX);
  target = Math.max(minW, target);

  // Mirror CSS max-width: calc(100vw - 48px)
  const maxAllowed = Math.max(0, window.innerWidth - 48);
  target = Math.min(target, maxAllowed);

  controls.style.width = `${target}px`;
}

// State
let renderer = null;
let loop = null;
let orbitControls = null;
let screenShow = null;

// Central mutable state (simulation + settings + screenshow).
const state = createAppState();

// Injected by bindUI(); no-op until listeners are installed.
// Used for auto-closing Settings/Help when starting a run or stepping.
let closeSettingsAndHelpPanels = () => {};

/**
 * Determine whether user camera navigation should be locked.
 *
 * Screen show disables manual navigation only while it is actively running (i.e., while the simulation is playing).
 * When the simulation is paused, navigation remains available even if the Screen show checkbox is enabled.
 *
 * @returns {boolean}
 */
/**
 * Apply or clear navigation lock UI state.
 * This keeps the cursor neutral and cancels any in-progress drag/pinch state when locking.
 */
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
  requestUrlSync();
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
    console.log("WebGPU renderer initialized successfully");

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
          console.error("Step failed:", err);
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
      console.error("WebGPU device lost:", info);
      stopPlaying();
      showNotSupportedMessage(
        "WebGPU device was lost (typically due to backgrounding or memory pressure). Please reload the page.",
      );
    };
  } catch (e) {
    console.error("WebGPU initialization failed:", e);
    showNotSupportedMessage(e.message);
    return;
  }

  // Apply device-derived maximum grid size to the UI.
  const maxGrid =
    typeof renderer.getMaxSupportedGridSize === "function"
      ? renderer.getMaxSupportedGridSize()
      : 256;
  sizeInput.max = String(maxGrid);

  state.flags.urlHadSettingsParams = hasKnownSettingsParams();
  if (state.flags.urlHadSettingsParams) {
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

  // Match header title width to credit line
  matchHeaderWidths();
  window.addEventListener("resize", matchHeaderWidths);

  // Keep the WebGPU swapchain/depth buffer in sync with layout and orientation changes.
  const handleAppResize = () => {
    if (loop) loop.notifyResizeEvent();
    else requestRender(true);
  };
  window.addEventListener("resize", handleAppResize, { passive: true });
  window.addEventListener("orientationchange", handleAppResize, {
    passive: true,
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleAppResize, {
      passive: true,
    });
  }

  // Keep the controls container width aligned to the button row.
  // Use rAF to ensure layout is settled.
  requestAnimationFrame(syncControlsWidthToButtonRow);
  window.addEventListener("resize", () =>
    requestAnimationFrame(syncControlsWidthToButtonRow),
  );

  setupEventListeners();
  // Screen show nav lock is applied once ScreenShowController is constructed.
  // Apply Settings values that do not have dedicated init paths.
  // (Important for URL-restored colors/rules.)
  state.settings.gridSize = parseInt(sizeInput.value, 10) || state.settings.gridSize;
  state.settings.initSize = parseInt(initSizeInput.value, 10) || state.settings.initSize;
  if (state.settings.initSize > state.settings.gridSize) {
    state.settings.initSize = state.settings.gridSize;
    initSizeInput.value = String(state.settings.initSize);
  }

  // Resize GPU resources if grid edge differs from the renderer default.
  if (renderer && renderer.gridSize !== state.settings.gridSize) {
    renderer.setGridSize(state.settings.gridSize);
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
  state.sim.population = renderer.population;
  state.sim.populationGeneration = state.sim.generation;
  updateStats();

  // If the page was opened with Settings in the URL (query parameters), apply them once and
  // then clean the address bar to avoid a "sticky" parametrized URL.
  // (Sharing is done explicitly via the "Copy URL with settings" button.)
  if (state.flags.urlHadSettingsParams) {
    stripAllQueryParamsFromAddressBar();
    state.flags.urlHadSettingsParams = false;
  }

  // URL is no longer auto-updated when changing Settings.
  // Use the “Copy URL with settings” button to generate a shareable link.
  // We keep the (disabled-by-default) controller to preserve the existing call sites.
  urlSync = createUrlSyncController({
    enabled: false,
    buildUrl: () =>
      buildUrlWithSettings(dom, {
        fallbackGridSize: state.settings.gridSize,
        fallbackInitSize: state.settings.initSize,
        fallbackDensity: state.settings.density,
      }),
  });

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
  const overlay = document.createElement("div");
  overlay.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.9); color: white; display: flex;
          align-items: center; justify-content: center; font-size: 18px;
          font-family: system-ui; text-align: center; padding: 20px; z-index: 10000;
      `;
  overlay.innerHTML = `
          <div>
              <h2>WebGPU Required</h2>
              <p>${reason || "WebGPU initialization failed."}</p>
              <p style="margin-top: 20px; color: #888;">Supported browsers:</p>
              <ul style="text-align: left; display: inline-block; color: #aaa; margin-top: 5px;">
                  <li>Chrome 113+ / Edge 113+</li>
                  <li>Firefox 141+ (Windows) / 145+ (macOS Tahoe)</li>
                  <li>Safari 26+ (macOS Tahoe / iOS 26)</li>
              </ul>
          </div>
      `;
  document.body.appendChild(overlay);
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
  const ui = bindUI(dom, {
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

  closeSettingsAndHelpPanels = ui.closeSettingsAndHelpPanels;
}


/**
 * Parse rules from input fields
 */
function parseRuleNumbers(str) {
  // Allow only digits, commas, hyphens, and whitespace.
  // Note: we intentionally keep partial input like "5-" non-invalid while the user types.
  const sanitized = String(str || "").replace(/[^0-9,\-\s]/g, "");

  /** @type {Set<number>} */
  const values = new Set();
  let hasError = false;

  const tokens = sanitized.split(/[\s,]+/).filter((t) => t.length > 0);

  for (const token of tokens) {
    if (token.includes("-")) {
      // Keep behavior tolerant while typing:
      // - "5-" or "-7" should not be treated as an error, just ignored until complete.
      // - "5-7-8" is interpreted as "5-7" (extra segments are ignored), matching previous behavior.
      const parts = token.split("-").map((s) => s.trim());
      const nonEmpty = parts.filter((s) => s.length > 0);
      if (nonEmpty.length < 2) continue;

      const start = parseInt(nonEmpty[0], 10);
      const end = parseInt(nonEmpty[1], 10);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;

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
      const n = parseInt(token, 10);
      if (Number.isNaN(n)) continue;
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
function validateRuleInput(input) {
  const parsed = parseRuleNumbers(input.value);

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

    // The game rule preset itself is not stored in the URL, but Survival/Birth are.
    requestUrlSync();
  }
}

/**
 * Handle manual rule input change - validate and switch to custom preset
 */
function handleRuleInputChange() {
  // Validate inputs
  const surviveValid = validateRuleInput(surviveInput);
  const birthValid = validateRuleInput(birthInput);

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

  requestUrlSync();
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
  // Stop play mode and wait for any in-flight step
  stopPlaying();
  await waitForIdle();

  await queueStep(true);
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

function toggleFullscreen() {
  if (!getFullscreenElement()) {
    requestFullscreen(app || canvas)
      .then(updateFullscreenIcons)
      .catch((err) => {
        console.log("Fullscreen error:", err);
      });
  } else {
    exitFullscreen()
      .then(updateFullscreenIcons)
      .catch((err) => {
        console.log("Exit fullscreen error:", err);
      });
  }
}

document.addEventListener("fullscreenchange", updateFullscreenIcons);
document.addEventListener("webkitfullscreenchange", updateFullscreenIcons);

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

  // Screen show starts with Run and runs until paused/stepped/reset.
  if (state.screenshow.enabled) {
    if (screenShow) screenShow.startFromRun();
  }

  loop.startPlaying();
}

/**
 * Reset to new random state
 */
async function reset() {
  stopPlaying();
  await waitForIdle();

  renderer.resetView();
  state.sim.generation = 0;
  await renderer.randomize(state.settings.density, state.settings.initSize);
  state.sim.population = renderer.population;
  state.sim.populationGeneration = state.sim.generation;
  updateStats();
  requestRender();
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

  requestUrlSync();
}

/**
 * Handle grid size input change
 */
async function handleSizeChange() {
  let value = parseInt(sizeInput.value, 10);
  const wrapper = sizeInput.parentElement;

  if (isNaN(value) || value < 4) {
    value = 4;
  } else {
    const max =
      renderer && typeof renderer.getMaxSupportedGridSize === "function"
        ? renderer.getMaxSupportedGridSize()
        : 256;
    if (value > max) value = max;
  }

  sizeInput.value = value;
  setInvalid(wrapper, false);

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
      requestRender(true);
    } catch (e) {
      // Grid size too large for GPU
      console.error("Grid size error:", e.message);
      // Revert to previous grid size
      sizeInput.value = state.settings.gridSize;
      value = state.settings.gridSize;
    }
  } else {
    state.settings.gridSize = value;
  }

  requestUrlSync();
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
 * Handle initial size input change
 */
async function handleInitSizeChange() {
  let value = parseInt(initSizeInput.value, 10);
  const wrapper = initSizeInput.parentElement;

  if (isNaN(value) || value < 2) {
    value = 2;
  } else if (value > state.settings.gridSize) {
    value = state.settings.gridSize;
  }

  initSizeInput.value = value;
  setInvalid(wrapper, false);
  state.settings.initSize = value;

  // Apply immediately when simulation is not running (on blur/change as well as Enter).
  if (!state.sim.isPlaying) {
    await waitForIdle();
    state.sim.generation = 0;
    await renderer.randomize(state.settings.density, state.settings.initSize);
    state.sim.population = renderer.population;
  state.sim.populationGeneration = state.sim.generation;
    updateStats();
    requestRender();
  }

  requestUrlSync();
}

/**
 * Validate init size input
 */
function validateInitSizeInput() {
  const value = parseInt(initSizeInput.value, 10);
  const wrapper = initSizeInput.parentElement;

  setInvalid(wrapper, isNaN(value) || value < 2 || value > state.settings.gridSize);
}

/**
 * Handle Enter key on initial size input
 */
function handleInitSizeKeydown(e) {
  blurOnEnter(e, initSizeInput);
}

/**
 * Preview state.settings.density value while dragging (show tooltip only)
 */
function handleDensityPreview() {
  const previewValue = parseInt(densitySlider.value, 10);
  densityTip.textContent = previewValue + "%";
  densityTip.classList.add("visible");
}

/**
 * Handle state.settings.density slider change (on release)
 */
function handleDensityChange() {
  state.settings.density = parseInt(densitySlider.value, 10) / 100;
  densityTip.textContent = Math.round(state.settings.density * 100) + "%";

  clearTimeout(densityTip.hideTimeout);
  densityTip.hideTimeout = setTimeout(() => {
    densityTip.classList.remove("visible");
  }, 1000);

  requestUrlSync();

  // Only apply state.settings.density if simulation is not running
  if (!state.sim.isPlaying) {
    reset();
  }
}

/**
 * Handle cell color picker change
 */
function handleCellColorChange() {
  renderer.setCellColors(cellColorPicker.value, cellColorPicker2.value);
  requestRender();
  requestUrlSync();
}

/**
 * Handle background color picker change
 */
function handleBgColorChange() {
  renderer.setBackgroundColors(bgColorPicker.value, bgColorPicker2.value);
  requestRender();
  requestUrlSync();
}

/**
 * Handle lantern lighting toggle
 */
function handleLanternChange() {
  renderer.setLanternLightingEnabled(
    !!(lanternCheckbox && lanternCheckbox.checked),
  );
  requestRender();
  requestUrlSync();
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
  requestUrlSync();
}

/**
 * Capture the current trackball camera state (for restoring after Screen show).
 */
/**
 * Start Screen show from the current view by dimming out first, then teleporting
 * to a new pass start while dimmed and fading back in.
 *
 * This is used specifically when the user presses Run while Screen show is enabled.
 */
// Random value in [a,b] with a mild bias toward the center of the interval.
// This keeps endpoints reachable while making mid-range starts slightly more common.
/**
 * Estimate whether "fly-through" camera starts (inside/boundary of the cube) are likely to be visually useful.
 * We down-weight fly-through as the overall state.sim.population state.settings.density increases, or as the live cluster radius approaches the cube size.
 *
 * @param {number} density Population / totalCells, in [0..1].
 * @param {number} focusRadius Live cluster radius in world units.
 * @param {number} cubeHalf Half-extent of the grid cube in world units.
 * @returns {number} Factor in [0..1] (1 = fly-through encouraged, 0 = fly-through discouraged).
 */
/**
 * Build the (inside/boundary/outside) category weights for start-point selection.
 * The target mix is ~60/30/10 when fly-through is plausible, and shifts toward outside views otherwise.
 */

/**
 * Pick a Screen show start eye point in world space.
 *
 * Distribution target (when fly-through is plausible):
 *   - ~60% inside the cube,
 *   - ~30% inside but near the boundary,
 *   - ~10% outside the cube.
 *
 * @param {number[]} focusCenter Screen show focus center (world coords).
 * @param {number} focusRadius Screen show focus radius (world coords).
 * @param {number} minDist Minimum allowed distance from focusCenter.
 * @param {number} maxDist Maximum allowed distance from focusCenter.
 * @param {number} gs Grid size.
 * @param {number} cs Cell size.
 * @param {number} flyThroughFactor Fly-through factor in [0..1] (1 = fly-through encouraged).
 * @param {null|{min:number[], max:number[]}} aabbWorld Live AABB in world coords, used as a coarse "no-fly" region.
 * @returns {number[]} eye position [x,y,z] in world coords.
 */
/**
 * Start a new camera pass (or restart the current one).
 */
/**
 * Update the Screen show camera for the current frame.
 *
 * @returns {boolean} True if the camera changed and a render is needed.
 */
function handleGridProjectionChange() {
  renderer.setGridProjectionEnabled(
    !!(gridProjectionCheckbox && gridProjectionCheckbox.checked),
  );
  requestRender();
  requestUrlSync();
}

/**
 * Handle toroidal checkbox change
 */
function handleToroidalChange() {
  renderer.setToroidal(toroidalCheckbox.checked);
  requestUrlSync();
}

function handleStableStopChange() {
  if (!renderer || !stableStopCheckbox) return;
  renderer.setChangeDetectionEnabled(stableStopCheckbox.checked);
  requestUrlSync();
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
  console.error("Failed to initialize:", err);
});