/**
 * Keyboard shortcut handling.
 *
 * The hotkey logic is kept separate from app.js to reduce the size of the main
 * module and to keep UI policy decisions (what keys do what, and when) in one
 * place.
 */

/**
 * Returns true if the active element is a text-entry control where we should not
 * capture global hotkeys.
 *
 * @param {Element | null} el
 */
export function isTextEntryElement(el) {
  if (!el || !el.tagName) return false;

  const tag = String(el.tagName).toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    // Treat most input types as text entry (avoid stealing keystrokes)
    // but allow hotkeys when sliders/checkboxes/color pickers have focus.
    return ![
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "range",
      "color",
      "file",
    ].includes(type);
  }
  return false;
}

/**
 * Create the global keydown handler.
 *
 * All dependencies are injected to keep the handler testable and to avoid tight
 * coupling to app.js module state.
 *
 * @param {{
 *   settingsPanel: HTMLElement | null,
 *   getScreenShowNavLocked: () => boolean,
 *   togglePlay: () => void,
 *   step: () => void,
 *   reset: () => void,
 *   toggleFullscreen: () => void,
 *   getRenderer: () => any,
 *   requestRender: (immediate?: boolean) => void,
 * }} opts
 */
export function createKeyDownHandler(opts) {
  const {
    settingsPanel,
    getScreenShowNavLocked,
    togglePlay,
    step,
    reset,
    toggleFullscreen,
    getRenderer,
    requestRender,
  } = opts || {};

  return function handleKeyDown(e) {
    if (!e || e.isComposing) return;

    // Do not intercept browser/OS shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const active = document.activeElement;

    // If the user is typing (e.g., rules or size), do not steal keystrokes.
    if (isTextEntryElement(active)) return;

    // Blur focused buttons so Space/Enter doesn't double-trigger them.
    if (active && active.tagName === "BUTTON") {
      active.blur();
    }

    const navLocked =
      typeof getScreenShowNavLocked === "function" ? !!getScreenShowNavLocked() : false;
    const renderer = typeof getRenderer === "function" ? getRenderer() : null;

    switch (String(e.key || "").toLowerCase()) {
      case " ":
        // If Settings are open, let Space perform native UI actions
        // (scroll the panel, toggle focused checkboxes, etc.) rather than
        // being treated as a global Run/Pause hotkey.
        if (settingsPanel && !settingsPanel.classList.contains("hidden")) {
          return;
        }
        e.preventDefault();
        if (typeof togglePlay === "function") togglePlay();
        break;
      case "s":
        e.preventDefault();
        if (typeof step === "function") step();
        break;
      case "r":
        e.preventDefault();
        if (typeof reset === "function") reset();
        break;
      case "f":
        e.preventDefault();
        if (typeof toggleFullscreen === "function") toggleFullscreen();
        break;
      case "c":
        if (navLocked) break;
        if (!renderer || typeof renderer.resetPan !== "function") break;
        e.preventDefault();
        renderer.resetPan();
        // If the simulation is paused and no other animation is active,
        // explicitly request a redraw so the user sees the centering immediately.
        if (typeof requestRender === "function") requestRender(true);
        break;
      case "b":
        if (navLocked) break;
        if (!renderer || typeof renderer.resetView !== "function") break;
        e.preventDefault();
        renderer.resetView();
        if (typeof requestRender === "function") requestRender(true);
        break;
      default:
        // Do not block other keys; keep accessibility and native behaviors intact.
        break;
    }
  };
}
