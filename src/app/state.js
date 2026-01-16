/**
 * Application state model.
 *
 * This module intentionally holds the mutable state that used to be spread across
 * `app.js`. Keeping it centralized improves readability and makes future refactors
 * safer (humans + AI agents have a single source of truth).
 *
 * NOTE: UI controls (DOM) remain the authoritative source for many settings. The
 * state mirrors those values for scheduling decisions, renderer calls, and URL sharing.
 */

/**
 * @typedef {Object} ScreenShowPass
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} fadeInEndMs
 * @property {number} fadeOutStartMs
 * @property {number} yaw0
 * @property {number} yaw1
 * @property {number} pitch0
 * @property {number} pitch1
 * @property {number} dist0
 * @property {number} dist1
 */

/**
 * @typedef {Object} ScreenShowState
 * @property {ScreenShowPass|null} pass
 * @property {boolean} pendingStart
 * @property {number|null} pendingStartTimer
 * @property {number} pendingStartToken
 * @property {[number, number, number]} focusCenter
 * @property {number} focusRadius
 * @property {number} focusCount
 * @property {boolean} focusCountValid
 * @property {number} lastAabbRequestMs
 * @property {boolean} dimmed
 * @property {any|null} smoothEye
 * @property {any|null} smoothTarget
 * @property {any|null} smoothUp
 * @property {boolean} smoothReset
 * @property {number} lastSmoothMs
 */

/**
 * @typedef {Object} AppState
 * @property {{
 *   speed: number,
 *   gridSize: number,
 *   initSize: number,
 *   density: number,
 * }} settings
 * @property {{
 *   isPlaying: boolean,
 *   generation: number,
 *   population: number,
 *   populationGeneration: number,
 * }} sim
 * @property {{
 *   enabled: boolean,
 *   navLocked: boolean,
 *   savedCamera: any|null,
 *   state: ScreenShowState,
 * }} screenshow
 */

/**
 * @returns {ScreenShowState}
 */
function createScreenShowState() {
  return {
    pass: null,
    pendingStart: false,
    pendingStartTimer: null,
    pendingStartToken: 0,
    focusCenter: [0, 0, 0],
    focusRadius: 1,
    focusCount: 0,
    focusCountValid: false,
    lastAabbRequestMs: 0,
    dimmed: false,
    smoothEye: null,
    smoothTarget: null,
    smoothUp: null,
    smoothReset: false,
    lastSmoothMs: 0,
  };
}

/**
 * Create initial mutable app state.
 *
 * Values here must match the defaults previously used in app.js.
 *
 * @returns {AppState}
 */
export function createAppState() {
  return {
    settings: {
      speed: 300,
      gridSize: 96,
      initSize: 64,
      density: 0.15,
    },
    sim: {
      isPlaying: false,
      generation: 0,
      population: 0,
      populationGeneration: 0,
    },
    screenshow: {
      enabled: false,
      navLocked: false,
      savedCamera: null,
      state: createScreenShowState(),
    },
  };
}
