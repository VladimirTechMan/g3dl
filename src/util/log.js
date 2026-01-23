/**
 * Logging helpers.
 *
 * In production, this project aims to keep the console quiet unless something is
 * genuinely actionable (e.g., initialization failure, device loss).
 *
 * Debug logging is enabled via the URL-scoped `debug` flag (see src/util/debug.js):
 *   ?debug / ?debug=1 / ?debug=true
 */

import { isDebugEnabled } from "./debug.js";

/**
 * Whether debug logging is enabled.
 */
const DEBUG = isDebugEnabled();

/** @param {...any} args */
export function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

/** @param {...any} args */
export function debugWarn(...args) {
  if (DEBUG) console.warn(...args);
}

/** @param {...any} args */
export function warn(...args) {
  console.warn(...args);
}

/** @param {...any} args */
export function error(...args) {
  console.error(...args);
}
