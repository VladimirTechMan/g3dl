/**
 * Logging helpers.
 *
 * In production, this project aims to keep the console quiet unless something is
 * genuinely actionable (e.g., initialization failure, device loss).
 *
 * Enable debug logging by either:
 *  - adding `?debug=1` to the URL, or
 *  - setting `localStorage.g3dl_debug = "1"`.
 *
 * Passing `?debug=0` disables debug logging and persists that preference.
 */

const DEBUG_STORAGE_KEY = "g3dl_debug";

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

function tryGetDebugFromStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem(DEBUG_STORAGE_KEY);
    return parseDebugFlag(v);
  } catch (_) {
    return null;
  }
}

function tryPersistDebugToStorage(enabled) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(DEBUG_STORAGE_KEY, enabled ? "1" : "0");
  } catch (_) {
    // Ignore storage errors (private browsing, restricted environments).
  }
}

/**
 * Whether debug logging is enabled.
 *
 * If the URL includes a `debug` parameter, it takes precedence and is persisted to
 * localStorage. This is important because the app may strip query parameters after
 * initialization when applying settings.
 */
export const DEBUG_LOG_ENABLED = (() => {
  const fromUrl = tryGetDebugFromUrl();
  if (fromUrl != null) {
    tryPersistDebugToStorage(fromUrl);
    return fromUrl;
  }
  const fromStorage = tryGetDebugFromStorage();
  return fromStorage != null ? fromStorage : false;
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
