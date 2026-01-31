/**
 * Runtime contract check between app.js and WebGPURenderer.
 *
 * This is a low-cost safety net during refactors: if renderer.js is accidentally
 * truncated or a method is renamed, we fail fast with a helpful error message
 * instead of encountering hard-to-debug "is not a function" crashes later.
 *
 * **Debug-only**: this module is lazy-loaded from `src/app/app.js` only when the
 * `?debug` URL flag is enabled, to avoid shipping extra checks on the hot path.
 */

const REQUIRED_METHODS = [
  "init",
  "render",
  "step",
  "resize",
  "randomize",
  // Camera controls (used by OrbitControls)
  "rotate",
  "pan",
  "zoomCamera",
  "resetView",
  "resetPan",
  "stopInertia",
  "updateInertia",
  "setGridSize",
  "getMaxSupportedGridSize",
  "setSurviveRule",
  "setBirthRule",
  "setToroidal",
  "setChangeDetectionEnabled",
  "setCellColors",
  "setBackgroundColors",
  "setLanternLightingEnabled",
  "setGridProjectionEnabled",
  "setCameraOverride",
  "clearCameraOverride",
  "commitCameraOverrideToUser",
];

const REQUIRED_FIELDS = [
  "gridSize",
  "cellSize",
  "population",
  "generation",
  "statsValidGeneration",
  "cameraQuat",
  "cameraMatrix",
  "cameraDistance",
  "panX",
  "panY",
];

/**
 * @param {any} renderer
 */
export function assertRendererApi(renderer) {
  const missing = [];
  for (const m of REQUIRED_METHODS) {
    if (!renderer || typeof renderer[m] !== "function") missing.push(m + "()");
  }
  for (const f of REQUIRED_FIELDS) {
    if (!renderer || !(f in renderer)) missing.push(f);
  }
  if (missing.length) {
    throw new Error(
      "Renderer API mismatch. Missing: " + missing.join(", ") +
        ". Ensure src/gpu/renderer.js exports the full WebGPURenderer implementation.",
    );
  }
}
