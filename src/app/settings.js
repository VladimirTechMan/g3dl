/**
 * Settings, validation, and share-URL helpers.
 *
 * Goals:
 * - Keep URL parsing/serialization and validation in one place.
 * - Make settings behavior easy to audit and safe to modify.
 * - Keep the UI controller code focused on interactions, not parsing.
 */

/**
 * Rule preset definitions.
 *
 * Keys are legacy preset IDs kept for compatibility with the existing UI.
 */
export const RULE_PRESETS = Object.freeze({
  5766: { survive: "5-7", birth: "6", name: "5766" },
  4555: { survive: "4-5", birth: "5", name: "4555" },
  5655: { survive: "5-6", birth: "5", name: "5655" },
  4526: { survive: "4-5", birth: "2-6", name: "Amoeba" },
  6657: { survive: "6", birth: "5-7", name: "6657" },
  5867: { survive: "5-8", birth: "6-7", name: "5867" },
});

/**
 * Query parameter keys supported by the app for importing/exporting settings.
 */
const SETTINGS_URL_KEYS = Object.freeze([
  "speed",
  "grid",
  "gen0",
  "density",
  "autostop",
  "boundaries",
  "wrap",
  "lantern",
  "cellTop",
  "cellBottom",
  "bgTop",
  "bgBottom",
  "survive",
  "birth",
  "screenshow",
]);

/**
 * A lightweight schema used for documentation and for consistent parsing.
 *
 * NOTE: The UI constrains most values via <input min/max>, but the URL parser
 * must still clamp for correctness and safety.
 */
const SETTINGS_SCHEMA = Object.freeze({
  speed: { type: "int", min: 1, max: 10000 }, // slider value (not delay ms)
  grid: { type: "int", min: 4, max: 256 },
  gen0: { type: "int", min: 2, max: 256 },
  density: { type: "int", min: 1, max: 30 }, // percent points
  autostop: { type: "bool" },
  boundaries: { type: "bool" },
  wrap: { type: "bool" },
  lantern: { type: "bool" },
  screenshow: { type: "bool" },
  cellTop: { type: "hex6" },
  cellBottom: { type: "hex6" },
  bgTop: { type: "hex6" },
  bgBottom: { type: "hex6" },
  survive: { type: "string" },
  birth: { type: "string" },
});

/**
 * Normalize a rule string to a sorted array of numbers for comparison.
 *
 * Input accepts comma-separated integers and ranges (e.g. "5-7, 9").
 * Output is a canonical comma-separated list of integers.
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeRule(str) {
  const result = [];
  const parts = String(str)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((s) => parseInt(s.trim(), 10));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          if (i >= 0 && i <= 26) result.push(i);
        }
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 0 && n <= 26) result.push(n);
    }
  }

  return [...new Set(result)].sort((a, b) => a - b).join(",");
}

/**
 * @param {string|null} v
 * @returns {boolean|null}
 */
function parseBoolParam(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return null;
}

/**
 * @param {string|null} v
 * @returns {number|null}
 */
function parseIntParam(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string|null} v
 * @returns {string|null} A normalized "#rrggbb" string or null.
 */
function normalizeHexColorParam(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return "#" + s.toLowerCase();
}

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Returns true if the current URL contains at least one known settings key.
 *
 * @param {string} [search]
 * @returns {boolean}
 */
export function hasKnownSettingsParams(search = window.location.search) {
  const params = new URLSearchParams(search);
  for (const k of SETTINGS_URL_KEYS) {
    if (params.has(k)) return true;
  }
  return false;
}

/**
 * Applies query-parameter settings to the provided DOM controls.
 *
 * This function is intentionally conservative:
 * - It only applies known keys.
 * - It clamps numeric values to UI ranges.
 * - It validates hex colors.
 *
 * It also returns derived numeric values that the app typically caches as
 * state variables (gridSize, initSize, density).
 *
 * @param {import("../ui/dom.js").dom} dom
 * @param {{ maxGrid?: number }} [opts]
 * @returns {{ gridSize: number|null, initSize: number|null, density: number|null }}
 */
export function applySettingsFromUrl(dom, opts = {}) {
  const params = new URLSearchParams(window.location.search);

  const {
    speedSlider,
    sizeInput,
    initSizeInput,
    densitySlider,
    densityTip,
    stableStopCheckbox,
    gridProjectionCheckbox,
    toroidalCheckbox,
    lanternCheckbox,
    screenShowCheckbox,
    cellColorPicker,
    cellColorPicker2,
    bgColorPicker,
    bgColorPicker2,
    surviveInput,
    birthInput,
  } = dom;

  // Run speed (slider position)
  const speedV = parseIntParam(params.get("speed"));
  if (speedV != null && speedSlider) {
    const min = parseInt(speedSlider.min, 10) || SETTINGS_SCHEMA.speed.min;
    const max = parseInt(speedSlider.max, 10) || SETTINGS_SCHEMA.speed.max;
    speedSlider.value = String(clampInt(speedV, min, max));
  }

  // Grid edge / Gen0 edge
  const gridV = parseIntParam(params.get("grid"));
  if (gridV != null && sizeInput) {
    const min = parseInt(sizeInput.min, 10) || SETTINGS_SCHEMA.grid.min;
    const hardMax =
      typeof opts.maxGrid === "number" ? opts.maxGrid : SETTINGS_SCHEMA.grid.max;
    const max = Math.min(
      hardMax,
      parseInt(sizeInput.max, 10) || SETTINGS_SCHEMA.grid.max,
    );
    sizeInput.value = String(clampInt(gridV, min, max));
  }

  const gen0V = parseIntParam(params.get("gen0"));
  if (gen0V != null && initSizeInput) {
    const min = parseInt(initSizeInput.min, 10) || SETTINGS_SCHEMA.gen0.min;
    const max = parseInt(initSizeInput.max, 10) || SETTINGS_SCHEMA.gen0.max;
    initSizeInput.value = String(clampInt(gen0V, min, max));
  }

  // Density slider value is in percent points
  const densV = parseIntParam(params.get("density"));
  if (densV != null && densitySlider) {
    const min = parseInt(densitySlider.min, 10) || SETTINGS_SCHEMA.density.min;
    const max = parseInt(densitySlider.max, 10) || SETTINGS_SCHEMA.density.max;
    densitySlider.value = String(clampInt(densV, min, max));
    if (densityTip) densityTip.textContent = densitySlider.value + "%";
  }

  // Booleans
  const autoStopV = parseBoolParam(params.get("autostop"));
  if (autoStopV != null && stableStopCheckbox)
    stableStopCheckbox.checked = autoStopV;

  const boundariesV = parseBoolParam(params.get("boundaries"));
  if (boundariesV != null && gridProjectionCheckbox)
    gridProjectionCheckbox.checked = boundariesV;

  const wrapV = parseBoolParam(params.get("wrap"));
  if (wrapV != null && toroidalCheckbox) toroidalCheckbox.checked = wrapV;

  const lanternV = parseBoolParam(params.get("lantern"));
  if (lanternV != null && lanternCheckbox) lanternCheckbox.checked = lanternV;

  const screenShowV = parseBoolParam(params.get("screenshow"));
  if (screenShowV != null && screenShowCheckbox)
    screenShowCheckbox.checked = screenShowV;

  // Colors
  const cellTop = normalizeHexColorParam(params.get("cellTop"));
  if (cellTop && cellColorPicker) cellColorPicker.value = cellTop;

  const cellBottom = normalizeHexColorParam(params.get("cellBottom"));
  if (cellBottom && cellColorPicker2) cellColorPicker2.value = cellBottom;

  const bgTop = normalizeHexColorParam(params.get("bgTop"));
  if (bgTop && bgColorPicker) bgColorPicker.value = bgTop;

  const bgBottom = normalizeHexColorParam(params.get("bgBottom"));
  if (bgBottom && bgColorPicker2) bgColorPicker2.value = bgBottom;

  // Rules (do not accept preset in URL; only explicit Survival/Birth)
  const surviveV = params.get("survive");
  if (surviveV != null && surviveInput) surviveInput.value = surviveV;

  const birthV = params.get("birth");
  if (birthV != null && birthInput) birthInput.value = birthV;

  // Derived values for app state
  const gridSize = sizeInput ? parseInt(sizeInput.value, 10) : null;
  const initSizeRaw = initSizeInput ? parseInt(initSizeInput.value, 10) : null;

  const gridSizeN = Number.isFinite(gridSize) ? gridSize : null;
  let initSizeN = Number.isFinite(initSizeRaw) ? initSizeRaw : null;

  if (gridSizeN != null && initSizeN != null && initSizeN > gridSizeN) {
    initSizeN = gridSizeN;
    if (initSizeInput) initSizeInput.value = String(initSizeN);
  }

  const densSliderN = densitySlider ? parseInt(densitySlider.value, 10) : null;
  const densityN = Number.isFinite(densSliderN) ? densSliderN / 100 : null;

  return { gridSize: gridSizeN, initSize: initSizeN, density: densityN };
}

/**
 * Build a shareable URL containing the current settings.
 *
 * @param {import("../ui/dom.js").dom} dom
 * @param {{ fallbackGridSize: number, fallbackInitSize: number, fallbackDensity: number }} fallbacks
 * @returns {string}
 */
export function buildUrlWithSettings(dom, fallbacks) {
  const params = new URLSearchParams(window.location.search);

  // Remove any previous values for our keys
  for (const k of SETTINGS_URL_KEYS) params.delete(k);

  const speedV = dom.speedSlider ? parseInt(dom.speedSlider.value, 10) : null;
  const gridV = dom.sizeInput ? parseInt(dom.sizeInput.value, 10) : null;
  const gen0V = dom.initSizeInput ? parseInt(dom.initSizeInput.value, 10) : null;
  const densV = dom.densitySlider ? parseInt(dom.densitySlider.value, 10) : null;

  params.set("speed", String(speedV || 300));
  params.set("grid", String(gridV || fallbacks.fallbackGridSize));
  params.set("gen0", String(gen0V || fallbacks.fallbackInitSize));
  params.set(
    "density",
    String(densV || Math.round(fallbacks.fallbackDensity * 100)),
  );

  if (dom.stableStopCheckbox)
    params.set("autostop", dom.stableStopCheckbox.checked ? "1" : "0");
  if (dom.gridProjectionCheckbox)
    params.set("boundaries", dom.gridProjectionCheckbox.checked ? "1" : "0");
  if (dom.toroidalCheckbox)
    params.set("wrap", dom.toroidalCheckbox.checked ? "1" : "0");
  if (dom.lanternCheckbox)
    params.set("lantern", dom.lanternCheckbox.checked ? "1" : "0");
  if (dom.screenShowCheckbox)
    params.set("screenshow", dom.screenShowCheckbox.checked ? "1" : "0");

  params.set(
    "cellTop",
    (dom.cellColorPicker?.value || "#000000").replace("#", ""),
  );
  params.set(
    "cellBottom",
    (dom.cellColorPicker2?.value || "#000000").replace("#", ""),
  );
  params.set(
    "bgTop",
    (dom.bgColorPicker?.value || "#000000").replace("#", ""),
  );
  params.set(
    "bgBottom",
    (dom.bgColorPicker2?.value || "#000000").replace("#", ""),
  );

  params.set("survive", (dom.surviveInput?.value || "").trim());
  params.set("birth", (dom.birthInput?.value || "").trim());

  const url = new URL(window.location.href);
  url.search = params.toString() ? "?" + params.toString() : "";
  return url.toString();
}

/**
 * Kept for backwards compatibility / debugging. Auto-updates are disabled by default.
 * This updates the current location without reloading.
 *
 * @param {string} fullUrl
 */
function replaceLocationWithFullUrl(fullUrl) {
  const u = new URL(fullUrl);
  const rel = u.pathname + u.search + u.hash;
  history.replaceState(null, "", rel);
}

/**
 * A tiny controller for optionally auto-syncing settings into the address bar.
 *
 * In this codebase auto-sync is intentionally off by default (sharing is explicit
 * via the "Copy URL with settings" button), but the call sites are preserved so
 * future experiments are low risk.
 */
export function createUrlSyncController({ enabled = false, buildUrl }) {
  let urlSyncEnabled = !!enabled;
  let urlSyncPending = false;

  /** @returns {void} */
  function request() {
    if (!urlSyncEnabled) return;
    if (urlSyncPending) return;
    urlSyncPending = true;
    Promise.resolve().then(() => {
      urlSyncPending = false;
      try {
        replaceLocationWithFullUrl(buildUrl());
      } catch (_) {
        // ignore
      }
    });
  }

  return {
    get enabled() {
      return urlSyncEnabled;
    },
    set enabled(v) {
      urlSyncEnabled = !!v;
    },
    request,
    updateNow() {
      if (!urlSyncEnabled) return;
      replaceLocationWithFullUrl(buildUrl());
    },
  };
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyTextToClipboard(text) {
  // Prefer the async Clipboard API (works on HTTPS + modern browsers).
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // fall through to legacy path
    }
  }

  // Legacy fallback (best-effort).
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (_) {
    return false;
  }
}

/**
 * Copy a URL with current settings to the clipboard and provide lightweight
 * UX feedback by swapping the button label temporarily.
 *
 * @param {import("../ui/dom.js").dom} dom
 * @param {{ fallbackGridSize: number, fallbackInitSize: number, fallbackDensity: number }} fallbacks
 */
export async function copySettingsUrlToClipboard(dom, fallbacks) {
  const url = buildUrlWithSettings(dom, fallbacks);
  const ok = await copyTextToClipboard(url);

  const btn = dom.copyUrlBtn;
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => {
      if (btn) btn.textContent = old;
    }, 1200);
  }

  return ok;
}

/**
 * Strip all query parameters from the address bar without reloading.
 *
 * Used after a one-time URL-driven initialization to avoid "sticky" settings URLs.
 */
export function stripAllQueryParamsFromAddressBar() {
  try {
    const u = new URL(window.location.href);
    u.search = "";
    history.replaceState(null, "", u.pathname + u.hash);
  } catch (_) {
    // ignore
  }
}
