/**
 * Density (Gen0 fill) UI controller.
 *
 * Responsibilities:
 * - tooltip preview while dragging
 * - robust commit on pointer release across browsers (including global pointerup)
 * - debouncing double-fire cases where pointerup + native 'change' both commit
 *
 * This module is intentionally stateful (it tracks pointer-drag lifecycle)
 * but does not own any event listeners. It only exposes handlers.
 */

/**
 * @typedef {Object} DensityControllerDeps
 * @property {HTMLInputElement | null} densitySlider
 * @property {HTMLElement | null} densityTip
 * @property {{
 *   settings: { density: number },
 *   sim: { isPlaying: boolean },
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

  // Local UI state for robust tooltip teardown across pointer events.
  let densityDragActive = false;

  // Debounce identical commits (pointerup-global + native 'change' double-fire).
  let lastDensityCommitPct = null;
  let lastDensityCommitTimeMs = 0;

  /**
   * Schedule hiding the Gen0 density tooltip.
   * @param {number} delayMs
   */
  function scheduleDensityTipHide(delayMs) {
    if (!densityTip) return;
    clearTimeout(densityTip.hideTimeout);
    densityTip.hideTimeout = setTimeout(() => {
      densityTip.classList.remove("visible");
    }, delayMs);
  }

  /**
   * Preview state.settings.density value while dragging (show tooltip only).
   */
  function handleDensityPreview() {
    if (!densitySlider || !densityTip) return;

    const previewValue = parseInt(densitySlider.value, 10);

    // Keep tip visible while the user is interacting with the slider.
    // (If a previous release scheduled a hide timeout, cancel it.)
    clearTimeout(densityTip.hideTimeout);

    densityTip.textContent = previewValue + "%";
    densityTip.classList.add("visible");
  }

  /**
   * Handle state.settings.density slider change (on release).
   */
  async function handleDensityChange() {
    if (!densitySlider || !densityTip) return;

    const prevDensity = state.settings.density;

    const sliderPct = parseInt(densitySlider.value, 10);
    if (!Number.isFinite(sliderPct)) return;

    const now = performance.now();
    if (lastDensityCommitPct === sliderPct && now - lastDensityCommitTimeMs < 250) {
      return;
    }
    lastDensityCommitPct = sliderPct;
    lastDensityCommitTimeMs = now;

    state.settings.density = sliderPct / 100;
    densityTip.textContent = Math.round(state.settings.density * 100) + "%";

    scheduleDensityTipHide(1000);

    // Only apply density when simulation is not running.
    if (state.sim.isPlaying) {
      toast.show({
        kind: "info",
        message: uiMsg.sim.stopToApply.density,
      });
      return;
    }

    const ok = await reset({ showToastOnFailure: false });
    if (ok) return;

    // Revert to previous value on failure.
    state.settings.density = prevDensity;
    const prevPct = Math.round(prevDensity * 100);
    densitySlider.value = String(prevPct);
    densityTip.textContent = prevPct + "%";

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

  /**
   * Mark density slider interaction as active (for robust tooltip teardown).
   */
  function handleDensityPointerDown(e) {
    if (!densitySlider || !densityTip) return;

    densityDragActive = true;

    // Attempt pointer capture so that some engines will still dispatch pointerup
    // to the slider even if the pointer leaves the control while dragging.
    try {
      if (densitySlider.setPointerCapture && e && e.pointerId != null) {
        densitySlider.setPointerCapture(e.pointerId);
      }
    } catch (_) {
      // Ignore capture failures (unsupported or blocked by the element).
    }

    clearTimeout(densityTip.hideTimeout);
    densityTip.classList.add("visible");
  }

  /**
   * Commit density if the slider value differs from state, then schedule tip hide.
   */
  function handleDensityPointerUpGlobal() {
    if (!densitySlider || !densityTip) return;
    if (!densityTip.classList.contains("visible")) return;

    densityDragActive = false;

    const sliderPct = parseInt(densitySlider.value, 10);
    const statePct = Math.round(state.settings.density * 100);

    // If the release did not trigger a native 'change' (browser quirk), commit here.
    if (Number.isFinite(sliderPct) && sliderPct !== statePct) {
      void handleDensityChange();
      return;
    }

    scheduleDensityTipHide(600);
  }

  /**
   * Hide the density tip on focus loss (keyboard navigation, clicking elsewhere).
   */
  function handleDensityBlur() {
    if (!densityTip) return;

    densityDragActive = false;

    if (!densityTip.classList.contains("visible")) return;

    scheduleDensityTipHide(250);
  }

  /**
   * Hide the density tip when the pointer leaves the slider (desktop hover case).
   */
  function handleDensityMouseLeave() {
    if (!densityTip) return;

    if (densityDragActive) return;
    if (!densityTip.classList.contains("visible")) return;

    scheduleDensityTipHide(250);
  }

  function destroy() {
    if (!densityTip) return;
    clearTimeout(densityTip.hideTimeout);
  }

  return {
    handleDensityPreview,
    handleDensityChange,
    handleDensityPointerDown,
    handleDensityPointerUpGlobal,
    handleDensityBlur,
    handleDensityMouseLeave,
    destroy,
  };
}
