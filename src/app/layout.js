/**
 * Layout and viewport helpers.
 *
 * This module contains UI layout logic that is orthogonal to simulation/rendering.
 * Keeping it separate reduces the surface area of app.js and makes platform-specific
 * behavior (e.g., iOS visualViewport quirks) easier to reason about.
 */

import { getHudInsetsPx } from "./cssLength.js";

/**
 * Best-effort iOS / iPadOS detection (including iPadOS reporting as Mac).
 *
 * This mirrors the logic previously hosted in app.js.
 */
function detectIOS() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouch = navigator.maxTouchPoints || 0;
  const isAppleMobile = /iPad|iPhone|iPod/i.test(ua);
  const isIPadOS13Plus = platform === "MacIntel" && maxTouch > 1;
  return isAppleMobile || isIPadOS13Plus;
}

/**
 * iOS Safari quirk: while pinch-zoomed, `position: fixed` is effectively anchored to the
 * *layout* viewport, which allows HUD elements to be panned completely off-screen.
 *
 * To keep the bottom-left stats HUD visible (and usable as a "safe pinch zone"), we
 * re-anchor it to the *visual* viewport using `visualViewport`.
 *
 * @param {{ statsPanel: HTMLElement | null, signal: AbortSignal }} opts
 * @returns {{ schedule: () => void, cancel: () => void }}
 */
export function createStatsViewportPin(opts) {
  const { statsPanel, signal } = opts || {};

  // Only needed on iOS Safari (incl. iPadOS), and only if visualViewport is available.
  if (!detectIOS() || !statsPanel || !window.visualViewport) {
    return { schedule: () => {}, cancel: () => {} };
  }

  const vv = window.visualViewport;
  let rafId = 0;

  function update() {
    rafId = 0;

    // IMPORTANT: use the same inset values as the CSS, so the pinned position matches
    // the on-screen layout.
    const { bottom: insetBottom, left: insetLeft } = getHudInsetsPx();

    const left = Math.max(0, vv.offsetLeft + insetLeft);
    const top = Math.max(
      0,
      vv.offsetTop + vv.height - insetBottom - statsPanel.offsetHeight,
    );

    // Use top/left to avoid iOS fixed+bottom issues while zoomed/panned.
    statsPanel.style.left = `${left}px`;
    statsPanel.style.top = `${top}px`;
    statsPanel.style.right = "auto";
    statsPanel.style.bottom = "auto";
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(update);
  }

  function cancel() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Keep the panel pinned during visual viewport panning/zooming.
  vv.addEventListener("resize", schedule, { passive: true, signal });
  vv.addEventListener("scroll", schedule, { passive: true, signal });

  // Initial placement
  schedule();

  return { schedule, cancel };
}

/**
 * Match header title width to credit line.
 *
 * @param {HTMLElement | null} headerEl
 */
function matchHeaderWidths(headerEl) {
  if (!headerEl) return;

  const h1 = headerEl.querySelector("h1");
  const credit = headerEl.querySelector(".credit");
  if (!h1 || !credit) return;

  // Temporarily make header visible for measurement if hidden
  const wasHidden = getComputedStyle(headerEl).display === "none";
  if (wasHidden) {
    headerEl.style.visibility = "hidden";
    headerEl.style.display = "block";
    headerEl.style.position = "absolute";
  }

  // Reset font size first
  h1.style.fontSize = "";
  h1.style.letterSpacing = "";

  // Measure
  const creditWidth = credit.offsetWidth;
  const h1Width = h1.offsetWidth;

  if (h1Width > 0 && creditWidth > 0 && h1Width !== creditWidth) {
    // Calculate scale factor
    const currentSize = parseFloat(getComputedStyle(h1).fontSize);
    const ratio = creditWidth / h1Width;
    const newSize = currentSize * ratio;
    // Clamp to reasonable sizes
    h1.style.fontSize = Math.min(Math.max(newSize, 12), 32) + "px";
  }

  // Restore hidden state
  if (wasHidden) {
    headerEl.style.visibility = "";
    headerEl.style.display = "";
    headerEl.style.position = "";
  }
}

/**
 * Coalesce resize/orientation events into a single rAF pass.
 *
 * This avoids redundant layout reads on mobile and ensures swapchain reconfigure
 * (via loop.notifyResizeEvent()) happens at most once per frame.
 *
 * @param {{
 *   headerEl: HTMLElement | null,
 *   scheduleStatsViewportPin: () => void,
 *   getLoop: () => any,
 *   requestRender: (immediate?: boolean) => void
 * }} opts
 * @returns {{ schedule: () => void, cancel: () => void }}
 */
export function createResizeWorkScheduler(opts) {
  const {
    headerEl,
    scheduleStatsViewportPin,
    getLoop,
    requestRender,
  } = opts || {};

  let rafId = 0;

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      matchHeaderWidths(headerEl);
      if (typeof scheduleStatsViewportPin === "function") scheduleStatsViewportPin();

      const loop = typeof getLoop === "function" ? getLoop() : null;
      if (loop && typeof loop.notifyResizeEvent === "function") loop.notifyResizeEvent();
      else if (typeof requestRender === "function") requestRender(true);
    });
  }

  function cancel() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  return { schedule, cancel };
}
