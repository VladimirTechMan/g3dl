import { createThrottledControl } from "../ui/throttledControl.js";
import { createContinuousInputController } from "../ui/continuousInput.js";

/**
 * Small renderer-setting handlers.
 *
 * These are straightforward UI->renderer bridges, but they are grouped here
 * to keep the main app module focused on orchestration.
 */

/**
 * @typedef {Object} RendererSettingsDeps
 * @property {() => any} getRenderer
 * @property {() => any} getScreenShow
 * @property {(force?: boolean) => void} requestRender
 * @property {HTMLInputElement | null} cellColorPicker
 * @property {HTMLInputElement | null} cellColorPicker2
 * @property {HTMLInputElement | null} bgColorPicker
 * @property {HTMLInputElement | null} bgColorPicker2
 * @property {HTMLInputElement | null} toroidalCheckbox
 * @property {HTMLInputElement | null} stableStopCheckbox
 * @property {HTMLInputElement | null} hazeSlider
 * @property {HTMLInputElement | null} lanternCheckbox
 * @property {HTMLInputElement | null} screenShowCheckbox
 * @property {HTMLInputElement | null} gridProjectionCheckbox
 */

/**
 * @param {RendererSettingsDeps} deps
 */
export function createRendererSettingsHandlers(deps) {
  const {
    getRenderer,
    getScreenShow,
    requestRender,
    cellColorPicker,
    cellColorPicker2,
    bgColorPicker,
    bgColorPicker2,
    toroidalCheckbox,
    stableStopCheckbox,
    hazeSlider,
    lanternCheckbox,
    screenShowCheckbox,
    gridProjectionCheckbox,
  } = deps;

  // Haze slider: coalesce frequent 'input' events during pointer drags to keep the UI responsive.
  // Haze is purely visual, so commit == preview.
  function clampHazeStrengthFromSlider() {
    if (!hazeSlider) return 0.0;
    const pct = parseInt(hazeSlider.value, 10);
    const clampedPct = Number.isFinite(pct) ? Math.max(0, Math.min(30, pct)) : 0;
    return clampedPct * 0.01;
  }

  function applyHazeStrength(strength) {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.setHazeStrength?.(strength);
    requestRender();
  }

  const hazeControl = createContinuousInputController({
    input: hazeSlider,
    getValue: clampHazeStrengthFromSlider,
    applyPreview: applyHazeStrength,
    applyCommit: applyHazeStrength,
    previewIntervalMs: 33,
    commitSuppressMs: 250,
    captureTarget: hazeSlider,
  });

  const handleHazePreview = hazeControl.handlePreview;
  const handleHazeChange = hazeControl.handleChange;
  const handleHazePointerDown = hazeControl.handlePointerDown;
  const handleHazePointerUpGlobal = hazeControl.handlePointerUpGlobal;
  const handleHazeBlur = hazeControl.handleBlur;

  function applyCellColors() {
    const renderer = getRenderer();
    if (!renderer || !cellColorPicker || !cellColorPicker2) return;
    renderer.setCellColors(cellColorPicker.value, cellColorPicker2.value);
    requestRender();
  }

  function getCellColorsKey() {
    if (!cellColorPicker || !cellColorPicker2) return "";
    return `${cellColorPicker.value}|${cellColorPicker2.value}`;
  }

  // Some engines emit very frequent 'input' events while the OS color picker is open.
  // Treat that interaction like a continuous drag and coalesce updates to keep the UI responsive.
  const cellColorsControl = createThrottledControl({
    getValue: getCellColorsKey,
    applyPreview: () => applyCellColors(),
    applyCommit: () => applyCellColors(),
    previewIntervalMs: 33,
    commitSuppressMs: 250,
    captureTarget: cellColorPicker,
  });

  /**
   * @param {Event | any} e
   */
  function handleCellColorPreview(e) {
    // For OS-native pickers, treat repeated 'input' as a continuous session.
    cellColorsControl.beginSession(e);
    cellColorsControl.preview();
  }

  function handleCellColorCommit() {
    cellColorsControl.endSession(true);
  }

  function applyBgColors() {
    const renderer = getRenderer();
    if (!renderer || !bgColorPicker || !bgColorPicker2) return;
    renderer.setBackgroundColors(bgColorPicker.value, bgColorPicker2.value);
    requestRender();
  }

  function getBgColorsKey() {
    if (!bgColorPicker || !bgColorPicker2) return "";
    return `${bgColorPicker.value}|${bgColorPicker2.value}`;
  }

  const bgColorsControl = createThrottledControl({
    getValue: getBgColorsKey,
    applyPreview: () => applyBgColors(),
    applyCommit: () => applyBgColors(),
    previewIntervalMs: 33,
    commitSuppressMs: 250,
    captureTarget: bgColorPicker,
  });

  /**
   * @param {Event | any} e
   */
  function handleBgColorPreview(e) {
    bgColorsControl.beginSession(e);
    bgColorsControl.preview();
  }

  function handleBgColorCommit() {
    bgColorsControl.endSession(true);
  }


  function handleLanternChange() {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.setLanternLightingEnabled(!!(lanternCheckbox && lanternCheckbox.checked));
    requestRender();
  }

  function handleScreenShowChange() {
    const enabled = !!(screenShowCheckbox && screenShowCheckbox.checked);
    const ss = getScreenShow();
    if (ss) ss.setEnabled(enabled);
    requestRender(true);
  }

  function handleGridProjectionChange() {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.setGridProjectionEnabled(!!(gridProjectionCheckbox && gridProjectionCheckbox.checked));
    requestRender();
  }

  function handleToroidalChange() {
    const renderer = getRenderer();
    if (!renderer || !toroidalCheckbox) return;
    renderer.setToroidal(toroidalCheckbox.checked);
    requestRender();
  }

  function handleStableStopChange() {
    const renderer = getRenderer();
    if (!renderer || !stableStopCheckbox) return;
    renderer.setChangeDetectionEnabled(stableStopCheckbox.checked);
  }

  return {
    handleCellColorPreview,
    handleCellColorCommit,
    handleBgColorPreview,
    handleBgColorCommit,
    handleHazePreview,
    handleHazeChange,
    handleHazePointerDown,
    handleHazePointerUpGlobal,
    handleHazeBlur,
    handleLanternChange,
    handleScreenShowChange,
    handleGridProjectionChange,
    handleToroidalChange,
    handleStableStopChange,
  };
}
