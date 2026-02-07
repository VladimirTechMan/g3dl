/**
 * Speed slider mapping (UI value -> simulation delay, and back).
 *
 * The UI control (speed slider) is expressed in arbitrary "speed units" where higher
 * numbers mean "faster". The simulation loop, however, uses a per-step delay in
 * milliseconds.
 *
 * We use a hyperbolic mapping so that:
 *   SPEED_REF_VALUE maps to SPEED_REF_DELAY_MS
 *
 * This keeps the legacy defaults stable (slider=300 => 300ms delay) while providing
 * a more usable control curve than a linear mapping.
 */

// Reference point used by the hyperbolic mapping.
const SPEED_REF_VALUE = 300;
const SPEED_REF_DELAY_MS = 300;

/**
 * Convert a speed slider raw value to a per-step delay in milliseconds.
 *
 * @param {string|number} raw
 * @returns {number} delay in milliseconds (>= 0)
 */
export function delayFromSpeedSliderValue(raw) {
  const v = Math.max(1, parseInt(String(raw), 10) || SPEED_REF_VALUE);
  // Delay decreases as v increases.
  return Math.max(0, Math.round((SPEED_REF_VALUE * SPEED_REF_DELAY_MS) / v));
}

/**
 * Convert a per-step delay in milliseconds back to an equivalent speed slider value.
 *
 * Note: Callers should clamp the returned value to the slider's [min, max] range.
 *
 * @param {number} delayMs
 * @returns {number} speed slider raw value (>= 1)
 */
export function speedSliderValueFromDelayMs(delayMs) {
  const d = Math.max(0, Math.round(delayMs || 0));
  // Inverse of delayFromSpeedSliderValue. For d=0, this returns a very large number
  // that callers should clamp to the slider's max.
  return Math.max(1, Math.round((SPEED_REF_VALUE * SPEED_REF_DELAY_MS) / Math.max(1, d)));
}
