/**
 * Validate and normalize a hex color string.
 *
 * Accepts "#rrggbb" or bare "rrggbb" (case-insensitive).
 * Returns the bare 6-character lowercase hex string, or null if invalid.
 *
 * @param {unknown} hex
 * @returns {string | null}
 */
export function parseHex6(hex) {
  const s = String(hex ?? "")
    .trim()
    .replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}
