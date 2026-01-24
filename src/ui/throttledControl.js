/**
 * UI helper: throttle high-frequency preview updates (e.g., range input 'input')
 * during a continuous interaction session, while applying the final value
 * immediately on commit.
 *
 * This is intended to keep the UI responsive on mobile browsers that may emit
 * very frequent input events.
 */

/**
 * @template T
 * @typedef {Object} ThrottledControlConfig
 * @property {() => T} getValue - Read the current value from the control.
 * @property {(value: T) => void} applyPreview - Apply a preview update (should be lightweight).
 * @property {(value: T) => void} [applyCommit] - Apply a committed update; defaults to applyPreview.
 * @property {number} [previewIntervalMs] - Coalescing interval for preview updates (default ~30Hz).
 * @property {number} [commitSuppressMs] - Suppress duplicate commits within this window.
 * @property {HTMLElement | null} [captureTarget] - If provided, attempts pointer capture when a session begins.
 * @property {() => number} [now] - Time source; defaults to performance.now().
 */

/**
 * @template T
 * @param {ThrottledControlConfig<T>} cfg
 */
export function createThrottledControl(cfg) {
  const {
    getValue,
    applyPreview,
    applyCommit = applyPreview,
    previewIntervalMs = 33,
    commitSuppressMs = 250,
    captureTarget = null,
    now = () => performance.now(),
  } = cfg;

  let sessionActive = false;

  /** @type {T | null} */
  let pendingValue = null;

  let lastPreviewMs = 0;
  let timerId = 0;

  /** @type {T | null} */
  let lastCommitValue = null;
  let lastCommitMs = 0;

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = 0;
    }
  }

  function flushPreview() {
    clearTimer();
    if (pendingValue == null) return;

    const v = pendingValue;
    pendingValue = null;

    lastPreviewMs = now();
    applyPreview(v);
  }

  function schedulePreview(v) {
    pendingValue = v;

    const t = now();
    const elapsed = t - lastPreviewMs;

    if (elapsed >= previewIntervalMs) {
      flushPreview();
      return;
    }

    if (timerId) return;

    const dueIn = Math.max(0, previewIntervalMs - elapsed);
    timerId = setTimeout(flushPreview, dueIn);
  }

  function preview() {
    const v = getValue();
    if (sessionActive) {
      schedulePreview(v);
    } else {
      applyPreview(v);
    }
  }

  function commit() {
    const t = now();

    // If commit events double-fire (common on some engines), suppress duplicates.
    const v = getValue();
    if (lastCommitValue === v && t - lastCommitMs < commitSuppressMs) {
      return;
    }

    // Ensure the last preview isn't stale.
    if (pendingValue != null) flushPreview();
    clearTimer();

    lastCommitValue = v;
    lastCommitMs = t;

    applyCommit(v);
  }

  /**
   * Begin a continuous interaction session.
   *
   * For pointer-driven controls, call this from `pointerdown` and pass the
   * pointer event to enable best-effort pointer capture.
   *
   * For controls that do not deliver pointer events reliably (e.g. OS-native
   * color pickers), call this from the first `input` event to enable throttled
   * preview updates until `endSession()`.
   *
   * @param {PointerEvent | any} [e]
   */
  function beginSession(e) {
    if (sessionActive) return;
    sessionActive = true;

    // Best-effort pointer capture: improves delivery of pointerup for some engines.
    try {
      if (captureTarget && captureTarget.setPointerCapture && e && e.pointerId != null) {
        captureTarget.setPointerCapture(e.pointerId);
      }
    } catch (_) {
      // ignore
    }
  }

  /**
   * End the current interaction session.
   *
   * @param {boolean} [shouldCommit=true] - If false, ends the session without committing.
   */
  function endSession(shouldCommit = true) {
    if (!sessionActive) return;
    sessionActive = false;
    if (shouldCommit) commit();
  }


  function cancel() {
    sessionActive = false;
    pendingValue = null;
    clearTimer();
  }

  return {
    preview,
    commit,
    beginSession,
    endSession,
    cancel,
    isSessionActive: () => sessionActive,
  };
}
