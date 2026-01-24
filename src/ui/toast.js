/**
 * Lightweight, non-blocking toast notifications.
 *
 * Design goals:
 * - Minimal DOM and logic.
 * - Safe text rendering (no innerHTML).
 * - Useful on mobile where the console is often inaccessible.
 * - Non-fatal: do not use for hard failures that require an overlay.
 */

/**
 * @typedef {"info"|"success"|"warn"|"error"} ToastKind
 */

/**
 * @typedef {{
 *   kind?: ToastKind,
 *   message: string,
 *   autoHideMs?: number,
 * }} ToastOptions
 */

/**
 * @param {import("./dom.js").DomCache} dom
 * @param {{ signal?: AbortSignal, onHide?: (() => void) }=} opts
 */
export function createToastController(dom, opts = {}) {
  const el = dom.toast;
  const msgEl = dom.toastMessage;
  const closeBtn = dom.toastCloseBtn;

  /** @type {number|null} */
  let hideTimer = null;

  /** @type {ToastKind|null} */
  let currentKind = null;
  /** @type {string} */
  let currentMessage = "";

  /**
   * Basic de-duplication to prevent toast spam from tightly-coupled event sources
   * (e.g., global pointerup + native change double-fire).
   */
  /** @type {string|null} */
  let lastShownKey = null;
  /** @type {number} */
  let lastShownAtMs = 0;

  function nowMs() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Default durations by severity.
   * - info: brief confirmation
   * - warn: give users time to read and react
   * - error: persistent until dismissed
   *
   * @param {ToastKind} kind
   */
  function defaultAutoHideMs(kind) {
    if (kind === "info") return 2500;
    if (kind === "success") return 2500;
    if (kind === "warn") return 5000;
    return 0;
  }

  function clearTimer() {
    if (hideTimer != null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
  function hide() {
    clearTimer();
    currentKind = null;
    currentMessage = "";
    if (!el || !msgEl) return;
    el.classList.add("hidden");
    el.removeAttribute("data-kind");
    // Keep aria-live polite by default.
    el.setAttribute("aria-live", "polite");
    msgEl.textContent = "";

    if (typeof opts.onHide === "function") {
      try {
        opts.onHide();
      } catch {
        // Ignore toast onHide handler errors; the toast is a best-effort UI primitive.
      }
    }
  }

  /**
   * @param {ToastOptions} options
   */
  function show(options) {
    if (!el || !msgEl) return;

    const kind = options.kind || "info";
    const message = String(options.message || "");
    if (!message) return;

    const autoHideMs =
      typeof options.autoHideMs === "number"
        ? options.autoHideMs
        : defaultAutoHideMs(kind);

    // Suppress near-immediate duplicates (same message + kind).
    const key = `${kind}\n${message}`;
    const t = nowMs();
    if (lastShownKey === key && t - lastShownAtMs < 250) {
      return;
    }
    lastShownKey = key;
    lastShownAtMs = t;

    // If the same toast is already visible, just extend its lifetime.
    if (!el.classList.contains("hidden") && currentKind === kind && currentMessage === message) {
      clearTimer();
      if (kind !== "error" && autoHideMs > 0) {
        hideTimer = setTimeout(hide, autoHideMs);
      }
      return;
    }

    currentKind = kind;
    currentMessage = message;

    clearTimer();

    el.dataset.kind = kind;
    el.classList.remove("hidden");
    el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    msgEl.textContent = message;

    // For errors, keep the toast visible until dismissed.
    if (kind !== "error" && autoHideMs > 0) {
      hideTimer = setTimeout(hide, autoHideMs);
    }
  }

  // Wire close button if present.
  if (closeBtn && typeof closeBtn.addEventListener === "function") {
    closeBtn.addEventListener("click", hide, { signal: opts.signal });
  }

  // Hide on abort to avoid leaving stale UI behind.
  if (opts.signal) {
    if (opts.signal.aborted) hide();
    opts.signal.addEventListener(
      "abort",
      () => {
        hide();
      },
      { once: true },
    );
  }

  function getState() {
    return {
      visible: !!el && !el.classList.contains("hidden"),
      kind: currentKind,
      message: currentMessage,
    };
  }

  return {
    show,
    hide,
    getState,
  };
}
