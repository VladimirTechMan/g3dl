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

  add(d.cellColorPicker, "input", handlers.handleCellColorChange);
  add(d.cellColorPicker2, "input", handlers.handleCellColorChange);
  add(d.bgColorPicker, "input", handlers.handleBgColorChange);
  add(d.bgColorPicker2, "input", handlers.handleBgColorChange);

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
  // The button is present in the DOM but hidden unless ?debug=1 is set.
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
