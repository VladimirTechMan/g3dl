/**
 * Panel UX (Settings / Help / About) and related global capture policies.
 *
 * This module intentionally does NOT install a pointer/touch blocking overlay.
 * Instead, it captures wheel events to prevent page scrolling and optionally
 * routes wheel zoom to the scene when panels are open.
 */

import { on } from "../util/events.js";

/**
 * @param {any} dom
 * @param {any} handlers
 * @returns {{
 *   destroy: () => void,
 *   closeSettingsAndHelpPanels: () => void,
 *   closeAllPanels: () => void,
 *   isAnyPanelOpen: () => boolean,
 * }}
 */
export function createPanelManager(dom, handlers) {
  /** @type {Array<() => void>} */
  const unsubs = [];
  const add = (el, type, fn, opts) => {
    if (!el) return;
    unsubs.push(on(el, type, fn, opts));
  };

  const {
    settingsBtn,
    helpBtn,
    settingsPanel,
    helpPanel,
    controls,
    helpCloseBtn,
    settingsCloseBtn,
    infoBtn,
    header,
    perfBtn,
    perfPanel,
  } = dom;

  // No blocking overlay: keep the UI responsive while allowing canvas interaction.
  // We only capture wheel events to prevent page scroll and optionally route zoom to the scene.
  let panelsWheelCaptureInstalled = false;

  function blurActiveElement() {
    const ae = document.activeElement;
    if (!ae) return;
    if (ae instanceof HTMLElement) ae.blur();
  }

  function panelsOpenWheelCapture(e) {
    // When a panel is open, allow wheel scrolling inside the panel itself.
    const target = /** @type {any} */ (e.target);
    if (target && target.closest) {
      const insidePanel =
        target.closest("#settings-panel, #help-panel, #perf-panel") != null;
      if (insidePanel) return;
    }

    // Otherwise, route wheel to the scene (zoom) even if the cursor is outside the canvas.
    if (handlers.routeWheelToScene) {
      handlers.routeWheelToScene(e);
      return;
    }
  }

  function ensurePanelOverlay() {
    // Do NOT install a blocking overlay for pointer/touch; allow interaction with the canvas
    // while panels are open. Only capture wheel events.
    if (!panelsWheelCaptureInstalled) {
      document.addEventListener("wheel", panelsOpenWheelCapture, {
        passive: false,
        capture: true,
      });
      panelsWheelCaptureInstalled = true;
    }
  }

  function removePanelOverlay() {
    if (panelsWheelCaptureInstalled && !isAnyPanelOpen()) {
      document.removeEventListener("wheel", panelsOpenWheelCapture, true);
      panelsWheelCaptureInstalled = false;
    }
  }

  function isAnyPanelOpen() {
    if (header && header.classList.contains("visible")) return true;
    if (settingsPanel && !settingsPanel.classList.contains("hidden")) return true;
    if (helpPanel && !helpPanel.classList.contains("hidden")) return true;
    if (perfPanel && !perfPanel.classList.contains("hidden")) return true;
    return false;
  }

  function updateOverlay() {
    if (isAnyPanelOpen()) ensurePanelOverlay();
    else removePanelOverlay();
  }

  function closeAllPanels() {
    if (settingsPanel) settingsPanel.classList.add("hidden");
    if (settingsBtn) settingsBtn.classList.remove("active");

    if (helpPanel) helpPanel.classList.add("hidden");
    if (helpBtn) helpBtn.classList.remove("active");

    if (perfPanel) perfPanel.classList.add("hidden");
    if (perfBtn) perfBtn.classList.remove("active");

    if (header) header.classList.remove("visible");
    if (infoBtn) infoBtn.classList.remove("active");

    blurActiveElement();
    updateOverlay();
  }

  function closeSettingsAndHelpPanels() {
    if (settingsPanel) settingsPanel.classList.add("hidden");
    if (settingsBtn) settingsBtn.classList.remove("active");

    if (helpPanel) helpPanel.classList.add("hidden");
    if (helpBtn) helpBtn.classList.remove("active");

    blurActiveElement();
    updateOverlay();
  }

  function toggleSettingsPanel() {
    if (!settingsPanel || !settingsBtn) return;
    const shouldOpen = settingsPanel.classList.contains("hidden");
    closeAllPanels();
    if (shouldOpen) {
      settingsPanel.classList.remove("hidden");
      settingsBtn.classList.add("active");
      updateOverlay();
    }
  }

  function toggleHelpPanel() {
    if (!helpPanel || !helpBtn) return;
    const shouldOpen = helpPanel.classList.contains("hidden");
    closeAllPanels();
    if (shouldOpen) {
      helpPanel.classList.remove("hidden");
      helpBtn.classList.add("active");
      updateOverlay();
    }
  }

  function togglePerfPanel() {
    if (!perfPanel || !perfBtn) return;
    const shouldOpen = perfPanel.classList.contains("hidden");
    closeAllPanels();
    if (shouldOpen) {
      perfPanel.classList.remove("hidden");
      perfBtn.classList.add("active");
      updateOverlay();
    }
  }

  function toggleAboutPanel() {
    if (!header || !infoBtn) return;
    const shouldOpen = !header.classList.contains("visible");
    closeAllPanels();
    if (shouldOpen) {
      header.classList.add("visible");
      infoBtn.classList.add("active");
      updateOverlay();
    }
  }

  // Wire panel buttons
  add(settingsBtn, "click", (e) => {
    e.preventDefault();
    toggleSettingsPanel();
  });

  if (helpBtn) {
    add(helpBtn, "click", (e) => {
      e.preventDefault();
      toggleHelpPanel();
    });
  }
  if (helpCloseBtn) {
    add(helpCloseBtn, "click", (e) => {
      e.preventDefault();
      toggleHelpPanel();
    });
  }
  if (settingsCloseBtn) {
    add(settingsCloseBtn, "click", (e) => {
      e.preventDefault();
      toggleSettingsPanel();
    });
  }

  if (perfBtn) {
    add(perfBtn, "click", (e) => {
      e.preventDefault();
      togglePerfPanel();
    });
  }

  if (infoBtn) {
    add(infoBtn, "click", (e) => {
      e.preventDefault();
      toggleAboutPanel();
    });
  }

  // Close the About panel by tapping anywhere outside the "i" button.
  // On touch devices this makes the panel easy to dismiss without hunting for the toggle.
  const controlsRoot = controls;
  const closeAboutFromGlobalTap = (e) => {
    if (!header || !infoBtn) return;
    if (!header.classList.contains("visible")) return;

    // Let the info button toggle in its own handler.
    if (e.target === infoBtn || infoBtn.contains(e.target)) return;

    // Dismiss About
    header.classList.remove("visible");
    infoBtn.classList.remove("active");
    blurActiveElement();
    updateOverlay();

    // If the tap was not on the UI controls, swallow it to avoid unintended camera motion.
    if (!(controlsRoot && controlsRoot.contains(e.target))) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (window.PointerEvent) {
    document.addEventListener("pointerdown", closeAboutFromGlobalTap, {
      capture: true,
    });
    unsubs.push(() =>
      document.removeEventListener("pointerdown", closeAboutFromGlobalTap, true),
    );
  } else {
    document.addEventListener("touchstart", closeAboutFromGlobalTap, {
      capture: true,
      passive: false,
    });
    document.addEventListener("mousedown", closeAboutFromGlobalTap, true);
    unsubs.push(() =>
      document.removeEventListener("touchstart", closeAboutFromGlobalTap, true),
    );
    unsubs.push(() =>
      document.removeEventListener("mousedown", closeAboutFromGlobalTap, true),
    );
  }

  // Close panels with Escape
  add(document, "keydown", (e) => {
    if (e.key === "Escape" && isAnyPanelOpen()) {
      e.preventDefault();
      closeAllPanels();
    }
  });

  updateOverlay();

  return {
    destroy() {
      for (const u of unsubs.splice(0)) {
        try {
          u();
        } catch (_) {}
      }
      removePanelOverlay();
    },
    closeSettingsAndHelpPanels,
    closeAllPanels,
    isAnyPanelOpen,
  };
}
