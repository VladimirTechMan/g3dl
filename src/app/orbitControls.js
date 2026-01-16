/**
 * Orbit (camera) controls for the canvas.
 *
 * Responsibilities:
 * - Pointer Events rotation / pan / pinch-zoom (desktop + mobile)
 * - Mouse wheel zoom
 *
 * Non-responsibilities:
 * - No DOM panel logic
 * - No WebGPU logic other than invoking renderer camera methods
 *
 * Notes:
 * - This app targets modern browsers (WebGPU + Pointer Events). We intentionally do not keep a
 *   legacy Touch Events path to reduce complexity and avoid double-handling edge cases.
 */

import { debugWarn } from "../util/log.js";

export class OrbitControls {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {any} renderer
   * @param {{ requestRender: (immediate?: boolean) => void, isNavLocked?: () => boolean }} opts
   */
  constructor(canvas, renderer, opts) {
    this.canvas = canvas;
    this.renderer = renderer;

    this.requestRender =
      opts && typeof opts.requestRender === "function"
        ? opts.requestRender
        : () => {};

    this._isNavLocked =
      opts && typeof opts.isNavLocked === "function" ? opts.isNavLocked : () => false;

    /** @type {Map<number, {x:number, y:number, type:string}>} */
    this._activePointers = new Map();

    // Drag state
    this._isDragging = false;
    this._isPanning = false;
    this._lastMouseX = 0;
    this._lastMouseY = 0;
    this._lastMoveTime = 0;

    // Pinch state (use stable pair to avoid jumps if 3+ pointers are present)
    /** @type {number|null} */
    this._pinchId0 = null;
    /** @type {number|null} */
    this._pinchId1 = null;
    this._lastPinchDistance = 0;

    // Prevent the common "snap rotate" after finishing a two-finger gesture on mobile:
    // once we transition from 2+ pointers to 1 pointer, ignore single-pointer rotation
    // until all pointers are released.
    this._suppressTouchRotateUntilRelease = false;

    // Cursor caching (avoid redundant style writes during high-frequency move events)
    this._cursor = "";

    this._isMac =
      typeof navigator !== "undefined" &&
      typeof navigator.platform === "string" &&
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

    /** @type {Array<() => void>} */
    this._unsubs = [];

    this._install();
  }

  /**
   * @returns {boolean}
   */
  isNavLocked() {
    try {
      return !!this._isNavLocked();
    } catch (_) {
      return false;
    }
  }

  /**
   * @returns {boolean}
   */
  isInteracting() {
    return this._isDragging || this._isPanning || this._activePointers.size > 0;
  }

  /**
   * Zoom helper that can be called from outside (e.g., global wheel capture while panels are open).
   * @param {number} deltaY
   * @param {boolean} [immediate]
   * @returns {boolean} true if applied
   */
  zoomFromWheelDelta(deltaY, immediate = true) {
    if (this.isNavLocked()) return false;
    if (!this.renderer) return false;
    this.renderer.zoomCamera(deltaY);
    this.requestRender(immediate);
    return true;
  }

  /**
   * Cancel any in-progress gesture state.
   * Intended to be called when Screen show navigation becomes locked.
   */
  cancelInteraction() {
    this._activePointers.clear();
    this._isDragging = false;
    this._isPanning = false;
    this._pinchId0 = null;
    this._pinchId1 = null;
    this._lastPinchDistance = 0;
    this._suppressTouchRotateUntilRelease = false;
    this._setCursor("");
  }

  destroy() {
    for (const u of this._unsubs.splice(0)) {
      try {
        u();
      } catch (_) {}
    }
    this._activePointers.clear();
  }

  _on(el, type, fn, opts) {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    this._unsubs.push(() => el.removeEventListener(type, fn, opts));
  }

  _setCursor(value) {
    const canvas = this.canvas;
    if (!canvas) return;
    if (value === this._cursor) return;
    this._cursor = value;
    canvas.style.cursor = value;
  }

  _install() {
    const canvas = this.canvas;
    if (!canvas) return;

    if (!window.PointerEvent) {
      // Target platforms for this project should always support Pointer Events.
      debugWarn("Pointer Events unavailable; OrbitControls disabled.");
      return;
    }

    this._on(canvas, "pointerdown", (e) => this._handlePointerDown(e), { passive: false });
    this._on(canvas, "pointermove", (e) => this._handlePointerMove(e), { passive: false });
    this._on(canvas, "pointerup", (e) => this._handlePointerUp(e), { passive: false });
    this._on(canvas, "pointercancel", (e) => this._handlePointerUp(e), { passive: false });
    this._on(canvas, "contextmenu", (e) => e.preventDefault());

    // Mouse wheel zoom
    this._on(canvas, "wheel", (e) => this._handleWheel(e), { passive: false });

    // Cursor hinting
    this._setCursor("grab");
  }

  _choosePinchPairIfNeeded() {
    // Keep existing pair if still valid.
    if (
      this._pinchId0 != null &&
      this._pinchId1 != null &&
      this._activePointers.has(this._pinchId0) &&
      this._activePointers.has(this._pinchId1) &&
      this._pinchId0 !== this._pinchId1
    ) {
      return true;
    }

    // Pick the first two active pointer IDs deterministically.
    const it = this._activePointers.keys();
    const a = it.next();
    const b = it.next();
    if (a.done || b.done) return false;

    this._pinchId0 = a.value;
    this._pinchId1 = b.value;
    return true;
  }

  _resetPinchBaseline() {
    if (!this._choosePinchPairIfNeeded()) return;

    const p0 = this._activePointers.get(this._pinchId0);
    const p1 = this._activePointers.get(this._pinchId1);
    if (!p0 || !p1) return;

    const cx = (p0.x + p1.x) / 2;
    const cy = (p0.y + p1.y) / 2;
    this._lastMouseX = cx;
    this._lastMouseY = cy;
    this._lastPinchDistance = Math.hypot(p0.x - p1.x, p0.y - p1.y);
  }

  _handlePointerDown(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }
    if (!this.renderer) return;

    // Ignore non-primary buttons (except allow right-click for panning on desktop).
    if (
      e.pointerType === "mouse" &&
      typeof e.button === "number" &&
      e.button !== 0 &&
      e.button !== 2
    ) {
      return;
    }

    // Start tracking pointer.
    this._activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });

    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (_) {}

    // Stop any ongoing inertia when user starts interacting.
    this.renderer.stopInertia();
    this._lastMoveTime = 0;

    this._isDragging = true;

    if (this._activePointers.size >= 2) {
      // Enter multi-pointer mode: establish a stable pinch pair and baseline.
      this._suppressTouchRotateUntilRelease = false;
      this._resetPinchBaseline();
      this._setCursor("move");
    } else {
      // Single pointer: record baseline.
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;

      // On mouse, allow immediate panning based on modifier.
      this._isPanning = e.pointerType === "mouse" && e.shiftKey;
      this._setCursor(this._isPanning ? "move" : "grabbing");
    }

    this.requestRender();
    e.preventDefault();
  }

  _handlePointerMove(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }

    if (!this.renderer) return;
    if (!this._isDragging) return;

    const p = this._activePointers.get(e.pointerId);
    if (!p) return;

    // Update pointer state in-place (avoid per-move allocations).
    p.x = e.clientX;
    p.y = e.clientY;
    p.type = e.pointerType;

    if (this._activePointers.size >= 2) {
      // Two-finger (or multi-pointer) pan + pinch zoom using a stable pointer pair.
      if (!this._choosePinchPairIfNeeded()) return;

      const p0 = this._activePointers.get(this._pinchId0);
      const p1 = this._activePointers.get(this._pinchId1);
      if (!p0 || !p1) return;

      const cx = (p0.x + p1.x) / 2;
      const cy = (p0.y + p1.y) / 2;

      const dx = cx - this._lastMouseX;
      const dy = cy - this._lastMouseY;
      this.renderer.pan(dx, dy);

      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      if (this._lastPinchDistance > 0) {
        const pinchDelta = this._lastPinchDistance - dist;
        // Scale pinch delta to feel similar to wheel.
        this.renderer.zoomCamera(pinchDelta * 2);
      }

      this._lastPinchDistance = dist;
      this._lastMouseX = cx;
      this._lastMouseY = cy;

      this._setCursor("move");
    } else {
      // Single pointer: on touch/pen, optionally suppress accidental rotate after pinch.
      if (this._suppressTouchRotateUntilRelease && e.pointerType !== "mouse") {
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
        this._setCursor("grab");
        this.requestRender();
        e.preventDefault();
        return;
      }

      const dx = e.clientX - this._lastMouseX;
      const dy = e.clientY - this._lastMouseY;

      // Mouse panning: shift/alt/right button; on macOS, ctrl+left should behave like right click.
      const mousePan =
        e.pointerType === "mouse" &&
        (e.shiftKey ||
          e.altKey ||
          (e.buttons & 2) !== 0 ||
          (this._isMac && e.ctrlKey && (e.buttons & 1) !== 0));

      this._isPanning = mousePan;

      if (mousePan) {
        this.renderer.pan(dx, dy);
        this._setCursor("move");
      } else {
        this.renderer.rotate(dx, dy);
        this._setCursor("grabbing");
      }

      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;
    }

    this._lastMoveTime = performance.now();
    this.requestRender();
    e.preventDefault();
  }

  _handlePointerUp(e) {
    if (this.isNavLocked()) {
      // Do not allow the cursor to flip while Screen show is actively running.
      // Also cancel any gesture state so the next unlocked interaction starts cleanly.
      this.cancelInteraction();
      e.preventDefault();
      return;
    }

    if (!this.renderer) return;

    const prevCount = this._activePointers.size;
    this._activePointers.delete(e.pointerId);

    // Transition from 2+ pointers to 1 pointer: suppress accidental rotation until all release.
    if (prevCount >= 2 && this._activePointers.size === 1) {
      this._suppressTouchRotateUntilRelease = true;
      this._pinchId0 = null;
      this._pinchId1 = null;
      this._lastPinchDistance = 0;

      // Reset baseline to the remaining pointer to avoid dx/dy jump if events still arrive.
      const it = this._activePointers.values();
      const rem = it.next().value;
      if (rem) {
        this._lastMouseX = rem.x;
        this._lastMouseY = rem.y;
      }

      this._setCursor("grab");
      this.requestRender();
      e.preventDefault();
      return;
    }

    // When last pointer lifts: stop dragging and apply inertia conditions.
    if (this._activePointers.size === 0) {
      const now = performance.now();
      const timeSinceMove = now - this._lastMoveTime;

      if (timeSinceMove > 50) {
        this.renderer.stopInertia();
      }
      this._isDragging = false;
      this._isPanning = false;
      this._pinchId0 = null;
      this._pinchId1 = null;
      this._lastPinchDistance = 0;
      this._suppressTouchRotateUntilRelease = false;
      this._setCursor("grab");
    }

    this.requestRender();
    e.preventDefault();
  }

  _handleWheel(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }

    // Support wheel even if panels are open.
    // Prevent page scroll while interacting with the canvas.
    const applied = this.zoomFromWheelDelta(e.deltaY, false);
    if (applied) e.preventDefault();
  }
}
