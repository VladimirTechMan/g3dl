/**
 * Overlay helpers for the loading and error screens.
 *
 * These are pure DOM operations with no app-state dependencies, so they can
 * be imported directly by any module that needs them.
 */

/**
 * Fade out and remove the loading overlay.
 */
export function hideLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  if (!overlay) return;
  if (overlay.classList.contains("is-hidden")) return;

  overlay.classList.add("is-hidden");
  // Remove from the DOM after the fade to avoid blocking focus/interaction.
  window.setTimeout(() => overlay.remove(), 220);
}

/**
 * Show the "WebGPU not supported" error overlay with a specific reason.
 *
 * @param {unknown} reason
 */
export function showNotSupportedMessage(reason) {
  hideLoadingOverlay();
  const overlay = document.getElementById("webgpu-not-supported");
  if (!overlay) return;
  const reasonEl = document.getElementById("not-supported-reason");
  if (reasonEl) reasonEl.textContent = String(reason || "WebGPU initialization failed.");
  overlay.classList.remove("hidden");
}
