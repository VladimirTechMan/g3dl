/**
 * Application state model.
 *
 * This module intentionally holds the mutable state that used to be spread across
 * `app.js`. Keeping it centralized improves readability and makes future refactors
 * safer (humans + AI agents have a single source of truth).
 *
 * NOTE: AppState is the canonical source of *defaults*. During runtime, UI controls
 * (DOM) are still authoritative (the state mirrors those values for scheduling decisions,
 * renderer calls, and URL sharing).
 */

/**
 * @typedef {import("./screenshow/controller.js").ScreenShowPass} ScreenShowPass
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
    // When pendingStartTimer is scheduled, this records the (performance.now()) timestamp
    // when the fade-out window completes and the teleport should occur.
    pendingStartDueMs: 0,
    // Timebase suspension (tab backgrounding): we freeze Screen show progress by shifting
    // pass timestamps forward by the hidden duration. These fields support that policy.
    timebasePaused: false,
    timebasePauseStartMs: 0,
    pendingStartRemainingMs: 0,
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

    // One-shot hint for the *next* Screen show pass: when Run is started from
    // generation 0, begin slightly outside the Gen0 initialization cube (the
    // "Gen0 edge" region) to provide a clearer initial establishing view.
    //
    // This flag is set in ScreenShowController.startFromRun() and consumed
    // (then cleared) by ScreenShowController.startPass().
    forceOutsideInitCubeOnce: false,
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
      gridSize: 128,
      initSize: 96,
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
