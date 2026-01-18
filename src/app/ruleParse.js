/**
 * Rule parsing utilities for 3D Life.
 *
 * The simulation uses a 3D Moore neighborhood, so neighbor counts range 0..26.
 *
 * This module is intentionally UI-agnostic: it parses from strings and produces
 * canonical values plus a sanitized representation.
 */

/**
 * Parse a comma/whitespace-separated list of values and ranges.
 *
 * Supported tokens:
 * - Single values: "0", "13"
 * - Ranges: "5-7"
 *
 * Notes:
 * - Negative values are invalid.
 * - While typing, callers may allow a trailing hyphen ("5-") to avoid marking
 *   the control as invalid mid-entry.
 *
 * @param {string} str
 * @param {{ allowTrailingHyphen?: boolean }=} opts
 * @returns {{ sanitized: string, values: number[], hasError: boolean, isNonEmpty: boolean }}
 */
export function parseRuleNumbers(str, opts = undefined) {
  const { allowTrailingHyphen = true } = opts || {};

  // Allow only digits, commas, hyphens, and whitespace.
  const sanitized0 = String(str || "").replace(/[^0-9,\-\s]/g, "");
  // Normalize common range typing with spaces, e.g., "5 - 7" -> "5-7".
  const sanitized = sanitized0.replace(/(\d)\s*-\s*(\d)/g, "$1-$2");

  /** @type {Set<number>} */
  const values = new Set();
  let hasError = false;

  const tokens = sanitized.split(/[\s,]+/).filter((t) => t.length > 0);

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;

    // Disallow standalone '-' or tokens that begin with '-' (negative numbers are invalid).
    if (/^-+$/.test(token) || token.startsWith("-")) {
      hasError = true;
      break;
    }

    if (token.includes("-")) {
      // Tolerate an in-progress range while typing (e.g., "5-") if explicitly allowed.
      if (token.endsWith("-")) {
        if (allowTrailingHyphen && /^\d+-$/.test(token)) {
          continue;
        }
        hasError = true;
        break;
      }

      // Strict range format: N-M
      if (!/^\d+-\d+$/.test(token)) {
        hasError = true;
        break;
      }

      const [a, b] = token.split("-", 2);
      const start = parseInt(a, 10);
      const end = parseInt(b, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        hasError = true;
        break;
      }

      // Hard bounds: 3D Moore neighborhood has 26 neighbors (0..26).
      if (start < 0 || start > 26 || end < 0 || end > 26) {
        hasError = true;
        break;
      }
      // Descending ranges are invalid (e.g., 5-2).
      if (start > end) {
        hasError = true;
        break;
      }

      // Range is now guaranteed to be at most 27 items; safe to expand.
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
    } else {
      // Single value token
      if (!/^\d+$/.test(token)) {
        hasError = true;
        break;
      }
      const n = parseInt(token, 10);
      if (n < 0 || n > 26) {
        hasError = true;
        break;
      }
      values.add(n);
    }
  }

  const list = Array.from(values).sort((a, b) => a - b);

  return {
    sanitized,
    values: list,
    hasError,
    // For callers that want "blank is not valid", but note: we don't mark blank as an error.
    isNonEmpty: sanitized.trim() !== "",
  };
}
