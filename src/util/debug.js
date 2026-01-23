/**
 * Shared debug-flag parsing.
 *
 * Debug mode is intentionally URL-scoped (not persisted) to avoid surprising
 * "sticky" debug behavior after a temporary debug session.
 *
 * Supported forms:
 *   ?debug=1 | ?debug=true | ?debug=yes | ?debug=on | ?debug   -> enabled
 *   ?debug=0 | ?debug=false | ?debug=no  | ?debug=off          -> disabled
 *
 * Unknown values default to enabled to allow ad-hoc forms (and to treat `?debug`
 * without value as enabled).
 */

/**
 * @param {any} value
 * @returns {boolean|null} null means "no explicit value provided".
 */
function parseDebugFlag(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return (s !== "0" && s !== "false" && s !== "no" && s !== "off");
}

/**
 * Reads the debug flag from a URL search string.
 *
 * @param {string} [search]
 * @returns {boolean|null} null if the URL does not include the `debug` param.
 */
function getDebugFlagFromUrl(search) {
  try {
    const s =
      search != null
        ? String(search)
        : typeof location !== "undefined"
          ? String(location.search || "")
          : "";

    const params = new URLSearchParams(s);
    if (!params.has("debug")) return null;

    // URLSearchParams returns "" for `?debug` (present but no explicit value).
    const raw = params.get("debug");
    const parsed = parseDebugFlag(raw);
    return parsed != null ? parsed : true;
  } catch (_) {
    return null;
  }
}

/**
 * Convenience wrapper: treat "absent" as false.
 *
 * @param {string} [search]
 */
export function isDebugEnabled(search) {
  const v = getDebugFlagFromUrl(search);
  return v != null ? v : false;
}
