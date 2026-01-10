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

    // Pinch (multi-pointer) state
    this._lastPinchDistance = 0;

    // Multi-pointer gesture guard:
    // After a multi-touch gesture (2+ pointers), some mobile browsers will
    // transiently leave one pointer active while the user is lifting fingers.
    // Any slight motion during that transition can be misinterpreted as a
    // single-finger rotate and produce an unexpected, fast scene rotation.
    //
    // To avoid this, we suppress single-finger touch rotation after leaving
    // multi-touch mode until all pointers are released (i.e., the user lifts
    // the remaining finger) and a fresh gesture begins.
    this._suppressTouchRotateUntilRelease = false;

    // Pointer state (unified input for mouse/touch/pen when Pointer Events are available)
    this._activePointers = new Map(); // pointerId -> { x, y, type }

    // Stable pinch pair tracking.
    // When 3+ pointers are active (e.g., accidental palm contact), always keep
    // using the same two pointerIds for pinch until one of them lifts. This
    // improves gesture stability and avoids sudden center/distance jumps that
    // can occur if we always pick the first two pointers from the Map.
    this._pinchId0 = null;
    this._pinchId1 = null;

    // Cursor cache (avoid redundant style writes during high-frequency move events)
    this._cursor = "";

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
    this._pinchId0 = null;
    this._pinchId1 = null;
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
    this._pinchId0 = null;
    this._pinchId1 = null;
    this._suppressTouchRotateUntilRelease = false;
  }

  /**
   * Update the canvas cursor only when it changes.
   * This avoids redundant style writes during high-frequency pointer events.
   * @param {string} cursor
   */
  _setCursor(cursor) {
    if (!this.canvas) return;
    if (this._cursor === cursor) return;
    this._cursor = cursor;
    this.canvas.style.cursor = cursor;
  }

  /**
   * Ensure a stable pinch pair is selected when 2+ pointers are active.
   *
   * When the pair changes (e.g., one of the pinch fingers lifts and we fall back
   * to a remaining pointer + another active pointer), we also reset the gesture
   * baseline (center + distance) to avoid sudden jumps.
   *
   * @param {number|null} [preferId] If provided and present, this id will be used as the first pinch pointer.
   * @returns {boolean} true if a valid pair is available
   */
  _recomputePinchPair(preferId = null) {
    if (this._activePointers.size < 2) {
      this._pinchId0 = null;
      this._pinchId1 = null;
      return false;
    }

    /** @type {number|null} */
    let id0 =
      preferId != null && this._activePointers.has(preferId) ? preferId : null;
    /** @type {number|null} */
    let id1 = null;

    for (const id of this._activePointers.keys()) {
      if (id === id0) continue;
      if (id0 == null) {
        id0 = id;
        continue;
      }
      id1 = id;
      break;
    }

    if (id0 == null || id1 == null) {
      this._pinchId0 = null;
      this._pinchId1 = null;
      return false;
    }

    this._pinchId0 = id0;
    this._pinchId1 = id1;

    const p0 = this._activePointers.get(id0);
    const p1 = this._activePointers.get(id1);
    if (!p0 || !p1) {
      this._pinchId0 = null;
      this._pinchId1 = null;
      return false;
    }

    const cx = (p0.x + p1.x) / 2;
    const cy = (p0.y + p1.y) / 2;
    this._lastMouseX = cx;
    this._lastMouseY = cy;
    this._lastPinchDistance = Math.hypot(p0.x - p1.x, p0.y - p1.y);

    return true;
  }

  _on(el, type, fn, opts) {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    this._unsubs.push(() => el.removeEventListener(type, fn, opts));
  }

  _install() {
    const canvas = this.canvas;

    if (!canvas) return;

    // This app targets modern WebGPU-capable browsers; Pointer Events are required
    // for consistent input across mouse, touch, and pen.
    if (!window.PointerEvent) {
      // We intentionally do not provide a legacy Touch Events fallback.
      console.warn("Pointer Events are required for interaction in this app.");
    }

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

    // Mouse wheel zoom
    this._on(canvas, "wheel", (e) => this._handleWheel(e), { passive: false });

    // Cursor hinting
    this._setCursor("grab");
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

    const prevPointerCount = this._activePointers.size;

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
      // New multi-touch gesture; allow pinch/pan immediately.
      this._suppressTouchRotateUntilRelease = false;

      // Two-finger (or multi-pointer) pan + pinch zoom.
      // Only (re)initialize the pinch baseline when entering multi-pointer mode
      // or when the current tracked pair is invalid.
      const enteringMulti = prevPointerCount < 2;

      const pinchValid =
        this._pinchId0 != null &&
        this._pinchId1 != null &&
        this._activePointers.has(this._pinchId0) &&
        this._activePointers.has(this._pinchId1);

      if (enteringMulti || !pinchValid) {
        if (!this._recomputePinchPair()) return;
      }

      this._isDragging = true;
      this._isPanning = true;
      this._setCursor("move");
    } else {
      // Single pointer.
      this._pinchId0 = null;
      this._pinchId1 = null;
      // Fresh single-pointer gesture; re-arm touch rotation.
      this._suppressTouchRotateUntilRelease = false;
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;
      this._lastPinchDistance = 0;
      this._isDragging = true;
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

    // Update in-place to avoid allocating a new object each move.
    const p = this._activePointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this._activePointers.size >= 2) {
      // Multi-pointer pan + pinch zoom using a stable pinch pair.
      let p0 =
        this._pinchId0 != null ? this._activePointers.get(this._pinchId0) : null;
      let p1 =
        this._pinchId1 != null ? this._activePointers.get(this._pinchId1) : null;

      if (!p0 || !p1) {
        // Pair is stale (e.g., one finger lifted but another is still down).
        // Prefer the currently moving pointer as part of the new pair to
        // minimize perceived discontinuity.
        if (!this._recomputePinchPair(e.pointerId)) return;
        p0 = this._activePointers.get(this._pinchId0);
        p1 = this._activePointers.get(this._pinchId1);
        if (!p0 || !p1) return;
      }

      const cx = (p0.x + p1.x) / 2;
      const cy = (p0.y + p1.y) / 2;

      const dx = cx - this._lastMouseX;
      const dy = cy - this._lastMouseY;

      this.renderer.pan(dx, dy);

      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      if (this._lastPinchDistance > 0) {
        const pinchDelta = this._lastPinchDistance - dist;
        // Scale pinch delta to feel similar to wheel
        this.renderer.zoomCamera(pinchDelta * 2);
      }

      this._lastPinchDistance = dist;
      this._lastMouseX = cx;
      this._lastMouseY = cy;
      this._setCursor("move");
    } else {
      // Safety: if we fell back to a single pointer, clear any pinch state and
      // reset the baseline to avoid a large dx/dy jump.
      if (this._pinchId0 != null || this._pinchId1 != null) {
        this._pinchId0 = null;
        this._pinchId1 = null;
        this._lastPinchDistance = 0;
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
      }

      // Post-pinch suppression (touch/pen): when a multi-touch gesture ends,
      // some browsers leave one pointer active momentarily. Any incidental
      // motion while the user is lifting fingers can otherwise be interpreted
      // as a single-finger rotate and cause a sudden scene jerk.
      if (e.pointerType !== "mouse" && this._suppressTouchRotateUntilRelease) {
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
        this._setCursor("grab");
        e.preventDefault();
        return;
      }

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
      // Do not allow the cursor to flip to grabbing while Screen show is actively running.
      // Also cancel any gesture state so the next unlocked interaction starts cleanly.
      this.cancelInteraction();
      e.preventDefault();
      return;
    }

    if (!this.renderer) return;

    const wasPinchId0 = e.pointerId === this._pinchId0;
    const wasPinchId1 = e.pointerId === this._pinchId1;
    const preferId =
      wasPinchId0 && this._pinchId1 != null
        ? this._pinchId1
        : wasPinchId1 && this._pinchId0 != null
          ? this._pinchId0
          : null;

    const prevPointerCount = this._activePointers.size;
    this._activePointers.delete(e.pointerId);

    // Gesture transitions:
    // - 2+ -> 1: reset baseline to remaining pointer to avoid a large dx/dy jump
    // - 3+ with a pinch finger lifted: re-pick a stable pinch pair and reset baseline
    if (this._activePointers.size >= 2) {
      const pinchValid =
        this._pinchId0 != null &&
        this._pinchId1 != null &&
        this._activePointers.has(this._pinchId0) &&
        this._activePointers.has(this._pinchId1);

      if (!pinchValid || wasPinchId0 || wasPinchId1) {
        // Prefer keeping the remaining finger from the previous pinch pair.
        this._recomputePinchPair(
          preferId != null && this._activePointers.has(preferId) ? preferId : null,
        );
      }

      this._isDragging = true;
      this._isPanning = true;
      this._setCursor("move");
    } else if (this._activePointers.size === 1) {
      // Fall back to single-pointer rotation.
      this._pinchId0 = null;
      this._pinchId1 = null;
      this._lastPinchDistance = 0;
      const it = this._activePointers.values();
      const p0 = it.next().value;
      if (p0) {
        this._lastMouseX = p0.x;
        this._lastMouseY = p0.y;
      }

      // If we just exited a multi-touch gesture (2+ -> 1), suppress touch
      // rotation until the remaining pointer is released.
      if (prevPointerCount >= 2) {
        this._suppressTouchRotateUntilRelease = true;
      }

      this._isDragging = true;
      this._isPanning = false;
      this._setCursor(this._suppressTouchRotateUntilRelease ? "grab" : "grabbing");
    }

    // When last pointer lifts, stop dragging and apply inertia conditions
    if (this._activePointers.size === 0) {
      const now = performance.now();
      const timeSinceMove = now - this._lastMoveTime;

      if (timeSinceMove > 50) {
        this.renderer.stopInertia();
      }
      this._isDragging = false;
      this._isPanning = false;
      this._setCursor("grab");
      this._lastPinchDistance = 0;
      this._pinchId0 = null;
      this._pinchId1 = null;
      this._suppressTouchRotateUntilRelease = false;
    }

    this.requestRender();
    e.preventDefault();
  }

  // Fallback mouse/touch handlers (used only if Pointer Events are not available)


  _getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
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
