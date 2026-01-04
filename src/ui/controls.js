/**
 * UI control bindings (non-panel elements).
 *
 * This module wires control widgets (buttons, sliders, inputs, checkboxes) to
 * app-provided handlers. It does not manage panels/overlays.
 */

import { on } from "../util/events.js";

/**
 * @param {any} dom
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

  const {
    stepBtn,
    playBtn,
    resetBtn,
    fullscreenBtn,
    speedSlider,
    sizeInput,
    initSizeInput,
    densitySlider,
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
    copyUrlBtn,
  } = dom;

  // Control buttons
  add(stepBtn, "click", handlers.step);
  add(playBtn, "click", handlers.togglePlay);
  add(resetBtn, "click", handlers.reset);
  add(fullscreenBtn, "click", handlers.toggleFullscreen);

  // Sliders and inputs
  add(speedSlider, "input", handlers.handleSpeedPreview);
  add(speedSlider, "change", handlers.handleSpeedChange);

  add(sizeInput, "change", handlers.handleSizeChange);
  add(sizeInput, "input", handlers.validateSizeInput);
  add(sizeInput, "keydown", handlers.handleSizeKeydown);

  add(initSizeInput, "change", handlers.handleInitSizeChange);
  add(initSizeInput, "input", handlers.validateInitSizeInput);
  add(initSizeInput, "keydown", handlers.handleInitSizeKeydown);

  add(densitySlider, "input", handlers.handleDensityPreview);
  add(densitySlider, "change", handlers.handleDensityChange);

  add(cellColorPicker, "input", handlers.handleCellColorChange);
  add(cellColorPicker2, "input", handlers.handleCellColorChange);
  add(bgColorPicker, "input", handlers.handleBgColorChange);
  add(bgColorPicker2, "input", handlers.handleBgColorChange);

  // Game rule preset and rule inputs
  add(presetSelect, "change", handlers.handlePresetChange);
  add(surviveInput, "input", handlers.handleRuleInputChange);
  add(birthInput, "input", handlers.handleRuleInputChange);
  add(surviveInput, "keydown", handlers.handleRuleKeydown);
  add(birthInput, "keydown", handlers.handleRuleKeydown);

  // Toggles
  add(toroidalCheckbox, "change", handlers.handleToroidalChange);
  add(stableStopCheckbox, "change", handlers.handleStableStopChange);
  add(lanternCheckbox, "change", handlers.handleLanternChange);
  add(screenShowCheckbox, "change", handlers.handleScreenShowChange);
  add(gridProjectionCheckbox, "change", handlers.handleGridProjectionChange);

  if (copyUrlBtn) add(copyUrlBtn, "click", () => handlers.handleCopyUrlButton());

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
