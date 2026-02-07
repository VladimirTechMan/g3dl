/**
 * Continuous input helper for range-like controls.
 *
 * Goal:
 * - Provide a consistent, robust interaction model for sliders and other continuous inputs:
 *   - throttled preview updates during pointer drags (optional)
 *   - best-effort pointer capture
 *   - duplicate commit suppression (some engines double-fire pointerup + change)
 *   - optional tooltip ("tip") visibility lifecycle with configurable hide delays
 *
 * This module deliberately does not attach any DOM listeners. It only returns handler
 * functions that the app can bind as it sees fit.
 */

import { createThrottledControl } from "./throttledControl.js";

/**
 * @template T
 * @typedef {Object} TipHidePolicy
 * @property {number} [afterCommitMs] - Hide delay after a committed change (default 1000ms).
 * @property {number} [afterReleaseMs] - Hide delay after pointer release with no commit (default 600ms).
 * @property {number} [afterBlurMs] - Hide delay after focus loss (default 250ms).
 * @property {number} [afterMouseLeaveMs] - Hide delay after mouse leave (default 250ms).
 */

/**
 * @template T
 * @typedef {Object} ContinuousInputConfig
 * @property {HTMLInputElement | null} input
 * @property {() => T} getValue
 * @property {(value: T) => void} [applyPreview] - Lightweight preview (may be called often).
 * @property {(value: T) => void | Promise<void>} [applyCommit] - Final commit on release.
 * @property {number} [previewIntervalMs] - Throttle interval during pointer drags (~30Hz default).
 * @property {number} [commitSuppressMs] - Suppress duplicate commits within this window.
 * @property {HTMLElement | null} [captureTarget] - If provided, attempt pointer capture on begin.
 *
 * Tooltip (optional):
 * @property {HTMLElement | null} [tip]
 * @property {(value: T) => string} [formatTip]
 * @property {string} [tipVisibleClass]
 * @property {TipHidePolicy<T>} [tipHide]
 *
 * Commit detection (optional):
 * For controls that should avoid "no-op commits" (e.g. expensive apply/reset),
 * provide getCommittedValue so pointerup-global can decide whether it should commit.
 * @property {() => T} [getCommittedValue]
 * @property {(a: T, b: T) => boolean} [equals]
 */

/**
 * @template T
 * @param {ContinuousInputConfig<T>} cfg
 * @returns {{
 *   handlePreview: () => void,
 *   handleChange: () => void,
 *   handlePointerDown: (e?: PointerEvent | any) => void,
 *   handlePointerUpGlobal: () => void,
 *   handleBlur: () => void,
 *   handleMouseLeave: () => void,
 *   destroy: () => void,
 * }}
 */
export function createContinuousInputController(cfg) {
  const {
    input,
    getValue,
    applyPreview = () => {},
    applyCommit = applyPreview,
    previewIntervalMs = 33,
    commitSuppressMs = 250,
    captureTarget = input,
    tip = null,
    formatTip = (v) => String(v),
    tipVisibleClass = "visible",
    tipHide = {},
    getCommittedValue = null,
    equals = (a, b) => a === b,
  } = cfg;

  if (!input) {
    // Provide stable no-ops so callers don't have to guard.
    return {
      handlePreview() {},
      handleChange() {},
      handlePointerDown() {},
      handlePointerUpGlobal() {},
      handleBlur() {},
      handleMouseLeave() {},
      destroy() {},
    };
  }

  const hideAfterCommitMs = tipHide.afterCommitMs ?? 1000;
  const hideAfterReleaseMs = tipHide.afterReleaseMs ?? 600;
  const hideAfterBlurMs = tipHide.afterBlurMs ?? 250;
  const hideAfterMouseLeaveMs = tipHide.afterMouseLeaveMs ?? 250;

  let dragActive = false;
  let tipTimerId = 0;

  function clearTipTimer() {
    if (tipTimerId) {
      clearTimeout(tipTimerId);
      tipTimerId = 0;
    }
  }

  function showTip(value) {
    if (!tip) return;
    clearTipTimer();
    tip.textContent = formatTip(value);
    tip.classList.add(tipVisibleClass);
  }

  function hideTip() {
    if (!tip) return;
    tip.classList.remove(tipVisibleClass);
  }

  function scheduleTipHide(delayMs) {
    if (!tip) return;
    clearTipTimer();
    tipTimerId = setTimeout(() => {
      tipTimerId = 0;
      hideTip();
    }, delayMs);
  }

  const control = createThrottledControl({
    getValue,
    applyPreview: (v) => {
      showTip(v);
      applyPreview(v);
    },
    applyCommit: (v) => {
      showTip(v);
      // Allow async commits; the throttled control does not await.
      void applyCommit(v);
      scheduleTipHide(hideAfterCommitMs);
    },
    previewIntervalMs,
    commitSuppressMs,
    captureTarget,
  });

  function handlePreview() {
    control.preview();
  }

  function handleChange() {
    dragActive = false;
    control.commit();
    // commit() will schedule tip hide via applyCommit wrapper.
  }

  function handlePointerDown(e) {
    dragActive = true;
    control.beginSession(e);
    // Make the tip visible immediately.
    showTip(getValue());
  }

  function shouldCommitOnRelease(currentValue) {
    if (!getCommittedValue) return true;
    try {
      const committed = getCommittedValue();
      return !equals(currentValue, committed);
    } catch (_) {
      // If committed-value computation fails, default to committing.
      return true;
    }
  }

  function handlePointerUpGlobal() {
    dragActive = false;

    const v = getValue();
    const shouldCommit = shouldCommitOnRelease(v);

    // If we should not commit (no change), end the session without committing
    // and hide the tip quickly. Otherwise, commit and let the commit wrapper
    // schedule the standard hide delay.
    if (shouldCommit) {
      control.endSession(true);
      return;
    }

    control.endSession(false);
    scheduleTipHide(hideAfterReleaseMs);
  }

  function handleBlur() {
    dragActive = false;
    control.endSession(true);
    scheduleTipHide(hideAfterBlurMs);
  }

  function handleMouseLeave() {
    if (dragActive) return;
    if (!tip) return;
    if (!tip.classList.contains(tipVisibleClass)) return;
    scheduleTipHide(hideAfterMouseLeaveMs);
  }

  function destroy() {
    clearTipTimer();
    control.cancel();
  }

  return {
    handlePreview,
    handleChange,
    handlePointerDown,
    handlePointerUpGlobal,
    handleBlur,
    handleMouseLeave,
    destroy,
  };
}
