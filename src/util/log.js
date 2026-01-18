/**
 * Logging helpers.
 *
 * In production, this project aims to keep the console quiet unless something is
 * genuinely actionable (e.g., initialization failure, device loss).
 *
 * Enable debug logging by adding `?debug=1` (or `?debug=true`) to the URL.
 *
 * Debug logging is intentionally URL-scoped (not persisted). This avoids
 * surprising "sticky" debug output if a user temporarily enables debug mode and
 * later removes `debug=1` from the URL.
 */

function parseDebugFlag(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === "" || s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  // Unknown values are treated as "enabled" to allow `?debug` without value.
  return true;
}

function tryGetDebugFromUrl() {
  try {
    if (typeof location === "undefined") return null;
    const params = new URLSearchParams(location.search);
    if (!params.has("debug")) return null;
    return parseDebugFlag(params.get("debug"));
  } catch (_) {
    return null;
  }
}

/**
 * Whether debug logging is enabled.
 */
const DEBUG_LOG_ENABLED = (() => {
  const fromUrl = tryGetDebugFromUrl();
  return fromUrl != null ? fromUrl : false;
})();

/** @param {...any} args */
export function debugLog(...args) {
  if (!DEBUG_LOG_ENABLED) return;
  console.log(...args);
}

/** @param {...any} args */
export function debugWarn(...args) {
  if (!DEBUG_LOG_ENABLED) return;
  console.warn(...args);
}

/** @param {...any} args */
export function warn(...args) {
  console.warn(...args);
}

/** @param {...any} args */
export function error(...args) {
  console.error(...args);
}
