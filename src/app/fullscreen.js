/**
 * Fullscreen controller.
 *
 * Centralizes fullscreen feature detection, icon updates, and the user-facing
 * error messaging for gesture-gated failures.
 */

/**
 * @typedef {Object} FullscreenController
 * @property {() => boolean} isSupported
 * @property {() => void} updateIcons
 * @property {() => void} toggleFullscreen
 */

/**
 * Create a FullscreenController.
 *
 * @param {{
 *   appEl: HTMLElement|null,
 *   canvas: HTMLCanvasElement|null,
 *   enterIcon: HTMLElement,
 *   exitIcon: HTMLElement,
 *   toast: { show: Function },
 *   debugWarn: Function,
 *   signal: AbortSignal,
 * }} cfg
 * @returns {FullscreenController}
 */
export function createFullscreenController(cfg) {
  const {
    appEl,
    canvas,
    enterIcon,
    exitIcon,
    toast,
    debugWarn,
    signal,
  } = cfg;

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function updateIcons() {
    const fs = !!getFullscreenElement();
    enterIcon.classList.toggle("hidden", fs);
    exitIcon.classList.toggle("hidden", !fs);
  }

  function requestFullscreen(el) {
    const fn =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      document.documentElement.requestFullscreen ||
      document.documentElement.webkitRequestFullscreen;
    if (!fn) return Promise.reject(new Error("Fullscreen API not supported"));
    return fn.call(el);
  }

  function exitFullscreen() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return Promise.reject(new Error("Fullscreen API not supported"));
    return fn.call(document);
  }

  /**
   * Produce a short, user-facing message for fullscreen failures.
   *
   * Notes:
   * - Many browsers reject fullscreen requests unless they are the direct result
   *   of a user gesture.
   * - Error objects vary across implementations; we rely primarily on `name` and
   *   fallback to `message`.
   *
   * @param {any} err
   * @param {{ exiting?: boolean }=} opts
   */
  function describeFullscreenError(err, opts = {}) {
    const exiting = !!opts.exiting;
    const action = exiting ? "Exit fullscreen" : "Fullscreen";
    const name = err && typeof err.name === "string" ? err.name : "";
    const msg = err && typeof err.message === "string" ? err.message : "";

    if (name === "NotAllowedError") {
      return exiting
        ? "Exit fullscreen was blocked by the browser."
        : "Fullscreen was blocked by the browser. Try again after a direct tap/click.";
    }

    if (name === "NotSupportedError") {
      return `${action} is not supported on this device.`;
    }

    if (msg) {
      const compact = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
      return `${action} failed: ${compact}`;
    }

    return `${action} is not available on this device.`;
  }

  function toggleFullscreen() {
    const target = appEl || canvas;
    if (!target) return;

    if (!getFullscreenElement()) {
      requestFullscreen(target)
        .then(updateIcons)
        .catch((err) => {
          debugWarn("Fullscreen error:", err);
          toast.show({
            kind: "warn",
            message: describeFullscreenError(err),
            autoHideMs: 6000,
          });
        });
    } else {
      exitFullscreen()
        .then(updateIcons)
        .catch((err) => {
          debugWarn("Exit fullscreen error:", err);
          toast.show({
            kind: "warn",
            message: describeFullscreenError(err, { exiting: true }),
            autoHideMs: 6000,
          });
        });
    }
  }

  function isSupported() {
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }

  document.addEventListener("fullscreenchange", updateIcons, { signal });
  document.addEventListener("webkitfullscreenchange", updateIcons, { signal });

  // Initialize icon state immediately.
  updateIcons();

  return {
    isSupported,
    updateIcons,
    toggleFullscreen,
  };
}
