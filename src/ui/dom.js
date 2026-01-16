/**
 * DOM cache for the Game of 3D Life UI.
 *
 * Rationale:
 * - Centralizes element lookup and makes dependencies explicit.
 * - Reduces noise in controller code (humans and AI agents).
 *
 * This module assumes it is imported after the DOM is present.
 * In index.html, the entrypoint script is placed at the end of <body>.
 */

/**
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function byId(id) {
  return document.getElementById(id);
}

/**
 * Cached DOM references.
 *
 * This typedef is intentionally exported via JSDoc so other modules can use:
 *   @param {import("./dom.js").DomCache} dom
 *
 * @typedef {Object} DomCache
 * @property {HTMLCanvasElement|null} canvas
 * @property {HTMLElement|null} app
 * @property {HTMLButtonElement|null} stepBtn
 * @property {HTMLButtonElement|null} playBtn
 * @property {HTMLButtonElement|null} resetBtn
 * @property {HTMLButtonElement|null} settingsBtn
 * @property {HTMLButtonElement|null} helpBtn
 * @property {HTMLButtonElement|null} fullscreenBtn
 * @property {SVGElement|null} fullscreenEnterIcon
 * @property {SVGElement|null} fullscreenExitIcon
 * @property {HTMLElement|null} settingsPanel
 * @property {HTMLElement|null} helpPanel
 * @property {HTMLElement|null} controls
 * @property {HTMLElement|null} buttonRow
 * @property {SVGElement|null} playIcon
 * @property {SVGElement|null} pauseIcon
 * @property {HTMLInputElement|null} speedSlider
 * @property {HTMLInputElement|null} sizeInput
 * @property {HTMLInputElement|null} initSizeInput
 * @property {HTMLInputElement|null} densitySlider
 * @property {HTMLElement|null} densityTip
 * @property {HTMLInputElement|null} cellColorPicker
 * @property {HTMLInputElement|null} cellColorPicker2
 * @property {HTMLInputElement|null} bgColorPicker
 * @property {HTMLInputElement|null} bgColorPicker2
 * @property {HTMLSelectElement|null} presetSelect
 * @property {HTMLInputElement|null} surviveInput
 * @property {HTMLInputElement|null} birthInput
 * @property {HTMLInputElement|null} toroidalCheckbox
 * @property {HTMLInputElement|null} stableStopCheckbox
 * @property {HTMLInputElement|null} lanternCheckbox
 * @property {HTMLInputElement|null} screenShowCheckbox
 * @property {HTMLButtonElement|null} copyUrlBtn
 * @property {HTMLInputElement|null} gridProjectionCheckbox
 * @property {HTMLElement|null} generationDisplay
 * @property {HTMLElement|null} populationDisplay
 * @property {HTMLElement|null} statsPanel
 * @property {HTMLButtonElement|null} infoBtn
 * @property {HTMLElement|null} header
 * @property {HTMLElement|null} toast
 * @property {HTMLElement|null} toastMessage
 * @property {HTMLButtonElement|null} toastCloseBtn
 */
/** @type {DomCache} */
const _dom = (() => {
  const canvas = /** @type {HTMLCanvasElement|null} */ (byId("glCanvas"));
  const app = byId("app");
  const stepBtn = /** @type {HTMLButtonElement|null} */ (byId("stepBtn"));
  const playBtn = /** @type {HTMLButtonElement|null} */ (byId("playBtn"));
  const resetBtn = /** @type {HTMLButtonElement|null} */ (byId("resetBtn"));
  const settingsBtn = /** @type {HTMLButtonElement|null} */ (
    byId("settingsBtn")
  );
  const helpBtn = /** @type {HTMLButtonElement|null} */ (byId("helpBtn"));
  const fullscreenBtn = /** @type {HTMLButtonElement|null} */ (
    byId("fullscreenBtn")
  );
  const fullscreenEnterIcon = /** @type {SVGElement|null} */ (
    byId("fullscreenEnterIcon")
  );
  const fullscreenExitIcon = /** @type {SVGElement|null} */ (
    byId("fullscreenExitIcon")
  );
  const settingsPanel = byId("settings-panel");
  const helpPanel = byId("help-panel");
  const controls = byId("controls");
  const buttonRow = controls ? controls.querySelector(".button-row") : null;
  const playIcon = /** @type {SVGElement|null} */ (byId("playIcon"));
  const pauseIcon = /** @type {SVGElement|null} */ (byId("pauseIcon"));
  const speedSlider = /** @type {HTMLInputElement|null} */ (
    byId("speedSlider")
  );
  const sizeInput = /** @type {HTMLInputElement|null} */ (byId("sizeInput"));
  const initSizeInput = /** @type {HTMLInputElement|null} */ (
    byId("initSizeInput")
  );
  const densitySlider = /** @type {HTMLInputElement|null} */ (
    byId("densitySlider")
  );
  const densityTip = byId("densityTip");
  const cellColorPicker = /** @type {HTMLInputElement|null} */ (
    byId("cellColorPicker")
  );
  const cellColorPicker2 = /** @type {HTMLInputElement|null} */ (
    byId("cellColorPicker2")
  );
  const bgColorPicker = /** @type {HTMLInputElement|null} */ (
    byId("bgColorPicker")
  );
  const bgColorPicker2 = /** @type {HTMLInputElement|null} */ (
    byId("bgColorPicker2")
  );
  const presetSelect = /** @type {HTMLSelectElement|null} */ (
    byId("presetSelect")
  );
  const surviveInput = /** @type {HTMLInputElement|null} */ (
    byId("surviveInput")
  );
  const birthInput = /** @type {HTMLInputElement|null} */ (byId("birthInput"));
  const toroidalCheckbox = /** @type {HTMLInputElement|null} */ (
    byId("toroidalCheckbox")
  );
  const stableStopCheckbox = /** @type {HTMLInputElement|null} */ (
    byId("stableStopCheckbox")
  );
  const lanternCheckbox = /** @type {HTMLInputElement|null} */ (
    byId("lanternCheckbox")
  );
  const screenShowCheckbox = /** @type {HTMLInputElement|null} */ (
    byId("screenShowCheckbox")
  );
  const copyUrlBtn = /** @type {HTMLButtonElement|null} */ (byId("copyUrlBtn"));
  const gridProjectionCheckbox = /** @type {HTMLInputElement|null} */ (
    byId("gridProjectionCheckbox")
  );
  const generationDisplay = byId("generation");
  const populationDisplay = byId("population");

  const statsPanel = byId("stats");
  const infoBtn = /** @type {HTMLButtonElement|null} */ (byId("infoBtn"));
  const header = byId("header");

  const toast = byId("toast");
  const toastMessage = byId("toastMessage");
  const toastCloseBtn = /** @type {HTMLButtonElement|null} */ (
    byId("toastCloseBtn")
  );

  return {
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
    buttonRow: /** @type {HTMLElement|null} */ (buttonRow),
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
    toast,
    toastMessage,
    toastCloseBtn,
  };
})();

export const dom = Object.freeze(_dom);
