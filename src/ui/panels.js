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

  // Prefer a single access path for cached elements.
  // This avoids repeated destructuring lists across UI modules.
  const d = dom;

  // No blocking overlay: keep the UI responsive while allowing canvas interaction.
  // We only capture wheel events to prevent page scroll and optionally route zoom to the scene.
  let panelsWheelCaptureInstalled = false;
  const PANEL_SCROLL_SELECTOR = "#settings-panel, #help-panel";

  const PANELS = [
    {
      key: "settings",
      panelEl: d.settingsPanel,
      btnEl: d.settingsBtn,
      isOpen: () =>
        !!d.settingsPanel && !d.settingsPanel.classList.contains("hidden"),
      open: () => {
        if (!d.settingsPanel || !d.settingsBtn) return;
        d.settingsPanel.classList.remove("hidden");
        d.settingsBtn.classList.add("active");
      },
      close: () => {
        if (d.settingsPanel) d.settingsPanel.classList.add("hidden");
        if (d.settingsBtn) d.settingsBtn.classList.remove("active");
      },
    },
    {
      key: "help",
      panelEl: d.helpPanel,
      btnEl: d.helpBtn,
      isOpen: () => !!d.helpPanel && !d.helpPanel.classList.contains("hidden"),
      open: () => {
        if (!d.helpPanel || !d.helpBtn) return;
        d.helpPanel.classList.remove("hidden");
        d.helpBtn.classList.add("active");
      },
      close: () => {
        if (d.helpPanel) d.helpPanel.classList.add("hidden");
        if (d.helpBtn) d.helpBtn.classList.remove("active");
      },
    },
    {
      key: "about",
      panelEl: d.header,
      btnEl: d.infoBtn,
      isOpen: () => !!d.header && d.header.classList.contains("visible"),
      open: () => {
        if (!d.header || !d.infoBtn) return;
        d.header.classList.add("visible");
        d.infoBtn.classList.add("active");
      },
      close: () => {
        if (d.header) d.header.classList.remove("visible");
        if (d.infoBtn) d.infoBtn.classList.remove("active");
      },
    },
  ];

  /** @type {Record<string, any>} */
  const PANELS_BY_KEY = Object.create(null);
  for (const p of PANELS) PANELS_BY_KEY[p.key] = p;

  /**
   * Toggle a named panel and ensure overlay capture policies stay in sync.
   * @param {"settings"|"help"|"about"} key
   */
  function togglePanel(key) {
    const p = PANELS_BY_KEY[key];
    if (!p || !p.panelEl || !p.btnEl) return;
    const shouldOpen = !p.isOpen();
    closeAllPanels();
    if (shouldOpen) {
      p.open();
      updateOverlay();
    }
  }


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
        target.closest(PANEL_SCROLL_SELECTOR) != null;
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
    for (const p of PANELS) {
      if (p.isOpen()) return true;
    }
    return false;
  }

  function updateOverlay() {
    if (isAnyPanelOpen()) ensurePanelOverlay();
    else removePanelOverlay();
  }

  function closeAllPanels() {
    for (const p of PANELS) {
      p.close();
    }

    blurActiveElement();
    updateOverlay();
  }

  function closeSettingsAndHelpPanels() {
    PANELS_BY_KEY.settings?.close();
    PANELS_BY_KEY.help?.close();

    blurActiveElement();
    updateOverlay();
  }

  function toggleSettingsPanel() {
    togglePanel("settings");
  }

  function toggleHelpPanel() {
    togglePanel("help");
  }

  function toggleAboutPanel() {
    togglePanel("about");
  }

  // Wire panel buttons
  add(d.settingsBtn, "click", (e) => {
    e.preventDefault();
    toggleSettingsPanel();
  });

  if (d.helpBtn) {
    add(d.helpBtn, "click", (e) => {
      e.preventDefault();
      toggleHelpPanel();
    });
  }

  if (d.infoBtn) {
    add(d.infoBtn, "click", (e) => {
      e.preventDefault();
      toggleAboutPanel();
    });
  }

  // Close the About panel by tapping anywhere outside the "i" button.
  // On touch devices this makes the panel easy to dismiss without hunting for the toggle.
  const controlsRoot = d.controls;
  const closeAboutFromGlobalTap = (e) => {
    const about = PANELS_BY_KEY.about;
    if (!about || !about.panelEl || !about.btnEl) return;
    if (!about.isOpen()) return;

    // Let the info button toggle in its own handler.
    if (
      d.infoBtn &&
      (e.target === d.infoBtn || d.infoBtn.contains(/** @type {any} */ (e.target)))
    ) {
      return;
    }

    // Dismiss About
    about.close();
    blurActiveElement();
    updateOverlay();

    // If the tap was not on the UI controls, swallow it to avoid unintended camera motion.
    if (!(controlsRoot && controlsRoot.contains(/** @type {any} */ (e.target)))) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Pointer Events are required for supported WebGPU browsers; no legacy touch/mouse paths.
  add(document, "pointerdown", closeAboutFromGlobalTap, { capture: true });

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
