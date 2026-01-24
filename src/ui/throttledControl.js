/**
 * UI helper: throttle high-frequency preview updates (e.g., range input 'input')
 * during pointer drags, while applying the final value immediately on commit.
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
 * @property {HTMLElement | null} [captureTarget] - If provided, attempts pointer capture on pointerdown.
 * @property {boolean} [commitOnMouseLeave] - If true, commit when mouse leaves during drag (default false).
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
    commitOnMouseLeave = false,
    now = () => performance.now(),
  } = cfg;

  let dragging = false;

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
    if (dragging) {
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
   * @param {PointerEvent | any} e
   */
  function onPointerDown(e) {
    dragging = true;

    // Best-effort pointer capture: improves delivery of pointerup for some engines.
    try {
      if (captureTarget && captureTarget.setPointerCapture && e && e.pointerId != null) {
        captureTarget.setPointerCapture(e.pointerId);
      }
    } catch (_) {
      // ignore
    }
  }

  function onPointerUpGlobal() {
    if (!dragging) return;
    dragging = false;
    commit();
  }

  function onBlur() {
    dragging = false;
    commit();
  }

  function onMouseLeave() {
    if (!dragging) return;
    dragging = false;
    if (commitOnMouseLeave) commit();
  }

  function cancel() {
    dragging = false;
    pendingValue = null;
    clearTimer();
  }

  return {
    preview,
    commit,
    onPointerDown,
    onPointerUpGlobal,
    onBlur,
    onMouseLeave,
    cancel,
    isDragging: () => dragging,
  };
}
