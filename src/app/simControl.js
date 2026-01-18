/**
 * Simulation control controller.
 *
 * This module centralizes the application's imperative simulation controls:
 * - step
 * - run/pause
 * - reset (randomize)
 * - sticky step-failure error policy
 *
 * It is intentionally UI-framework agnostic and does not register any DOM event
 * listeners. It operates through injected dependencies and getters.
 */

/**
 * @typedef {Object} SimControllerDeps
 * @property {{
 *   settings: { density: number, initSize: number },
 *   sim: { generation: number },
 *   screenshow: { enabled: boolean },
 * }} state
 * @property {() => any | null} getRenderer
 * @property {() => any | null} getLoop
 * @property {() => any | null} getScreenShow
 * @property {() => void} closeSettingsAndHelpPanels
 * @property {() => void} clearStickyError
 * @property {(immediate?: boolean) => void} requestRender
 * @property {() => void} updateStats
 * @property {{
 *   show: (args: { kind: "info" | "warn" | "error" | "success", message: string }) => void,
 *   getState?: () => any,
 *   hide?: () => void,
 * }} toast
 * @property {any} uiMsg
 * @property {any} logMsg
 * @property {(msg: any, err?: any) => void} error
 * @property {(msg: any, err?: any) => void} [debugWarn]
 * @property {() => boolean} getHasStickyError
 * @property {(v: boolean) => void} setHasStickyError
 */

/**
 * @param {SimControllerDeps} deps
 */
export function createSimController(deps) {
  const {
    state,
    getRenderer,
    getLoop,
    getScreenShow,
    closeSettingsAndHelpPanels,
    clearStickyError,
    requestRender,
    updateStats,
    toast,
    uiMsg,
    logMsg,
    error,
    debugWarn,
    getHasStickyError,
    setHasStickyError,
  } = deps;

  function stopPlaying() {
    const loop = getLoop();
    if (loop) loop.stopPlaying();
  }

  async function waitForIdle() {
    const loop = getLoop();
    if (!loop) return;
    await loop.waitForIdle();
  }

  function queueStep(syncStats = true) {
    const loop = getLoop();
    if (!loop) return Promise.resolve(true);
    return loop.queueStep(syncStats);
  }

  /**
   * Surface a fatal simulation step failure to the user.
   *
   * This should be rare. If it occurs, the most likely causes are:
   * - a WebGPU runtime/device problem (e.g., memory pressure), or
   * - a cross-browser shader/validation issue.
   */
  function handleStepError(err) {
    // Preserve the prior policy: avoid spamming duplicate sticky errors.
    const message = uiMsg.sim.stepFailed;

    if (getHasStickyError()) {
      const s = typeof toast.getState === "function" ? toast.getState() : null;
      if (s && s.kind === "error" && s.message === message) return;
    }

    setHasStickyError(true);
    toast.show({ kind: "error", message });
  }

  async function step() {
    // Stepping is an explicit action: collapse panels that might occlude the scene.
    closeSettingsAndHelpPanels();

    // If the user is retrying after an error, clear any previously shown sticky error.
    clearStickyError();

    // Stop play mode and wait for any in-flight step.
    stopPlaying();
    await waitForIdle();

    try {
      await queueStep(true);
    } catch (err) {
      error(logMsg.SIM_STEP_ERROR, err);
      handleStepError(err);
    }
  }

  function togglePlay() {
    const renderer = getRenderer();
    const loop = getLoop();
    if (!renderer || !loop) return;

    if (loop.isPlaying) {
      stopPlaying();
      return;
    }

    // Starting a run should focus the scene: auto-close Settings and Help.
    closeSettingsAndHelpPanels();

    // If the user is retrying after an error, clear any previously shown sticky error.
    clearStickyError();

    // Screen show starts with Run and runs until paused/stepped/reset.
    if (state.screenshow.enabled) {
      const screenShow = getScreenShow();
      if (screenShow) screenShow.startFromRun();
    }

    loop.startPlaying();
  }

  /**
   * Reset to a new random state.
   *
   * This can be triggered from UI events that do not await the returned promise.
   * Therefore this function must not throw (to avoid unhandled promise rejections).
   *
   * @param {{ showToastOnFailure?: boolean }=} opts
   * @returns {Promise<boolean>} true on success, false on failure
   */
  async function reset(opts = {}) {
    const { showToastOnFailure = true } = opts;

    const renderer = getRenderer();
    if (!renderer) return false;

    stopPlaying();
    await waitForIdle();

    renderer.resetView();
    state.sim.generation = 0;

    try {
      await renderer.randomize(state.settings.density, state.settings.initSize);
    } catch (e) {
      debugWarn && debugWarn("Randomize/reset error:", e?.message || e);

      if (showToastOnFailure) {
        toast.show({
          kind: "warn",
          message: uiMsg.gpu.allocGeneric,
        });
      }
      return false;
    }

    clearStickyError();
    state.sim.population = renderer.population;
    state.sim.populationGeneration = state.sim.generation;
    updateStats();
    requestRender();
    return true;
  }

  return {
    stopPlaying,
    waitForIdle,
    queueStep,
    handleStepError,
    step,
    togglePlay,
    reset,
  };
}
