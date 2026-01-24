/**
 * UI event bindings facade.
 *
 * This module preserves a stable bindUI(dom, handlers) API while delegating
 * implementation details to smaller, cohesive modules:
 * - controls.js: buttons/sliders/inputs/checkboxes
 * - panels.js: Settings/Help/About panel UX and wheel capture policy
 */

import { bindControls } from "./controls.js";
import { createPanelManager } from "./panels.js";

/**
 * @typedef {Object} BindUiHandlers
 * @property {(e?: Event) => void | Promise<void>} step
 * @property {(e?: Event) => void} togglePlay
 * @property {(e?: Event) => void | Promise<void>} reset
 * @property {(e?: Event) => void} toggleFullscreen
 * @property {(e?: Event) => void} handleSpeedPreview
 * @property {(e?: Event) => void} handleSpeedChange
 * @property {(e?: Event) => void | Promise<void>} handleSizeChange
 * @property {(e?: Event) => void} validateSizeInput
 * @property {(e: KeyboardEvent) => void} handleSizeKeydown
 * @property {(e?: Event) => void | Promise<void>} handleInitSizeChange
 * @property {(e?: Event) => void} validateInitSizeInput
 * @property {(e: KeyboardEvent) => void} handleInitSizeKeydown
 * @property {(e?: Event) => void} handleDensityPreview
 * @property {(e?: Event) => void | Promise<void>} handleDensityChange
 * @property {(e?: PointerEvent) => void} [handleDensityPointerDown]
 * @property {(e?: PointerEvent) => void} [handleDensityPointerUpGlobal]
 * @property {(e?: FocusEvent) => void} [handleDensityBlur]
 * @property {(e?: MouseEvent) => void} [handleDensityMouseLeave]
 * @property {(e?: Event) => void} handleCellColorChange
 * @property {(e?: Event) => void} handleBgColorChange
 * @property {(e?: Event) => void} handlePresetChange
 * @property {(e?: Event) => void} handleRuleInputChange
 * @property {(e: KeyboardEvent) => void} handleRuleKeydown
 * @property {(e?: Event) => void} handleHazePreview
 * @property {(e?: Event) => void} handleHazeChange
 * @property {(e?: PointerEvent) => void} [handleHazePointerDown]
 * @property {(e?: PointerEvent) => void} [handleHazePointerUpGlobal]
 * @property {(e?: FocusEvent) => void} [handleHazeBlur]
 * @property {(e?: MouseEvent) => void} [handleHazeMouseLeave]
 * @property {(e?: Event) => void} handleLanternChange
 * @property {(e?: Event) => void} handleScreenShowChange
 * @property {(e?: Event) => void} handleGridProjectionChange
 * @property {(e?: Event) => void} handleToroidalChange
 * @property {(e?: Event) => void} handleStableStopChange
 * @property {() => void} handleCopyUrlButton
 * @property {() => void | Promise<void>} [handleSelfTestButton]
 * @property {(e: KeyboardEvent) => void} handleKeyDown
 * @property {(e?: WheelEvent) => void} [routeWheelToScene]
 */

/**
 * @param {import("./dom.js").DomCache} dom
 * @param {BindUiHandlers} handlers
 * @returns {{
 *   destroy: () => void,
 *   closeSettingsAndHelpPanels: () => void,
 *   closeAllPanels: () => void,
 *   isAnyPanelOpen: () => boolean,
 * }}
 */
export function bindUI(dom, handlers) {
  // Preserve historical listener registration order:
  // 1) general controls (keyboard shortcuts, buttons, sliders)
  // 2) panel UX (Escape handling, wheel capture, global tap dismissal)
  const controls = bindControls(dom, handlers);
  const panels = createPanelManager(dom, handlers);

  return {
    destroy() {
      try {
        panels.destroy();
      } catch (_) {}
      try {
        controls.destroy();
      } catch (_) {}
    },
    closeSettingsAndHelpPanels: panels.closeSettingsAndHelpPanels,
    closeAllPanels: panels.closeAllPanels,
    isAnyPanelOpen: panels.isAnyPanelOpen,
  };
}
