/**
 * Lightweight DOM event listener helper.
 *
 * The removal logic uses the normalized boolean capture flag, which is the only
 * option that affects listener identity for add/remove. Other options (passive,
 * once) do not affect removal.
 *
 * @template {EventTarget} T
 * @param {T} target
 * @param {string} type
 * @param {(ev: any) => void} listener
 * @param {any} [options]
 * @returns {() => void} unsubscribe
 */
export function on(target, type, listener, options) {
  if (!target || !target.addEventListener) return () => {};
  target.addEventListener(type, listener, options);

  const capture =
    typeof options === "boolean" ? options : !!(options && options.capture);

  return () => {
    try {
      target.removeEventListener(type, listener, capture);
    } catch (_) {
      // Ignore teardown errors (e.g., browser quirks, already-removed listeners).
    }
  };
}
