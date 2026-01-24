/**
 * UI control bindings (non-panel elements).
 *
 * This module wires control widgets (buttons, sliders, inputs, checkboxes) to
 * app-provided handlers. It does not manage panels/overlays.
 */

import { on } from "../util/events.js";

/**
 * @param {import("./dom.js").DomCache} dom
 * @param {any} handlers
 * @returns {{ destroy: () => void }}
 */
export function bindControls(dom, handlers) {
  /** @type {Array<() => void>} */
  const unsubs = [];
  const add = (el, type, fn, opts) => {
    if (!el) return;
    unsubs.push(on(el, type, fn, opts));
  };

  // Prefer a single access path for cached elements.
  // This avoids repeating long destructuring lists (and reduces drift risk when the UI evolves).
  const d = dom;

  // Control buttons
  add(d.stepBtn, "click", handlers.step);
  add(d.playBtn, "click", handlers.togglePlay);
  add(d.resetBtn, "click", handlers.reset);
  add(d.fullscreenBtn, "click", handlers.toggleFullscreen);

  // Sliders and inputs
  add(d.speedSlider, "input", handlers.handleSpeedPreview);
  add(d.speedSlider, "change", handlers.handleSpeedChange);

  add(d.sizeInput, "change", handlers.handleSizeChange);
  add(d.sizeInput, "input", handlers.validateSizeInput);
  add(d.sizeInput, "keydown", handlers.handleSizeKeydown);

  add(d.initSizeInput, "change", handlers.handleInitSizeChange);
  add(d.initSizeInput, "input", handlers.validateInitSizeInput);
  add(d.initSizeInput, "keydown", handlers.handleInitSizeKeydown);

  add(d.densitySlider, "input", handlers.handleDensityPreview);
  add(d.densitySlider, "change", handlers.handleDensityChange);

  // Haze is a purely visual effect, so we apply it immediately on drag.
  add(d.hazeSlider, "input", handlers.handleHazePreview);
  add(d.hazeSlider, "change", handlers.handleHazeChange);

  // Throttle visual slider updates during pointer drags to keep the UI responsive
  // on mobile devices. The handler is optional so platforms that do not need
  // special handling can keep the simple input/change path.
  if (handlers.handleHazePointerDown) {
    add(d.hazeSlider, "pointerdown", handlers.handleHazePointerDown);
  }
  if (handlers.handleHazePointerUpGlobal) {
    add(window, "pointerup", handlers.handleHazePointerUpGlobal, {
      passive: true,
    });
    add(window, "pointercancel", handlers.handleHazePointerUpGlobal, {
      passive: true,
    });
  }
  if (handlers.handleHazeBlur) {
    add(d.hazeSlider, "blur", handlers.handleHazeBlur);
  }

  // Ensure the density tooltip cannot get "stuck" visible if the pointer is released
  // outside the slider (some browsers do not always dispatch a 'change' in that case).
  if (handlers.handleDensityPointerDown) {
    add(d.densitySlider, "pointerdown", handlers.handleDensityPointerDown);
  }
  if (handlers.handleDensityPointerUpGlobal) {
    add(window, "pointerup", handlers.handleDensityPointerUpGlobal, {
      passive: true,
    });
    add(window, "pointercancel", handlers.handleDensityPointerUpGlobal, {
      passive: true,
    });
  }
  if (handlers.handleDensityBlur) {
    add(d.densitySlider, "blur", handlers.handleDensityBlur);
  }
  if (handlers.handleDensityMouseLeave) {
    add(d.densitySlider, "mouseleave", handlers.handleDensityMouseLeave);
  }

  // Color pickers can emit very frequent 'input' events (especially on mobile OS pickers),
  // so preview updates may be throttled by the controller.
  add(d.cellColorPicker, "input", handlers.handleCellColorPreview);
  add(d.cellColorPicker2, "input", handlers.handleCellColorPreview);
  add(d.bgColorPicker, "input", handlers.handleBgColorPreview);
  add(d.bgColorPicker2, "input", handlers.handleBgColorPreview);

  // Commit final colors when the picker closes or the input loses focus.
  add(d.cellColorPicker, "change", handlers.handleCellColorCommit);
  add(d.cellColorPicker2, "change", handlers.handleCellColorCommit);
  add(d.bgColorPicker, "change", handlers.handleBgColorCommit);
  add(d.bgColorPicker2, "change", handlers.handleBgColorCommit);

  add(d.cellColorPicker, "blur", handlers.handleCellColorCommit);
  add(d.cellColorPicker2, "blur", handlers.handleCellColorCommit);
  add(d.bgColorPicker, "blur", handlers.handleBgColorCommit);
  add(d.bgColorPicker2, "blur", handlers.handleBgColorCommit);

  // Game rule preset and rule inputs
  add(d.presetSelect, "change", handlers.handlePresetChange);
  add(d.surviveInput, "input", handlers.handleRuleInputChange);
  add(d.birthInput, "input", handlers.handleRuleInputChange);
  // Use "change" (blur/commit) for commit-only behaviors (e.g., toast warnings).
  add(d.surviveInput, "change", handlers.handleRuleInputChange);
  add(d.birthInput, "change", handlers.handleRuleInputChange);
  add(d.surviveInput, "keydown", handlers.handleRuleKeydown);
  add(d.birthInput, "keydown", handlers.handleRuleKeydown);

  // Toggles
  add(d.toroidalCheckbox, "change", handlers.handleToroidalChange);
  add(d.stableStopCheckbox, "change", handlers.handleStableStopChange);
  add(d.lanternCheckbox, "change", handlers.handleLanternChange);
  add(d.screenShowCheckbox, "change", handlers.handleScreenShowChange);
  add(d.gridProjectionCheckbox, "change", handlers.handleGridProjectionChange);

  if (d.copyUrlBtn) {
    add(d.copyUrlBtn, "click", () => handlers.handleCopyUrlButton());
  }

  // Debug-only: correctness self-test button.
  // The button is present in the DOM but hidden unless debug mode is enabled
  // via the URL (e.g., ?debug or ?debug=1).
  if (d.selfTestBtn && typeof handlers.handleSelfTestButton === "function") {
    add(d.selfTestBtn, "click", () => handlers.handleSelfTestButton());
  }

  // Keyboard shortcuts
  add(document, "keydown", handlers.handleKeyDown);

  return {
    destroy() {
      for (const u of unsubs.splice(0)) {
        try {
          u();
        } catch (_) {}
      }
    },
  };
}
