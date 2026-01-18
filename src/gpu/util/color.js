/**
 * Color parsing helpers used by the renderer.
 */

/**
 * Convert a CSS hex color to 0..1 RGB floats.
 *
 * The UI constrains values to "#rrggbb" via <input type="color"> and URL validation.
 * This helper exists primarily to avoid duplicated parsing logic.
 *
 * @param {string} hex - "#rrggbb" (recommended) or "rrggbb".
 * @returns {[number, number, number]}
 */
export function hexToRgb01(hex) {
  const t = String(hex).trim();
  const s = t.startsWith("#") ? t.slice(1) : t;
  return [
    parseInt(s.slice(0, 2), 16) / 255,
    parseInt(s.slice(2, 4), 16) / 255,
    parseInt(s.slice(4, 6), 16) / 255,
  ];
}
