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

  add(d.cellColorPicker, "input", handlers.handleCellColorChange);
  add(d.cellColorPicker2, "input", handlers.handleCellColorChange);
  add(d.bgColorPicker, "input", handlers.handleBgColorChange);
  add(d.bgColorPicker2, "input", handlers.handleBgColorChange);

  // Game rule preset and rule inputs
  add(d.presetSelect, "change", handlers.handlePresetChange);
  add(d.surviveInput, "input", handlers.handleRuleInputChange);
  add(d.birthInput, "input", handlers.handleRuleInputChange);
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
