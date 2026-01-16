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
 * @typedef {"info"|"warn"|"error"} ToastKind
 */

/**
 * @typedef {{
 *   kind?: ToastKind,
 *   message: string,
 *   autoHideMs?: number,
 * }} ToastOptions
 */

/**
 * @param {import("./dom.js").dom} dom
 * @param {{ signal?: AbortSignal }=} opts
 */
export function createToastController(dom, opts = {}) {
  const el = dom.toast;
  const msgEl = dom.toastMessage;
  const closeBtn = dom.toastCloseBtn;

  /** @type {number|null} */
  let hideTimer = null;

  function clearTimer() {
    if (hideTimer != null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hide() {
    clearTimer();
    if (!el || !msgEl) return;
    el.hidden = true;
    el.removeAttribute("data-kind");
    // Keep aria-live polite by default.
    el.setAttribute("aria-live", "polite");
    msgEl.textContent = "";
  }

  /**
   * @param {ToastOptions} options
   */
  function show(options) {
    if (!el || !msgEl) return;

    const kind = options.kind || "info";
    const message = String(options.message || "");
    const autoHideMs =
      typeof options.autoHideMs === "number" ? options.autoHideMs : 3500;

    if (!message) return;

    clearTimer();

    el.dataset.kind = kind;
    el.hidden = false;
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

  return {
    show,
    hide,
  };
}
