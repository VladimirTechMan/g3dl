/**
 * Orbit (camera) controls for the canvas.
 *
 * Responsibilities:
 * - Pointer-based rotation / pan / zoom (desktop + mobile)
 * - Touch fallback if Pointer Events are unavailable
 * - Mouse wheel zoom
 *
 * Non-responsibilities:
 * - No DOM panel logic
 * - No WebGPU logic other than invoking renderer camera methods
 */

export class OrbitControls {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {any} renderer
   * @param {{
   *   requestRender: (immediate?: boolean) => void,
   *   isNavLocked: () => boolean,
   * }} hooks
   */
  constructor(canvas, renderer, hooks) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.requestRender = hooks.requestRender;
    this.isNavLocked = hooks.isNavLocked;

    // Mouse / pointer state
    this._isDragging = false;
    this._isPanning = false;
    this._lastMouseX = 0;
    this._lastMouseY = 0;
    this._lastMoveTime = 0;

    // Touch/pinch state
    this._lastPinchDistance = 0;

    // Pointer state (unified input for mouse/touch/pen when Pointer Events are available)
    this._activePointers = new Map(); // pointerId -> { x, y, type }

    this._isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

    this._unsubs = [];

    this._install();
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
   * Intended to be called when Screen show navigation lock toggles on.
   */
  cancelInteraction() {
    this._activePointers.clear();
    this._isDragging = false;
    this._isPanning = false;
    this._lastPinchDistance = 0;
    if (this.canvas) this.canvas.style.cursor = "";
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

  _install() {
    const canvas = this.canvas;

    if (!canvas) return;

    if (window.PointerEvent) {
      this._on(canvas, "pointerdown", (e) => this._handlePointerDown(e), {
        passive: false,
      });
      this._on(canvas, "pointermove", (e) => this._handlePointerMove(e), {
        passive: false,
      });
      this._on(canvas, "pointerup", (e) => this._handlePointerUp(e), {
        passive: false,
      });
      this._on(canvas, "pointercancel", (e) => this._handlePointerUp(e), {
        passive: false,
      });
      this._on(canvas, "contextmenu", (e) => e.preventDefault());
    } else {
      // Mouse controls for rotation
      this._on(canvas, "mousedown", (e) => this._handleMouseDown(e));
      this._on(document, "mousemove", (e) => this._handleMouseMove(e));
      this._on(document, "mouseup", (e) => this._handleMouseUp(e));

      // Touch controls
      this._on(canvas, "touchstart", (e) => this._handleTouchStart(e), {
        passive: false,
      });
      this._on(canvas, "touchmove", (e) => this._handleTouchMove(e), {
        passive: false,
      });
      this._on(canvas, "touchend", (e) => this._handleTouchEnd(e), {
        passive: false,
      });
      this._on(canvas, "touchcancel", (e) => this._handleTouchEnd(e), {
        passive: false,
      });
    }

    // Mouse wheel zoom
    this._on(canvas, "wheel", (e) => this._handleWheel(e), { passive: false });

    // Cursor hinting
    canvas.style.cursor = "grab";
  }

  _handlePointerDown(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }
    if (!this.renderer) return;

    if (
      e.pointerType === "mouse" &&
      typeof e.button === "number" &&
      e.button !== 0 &&
      e.button !== 2
    ) {
      return;
    }

    this._activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });

    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (_) {}

    // Stop any ongoing inertia when user starts interacting
    this.renderer.stopInertia();
    this._lastMoveTime = 0;

    if (this._activePointers.size >= 2) {
      // Two-finger (or multi-pointer) pan + pinch zoom
      const pts = Array.from(this._activePointers.values());
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;

      this._lastMouseX = cx;
      this._lastMouseY = cy;

      this._lastPinchDistance = Math.hypot(
        pts[0].x - pts[1].x,
        pts[0].y - pts[1].y,
      );
      this._isDragging = true;
      this._isPanning = true;
      this.canvas.style.cursor = "move";
    } else {
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;
      this._lastPinchDistance = 0;
      this._isDragging = true;
      this._isPanning = e.pointerType === "mouse" && e.shiftKey;
      this.canvas.style.cursor = this._isPanning ? "move" : "grabbing";
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
    if (!this._isDragging || !this._activePointers.has(e.pointerId)) return;

    this._activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });

    if (this._activePointers.size >= 2) {
      const pts = Array.from(this._activePointers.values());
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;

      const dx = cx - this._lastMouseX;
      const dy = cy - this._lastMouseY;

      this.renderer.pan(dx, dy);

      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this._lastPinchDistance > 0) {
        const pinchDelta = this._lastPinchDistance - dist;
        // Scale pinch delta to feel similar to wheel
        this.renderer.zoomCamera(pinchDelta * 2);
      }

      this._lastPinchDistance = dist;
      this._lastMouseX = cx;
      this._lastMouseY = cy;
      this.canvas.style.cursor = "move";
    } else {
      const dx = e.clientX - this._lastMouseX;
      const dy = e.clientY - this._lastMouseY;

      const mousePan =
        e.pointerType === "mouse" &&
        (e.shiftKey ||
          e.altKey ||
          (e.buttons & 2) !== 0 ||
          (this._isMac && e.ctrlKey && (e.buttons & 1) !== 0));

      this._isPanning = mousePan;

      if (mousePan) {
        this.renderer.pan(dx, dy);
        this.canvas.style.cursor = "move";
      } else {
        this.renderer.rotate(dx, dy);
        this.canvas.style.cursor = "grabbing";
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
      // Do not allow the cursor to flip to grabbing while Screen show is actively running.
      // Also cancel any gesture state so the next unlocked interaction starts cleanly.
      this.cancelInteraction();
      e.preventDefault();
      return;
    }

    if (!this.renderer) return;
    this._activePointers.delete(e.pointerId);

    // When last pointer lifts, stop dragging and apply inertia conditions
    if (this._activePointers.size === 0) {
      const now = performance.now();
      const timeSinceMove = now - this._lastMoveTime;

      if (timeSinceMove > 50) {
        this.renderer.stopInertia();
      }
      this._isDragging = false;
      this._isPanning = false;
      this.canvas.style.cursor = "grab";
      this._lastPinchDistance = 0;
    }

    this.requestRender();
    e.preventDefault();
  }

  // Fallback mouse/touch handlers (used only if Pointer Events are not available)

  _handleMouseDown(e) {
    if (this.isNavLocked()) return;

    this.renderer.stopInertia();
    this._isDragging = true;
    this._isPanning = e.shiftKey;
    this._lastMouseX = e.clientX;
    this._lastMouseY = e.clientY;
    this.canvas.style.cursor = this._isPanning ? "move" : "grabbing";
    this.requestRender();
  }

  _handleMouseMove(e) {
    if (this.isNavLocked()) return;
    if (!this._isDragging) return;

    const dx = e.clientX - this._lastMouseX;
    const dy = e.clientY - this._lastMouseY;

    if (this._isPanning) {
      this.renderer.pan(dx, dy);
    } else {
      this.renderer.rotate(dx, dy);
    }

    this._lastMouseX = e.clientX;
    this._lastMouseY = e.clientY;
    this._lastMoveTime = performance.now();
    this.requestRender();
  }

  _handleMouseUp(_e) {
    if (this.isNavLocked()) return;
    const now = performance.now();
    const timeSinceMove = now - this._lastMoveTime;
    if (timeSinceMove > 50) this.renderer.stopInertia();
    this._isDragging = false;
    this._isPanning = false;
    this.canvas.style.cursor = "grab";
  }

  _getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _handleTouchStart(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }
    this.renderer.stopInertia();

    if (e.touches.length === 1) {
      this._isDragging = true;
      this._isPanning = false;
      this._lastMouseX = e.touches[0].clientX;
      this._lastMouseY = e.touches[0].clientY;
      this._lastPinchDistance = 0;
      this.requestRender(true);
    } else if (e.touches.length === 2) {
      this._isDragging = true;
      this._isPanning = true;
      this._lastMouseX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      this._lastMouseY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      this._lastPinchDistance = this._getTouchDistance(e.touches);
      this.requestRender(true);
    }
    e.preventDefault();
  }

  _handleTouchMove(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }
    if (!this._isDragging) return;

    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - this._lastMouseX;
      const dy = e.touches[0].clientY - this._lastMouseY;
      this.renderer.rotate(dx, dy);
      this._lastMouseX = e.touches[0].clientX;
      this._lastMouseY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      const dx = cx - this._lastMouseX;
      const dy = cy - this._lastMouseY;
      this.renderer.pan(dx, dy);

      const dist = this._getTouchDistance(e.touches);
      if (this._lastPinchDistance > 0) {
        const pinchDelta = this._lastPinchDistance - dist;
        this.renderer.zoomCamera(pinchDelta * 2);
      }
      this._lastPinchDistance = dist;
      this._lastMouseX = cx;
      this._lastMouseY = cy;
    }

    this._lastMoveTime = performance.now();
    this.requestRender(true);
    e.preventDefault();
  }

  _handleTouchEnd(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }
    if (e.touches.length === 0) {
      const now = performance.now();
      const timeSinceMove = now - this._lastMoveTime;
      if (timeSinceMove > 50) this.renderer.stopInertia();
      this._isDragging = false;
      this._isPanning = false;
      this._lastPinchDistance = 0;
      this.canvas.style.cursor = "grab";
      this.requestRender(true);
    }
    e.preventDefault();
  }

  _handleWheel(e) {
    if (this.isNavLocked()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    this.zoomFromWheelDelta(e.deltaY, true);
  }
}
