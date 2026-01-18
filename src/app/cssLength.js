/**
 * CSS length resolution utilities.
 *
 * Several layout pieces rely on CSS custom properties that may contain
 * `var(...)`, `env(...)`, `calc(...)`, or `max(...)` expressions.
 *
 * getComputedStyle() does not resolve custom properties, so this module uses a
 * real CSS property as a probe and reads back the resolved pixel value.
 */

// CSS fallback used when a HUD inset custom property cannot be resolved.
export const HUD_PAD_FALLBACK_PX = 12;

let _cssLengthProbeEl = null;

const CSS_LENGTH_PROBE_PROP_BY_AXIS = {
  top: "paddingTop",
  left: "paddingLeft",
  right: "paddingRight",
  bottom: "paddingBottom",
};

/**
 * Resolve CSS length expressions (including `var(...)`, `env(...)`, `calc(...)`, `max(...)`)
 * into device pixels by applying them to a real CSS property and reading the computed style.
 *
 * @param {string} expr - CSS length expression
 * @param {{ axis?: "top"|"left"|"right"|"bottom", fallbackPx?: number }=} opts
 * @returns {number} resolved pixels
 */
export function resolveCssLengthPx(
  expr,
  { axis = "left", fallbackPx = 0 } = {},
) {
  // Ensure we only touch the DOM after it exists.
  const parent = document.body || document.documentElement;
  if (!_cssLengthProbeEl && parent) {
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.visibility = "hidden";
    el.style.pointerEvents = "none";
    el.style.width = "0";
    el.style.height = "0";
    el.style.left = "0";
    el.style.top = "0";
    parent.appendChild(el);
    _cssLengthProbeEl = el;
  }

  const el = _cssLengthProbeEl;
  if (!el) return fallbackPx;
  const prop = CSS_LENGTH_PROBE_PROP_BY_AXIS[axis] || CSS_LENGTH_PROBE_PROP_BY_AXIS.left;

  el.style[prop] = expr;
  const raw = getComputedStyle(el)[prop];
  const px = parseFloat(raw);
  return Number.isFinite(px) ? px : fallbackPx;
}

/**
 * Read the HUD inset custom properties (top/left/right/bottom) as resolved pixel values.
 *
 * @param {{ fallbackPx?: number }=} opts
 * @returns {{ top: number, left: number, right: number, bottom: number }}
 */
export function getHudInsetsPx({ fallbackPx = HUD_PAD_FALLBACK_PX } = {}) {
  return {
    top: resolveCssLengthPx("var(--hud-inset-top)", { axis: "top", fallbackPx }),
    left: resolveCssLengthPx("var(--hud-inset-left)", { axis: "left", fallbackPx }),
    right: resolveCssLengthPx("var(--hud-inset-right)", { axis: "right", fallbackPx }),
    bottom: resolveCssLengthPx("var(--hud-inset-bottom)", { axis: "bottom", fallbackPx }),
  };
}

/**
 * Remove the DOM probe element.
 *
 * This is primarily useful for SPA-style mounts/unmounts where the app may be
 * created and destroyed multiple times.
 */
export function destroyCssLengthProbe() {
  try {
    if (_cssLengthProbeEl && _cssLengthProbeEl.parentNode) {
      _cssLengthProbeEl.parentNode.removeChild(_cssLengthProbeEl);
    }
  } catch (_) {
    // ignore
  }
  _cssLengthProbeEl = null;
}
