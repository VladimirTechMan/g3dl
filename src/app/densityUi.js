/**
 * Density (Gen0 fill) UI controller.
 *
 * This controller now delegates continuous slider interaction mechanics to the shared
 * {@link createContinuousInputController} helper:
 * - pointer capture + global pointerup robustness
 * - duplicate commit suppression
 * - tooltip ("tip") lifecycle (show during drag, hide after release)
 *
 * The domain-specific behavior stays here:
 * - density is stored in state.settings.density (0.0..1.0)
 * - applying the new density requires a reset, but only when stopped at generation 0
 * - on failure, revert the UI and attempt recovery reset
 */

import { createContinuousInputController } from "../ui/continuousInput.js";

/**
 * @typedef {Object} DensityControllerDeps
 * @property {HTMLInputElement | null} densitySlider
 * @property {HTMLElement | null} densityTip
 * @property {{
 *   settings: { density: number },
 *   sim: { isPlaying: boolean, generation: number },
 * }} state
 * @property {{
 *   show: (args: { kind: "info" | "warn" | "error" | "success", message: string }) => void,
 * }} toast
 * @property {any} uiMsg
 * @property {(opts?: { showToastOnFailure?: boolean }) => Promise<boolean>} reset
 */

/**
 * @param {DensityControllerDeps} deps
 */
export function createDensityController(deps) {
  const { densitySlider, densityTip, state, toast, uiMsg, reset } = deps;

  /**
   * Commit a new density percentage (integer 0..100).
   *
   * This is invoked on slider release. It may be called multiple times by some engines
   * (pointerup-global + native 'change'); duplicate suppression is handled by the shared helper.
   *
   * @param {number} sliderPct
   */
  async function commitDensityPct(sliderPct) {
    if (!densitySlider) return;
    if (!Number.isFinite(sliderPct)) return;

    const prevDensity = state.settings.density;
    const prevPct = Math.round(prevDensity * 100);

    // Avoid expensive no-op commits (and avoid spurious toasts).
    if (sliderPct === prevPct) return;

    state.settings.density = sliderPct / 100;
    if (densityTip) densityTip.textContent = sliderPct + "%";

    // Apply immediately only when the simulation is stopped at generation 0.
    // Otherwise, keep the new setting and apply it on the next explicit reset.
    if (state.sim.isPlaying || state.sim.generation !== 0) {
      toast.show({
        kind: "info",
        message: uiMsg.sim.applyOnNextReset.density,
      });
      return;
    }

    const ok = await reset({ showToastOnFailure: false });
    if (ok) return;

    // Revert to previous value on failure.
    state.settings.density = prevDensity;
    densitySlider.value = String(prevPct);
    if (densityTip) densityTip.textContent = prevPct + "%";

    toast.show({
      kind: "warn",
      message: uiMsg.gpu.densityApplyFail(sliderPct, prevPct),
    });

    const restored = await reset({ showToastOnFailure: false });
    if (!restored) {
      toast.show({
        kind: "error",
        message: uiMsg.sim.recoverFailed,
      });
    }
  }

  const control = createContinuousInputController({
    input: densitySlider,
    tip: densityTip,
    captureTarget: densitySlider,

    // Slider stores percent as an integer (e.g. "15" => 15%).
    getValue: () => {
      if (!densitySlider) return 0;
      return parseInt(densitySlider.value, 10);
    },

    // Tooltip text is "NN%".
    formatTip: (pct) => `${pct}%`,

    // Density preview is purely UI (tooltip), so do not throttle.
    previewIntervalMs: 0,

    // Some engines double-fire commits on pointerup + change.
    commitSuppressMs: 250,

    // Decide whether pointerup-global should commit:
    // only commit when the slider differs from the current committed state.
    getCommittedValue: () => Math.round(state.settings.density * 100),
    equals: (a, b) => a === b,

    // Tooltip hide policy mirrors the legacy behavior.
    tipHide: {
      afterCommitMs: 1000,
      afterReleaseMs: 600,
      afterBlurMs: 250,
      afterMouseLeaveMs: 250,
    },

    // The helper updates the tooltip; no extra preview work needed.
    applyPreview: () => {},

    applyCommit: (pct) => commitDensityPct(pct),
  });

  return {
    handleDensityPreview: control.handlePreview,
    handleDensityChange: control.handleChange,
    handleDensityPointerDown: control.handlePointerDown,
    handleDensityPointerUpGlobal: control.handlePointerUpGlobal,
    handleDensityBlur: control.handleBlur,
    handleDensityMouseLeave: control.handleMouseLeave,
    destroy: control.destroy,
  };
}
