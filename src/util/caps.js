/**
 * Capability detection helpers.
 *
 * These checks are intended for *heuristics* (pacing, UI workarounds), not for gating
 * correctness-critical behavior. All results are best-effort and defensive: failures
 * return conservative defaults.
 *
 * IMPORTANT:
 * - Keep this module dependency-free so it can be imported from both app/* and gpu/*.
 * - Cache results to avoid repeated UA / media-query work on the main thread.
 */

let _cachedCaps = null;

/**
 * @typedef {Object} Caps
 * @property {boolean} isCoarsePointer
 * @property {boolean} isIOS
 * @property {number} maxTouchPoints
 * @property {boolean} prefersReducedMotion
 */

/**
 * Returns a cached snapshot of environment capabilities.
 *
 * @returns {Caps}
 */
export function getCaps() {
  if (_cachedCaps) return _cachedCaps;

  let isCoarsePointer = false;
  let prefersReducedMotion = false;

  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      isCoarsePointer = !!window.matchMedia("(pointer: coarse)").matches;
      prefersReducedMotion = !!window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
    }
  } catch (_) {
    // Best effort; keep defaults.
  }

  // Best-effort iOS / iPadOS detection (including iPadOS reporting as Mac).
  let isIOS = false;
  let maxTouchPoints = 0;

  try {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const platform =
      (typeof navigator !== "undefined" && navigator.platform) || "";
    maxTouchPoints =
      (typeof navigator !== "undefined" && navigator.maxTouchPoints) || 0;

    const isAppleMobile = /iPad|iPhone|iPod/i.test(ua);
    const isIPadOS13Plus = platform === "MacIntel" && maxTouchPoints > 1;
    isIOS = isAppleMobile || isIPadOS13Plus;
  } catch (_) {
    // Best effort; keep defaults.
  }

  _cachedCaps = {
    isCoarsePointer,
    isIOS,
    maxTouchPoints,
    prefersReducedMotion,
  };

  return _cachedCaps;
}

/**
 * @returns {boolean}
 */
export function isCoarsePointer() {
  return getCaps().isCoarsePointer;
}

/**
 * @returns {boolean}
 */
export function isIOS() {
  return getCaps().isIOS;
}
