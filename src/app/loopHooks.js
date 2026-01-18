/**
 * Loop hooks for the main application.
 *
 * The LoopController is responsible for scheduling simulation steps and rendering.
 * These hooks connect LoopController events to application state, UI, and optional
 * subsystems (OrbitControls and ScreenShow).
 *
 * This module is intentionally UI-framework-agnostic: callers inject the minimal
 * dependencies (getters and callbacks) needed to keep LoopController independent
 * from app-level module state.
 */

/**
 * @typedef {object} LoopHooksDeps
 * @property {any} state
 * @property {HTMLElement|null} playIcon
 * @property {HTMLElement|null} pauseIcon
 * @property {() => any|null} getRenderer
 * @property {() => any|null} getOrbitControls
 * @property {() => any|null} getScreenShow
 * @property {() => void} updateStats
 * @property {() => void} stopPlaying
 * @property {() => void} disableScreenShowDueToEmpty
 * @property {(err: any) => void} handleStepError
 */

/**
 * Create the LoopController hooks object.
 *
 * @param {LoopHooksDeps} deps
 */
export function createLoopHooks(deps) {
  const {
    state,
    playIcon,
    pauseIcon,
    getRenderer,
    getOrbitControls,
    getScreenShow,
    updateStats,
    stopPlaying,
    disableScreenShowDueToEmpty,
    handleStepError,
  } = deps;

  return {
    isInteracting: () => {
      const oc = getOrbitControls();
      return oc ? oc.isInteracting() : false;
    },

    updateScreenShow: (ts) => {
      const ss = getScreenShow();
      return ss ? ss.update(ts) : false;
    },

    updateInertia: () => {
      // Apply inertial camera motion only when the user has control (i.e., Screen show
      // is not actively driving the camera) and the user is not currently interacting.
      const ss = getScreenShow();
      const navLocked = !!(ss && ss.isNavLocked());
      if (navLocked) return false;

      const oc = getOrbitControls();
      if (oc && oc.isInteracting()) return false;

      const r = getRenderer();
      return r ? r.updateInertia() : false;
    },

    getSpeedDelayMs: () => state.settings.speed,

    getAutoStopEnabled: () => {
      // Auto-stop (stable configuration) is disabled while Screen show is actively running.
      // Empty grids are still auto-stopped by the loop controller.
      const ss = getScreenShow();
      return !(ss && ss.isNavLocked());
    },

    onPlayStateChanged: (playing) => {
      state.sim.isPlaying = playing;

      if (playIcon) playIcon.hidden = playing;
      if (pauseIcon) pauseIcon.hidden = !playing;

      document.body.classList.toggle("playing", playing);

      const ss = getScreenShow();
      if (ss) ss.onPlayStateChanged(playing);
    },

    onAfterStep: ({ syncStats, changed }) => {
      // Note: the params are kept to preserve the hook signature even if they are not
      // used directly here.
      void syncStats;
      void changed;

      const r = getRenderer();
      if (!r) return { statsFresh: false, population: state.sim.population };

      state.sim.generation = r.generation;

      // In async-stats mode, renderer.population may lag; only update HUD when stats are fresh.
      const statsFresh = r.statsValidGeneration === state.sim.generation;
      if (statsFresh) {
        state.sim.population = r.population;
        state.sim.populationGeneration = state.sim.generation;
      }

      updateStats();
      if (statsFresh && state.screenshow.enabled && state.sim.population === 0) {
        disableScreenShowDueToEmpty();
      }
      return { statsFresh, population: state.sim.population };
    },

    onPopulationReadback: (res) => {
      // Accept monotonic updates only (avoid showing older readbacks that complete late).
      if (res.generation >= state.sim.populationGeneration && res.generation <= state.sim.generation) {
        state.sim.population = res.population;
        state.sim.populationGeneration = res.generation;
        updateStats();

        // Auto-stop on empty even when stats are sampled asynchronously (fast-play mode).
        // This ensures Screen show (and play mode) exits promptly when the grid becomes empty.
        if (res.population === 0) {
          if (state.screenshow.enabled) disableScreenShowDueToEmpty();
          if (state.sim.isPlaying) stopPlaying();
        }
      }
    },

    onStepError: (err) => {
      handleStepError(err);
    },
  };
}
