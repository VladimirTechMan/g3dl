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
    lanternCheckbox,
    screenShowCheckbox,
    gridProjectionCheckbox,
  } = deps;

  function handleCellColorChange() {
    const renderer = getRenderer();
    if (!renderer || !cellColorPicker || !cellColorPicker2) return;
    renderer.setCellColors(cellColorPicker.value, cellColorPicker2.value);
    requestRender();
  }

  function handleBgColorChange() {
    const renderer = getRenderer();
    if (!renderer || !bgColorPicker || !bgColorPicker2) return;
    renderer.setBackgroundColors(bgColorPicker.value, bgColorPicker2.value);
    requestRender();
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
    handleCellColorChange,
    handleBgColorChange,
    handleLanternChange,
    handleScreenShowChange,
    handleGridProjectionChange,
    handleToroidalChange,
    handleStableStopChange,
  };
}
