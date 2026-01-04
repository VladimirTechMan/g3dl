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
 * @type {{
 *   canvas: HTMLCanvasElement|null,
 *   app: HTMLElement|null,
 *   stepBtn: HTMLButtonElement|null,
 *   playBtn: HTMLButtonElement|null,
 *   resetBtn: HTMLButtonElement|null,
 *   settingsBtn: HTMLButtonElement|null,
 *   helpBtn: HTMLButtonElement|null,
 *   fullscreenBtn: HTMLButtonElement|null,
 *   fullscreenEnterIcon: SVGElement|null,
 *   fullscreenExitIcon: SVGElement|null,
 *   settingsPanel: HTMLElement|null,
 *   helpPanel: HTMLElement|null,
 *   controls: HTMLElement|null,
 *   buttonRow: HTMLElement|null,
 *   playIcon: SVGElement|null,
 *   pauseIcon: SVGElement|null,
 *   speedSlider: HTMLInputElement|null,
 *   sizeInput: HTMLInputElement|null,
 *   initSizeInput: HTMLInputElement|null,
 *   densitySlider: HTMLInputElement|null,
 *   densityTip: HTMLElement|null,
 *   cellColorPicker: HTMLInputElement|null,
 *   cellColorPicker2: HTMLInputElement|null,
 *   bgColorPicker: HTMLInputElement|null,
 *   bgColorPicker2: HTMLInputElement|null,
 *   presetSelect: HTMLSelectElement|null,
 *   surviveInput: HTMLInputElement|null,
 *   birthInput: HTMLInputElement|null,
 *   toroidalCheckbox: HTMLInputElement|null,
 *   stableStopCheckbox: HTMLInputElement|null,
 *   lanternCheckbox: HTMLInputElement|null,
 *   screenShowCheckbox: HTMLInputElement|null,
 *   copyUrlBtn: HTMLButtonElement|null,
 *   gridProjectionCheckbox: HTMLInputElement|null,
 *   generationDisplay: HTMLElement|null,
 *   populationDisplay: HTMLElement|null,
 *   statsPanel: HTMLElement|null,
 *   infoBtn: HTMLButtonElement|null,
 *   header: HTMLElement|null,
 * }}
 */
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
  };
})();

export const dom = Object.freeze(_dom);
