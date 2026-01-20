/**
 * Main loop and scheduling controller.
 *
 * Responsibilities:
 * - Prevent overlapping GPU steps (serialize step() calls).
 * - Run play mode ticks at a target cadence derived from UI speed.
 * - Drive rendering via invalidation (render only when needed).
 * - Implement frame pacing to keep the UI responsive on mobile.
 *
 * The loop controller intentionally does not own UI concerns (icons, panels). Instead,
 * those are communicated via hooks.
 */

import { error } from "../util/log.js";
import { LOG_MSG } from "../util/messages.js";

/**
 * @typedef {Object} LoopHooks
 * @property {() => number} getSpeedDelayMs
 * @property {() => boolean} isInteracting
 * @property {(ts:number) => boolean} updateScreenShow
 * @property {() => boolean} updateInertia
 * @property {(isPlaying:boolean) => void} onPlayStateChanged
 * @property {(args:{ syncStats:boolean, changed:boolean }) => { statsFresh:boolean, population:number }} onAfterStep
 * @property {(res:{ generation:number, population:number }) => void} onPopulationReadback
 * @property {() => boolean} [getAutoStopEnabled]
 */

// iOS/Android devices tend to have coarse pointers. We use this to pick frame pacing.
const IS_COARSE_POINTER = (() => {
  try {
    return !!(
      window.matchMedia && window.matchMedia("(pointer: coarse)").matches
    );
  } catch (_) {
    return false;
  }
})();

// Frame pacing defaults.
// - On coarse-pointer devices, cap rendering to keep main-thread work predictable.
// - When the lantern effect or screen show is enabled, keep coarse-pointer devices capped
//   to reduce GPU load/battery usage while still looking smooth.
// - On fine-pointer devices (typical desktops/laptops), allow up to 60 FPS for lantern and
//   screen show animation, so capable devices can render at display refresh.
// - Pointer interaction (drag/pan) should feel immediate, so we bypass the cap while interacting.
const COARSE_POINTER_MAX_FPS = 30;
const LANTERN_MAX_FPS_FINE = 60;
const LANTERN_MAX_FPS_COARSE = 30;

// Screen show camera animation: 60 FPS on fine-pointer devices, capped on coarse-pointer devices.
const SCREENSHOW_MAX_FPS_FINE = 60;
const SCREENSHOW_MAX_FPS_COARSE = 30;

export class LoopController {
  /**
   * @param {{ renderer: any, hooks: LoopHooks }} args
   */
  constructor({ renderer, hooks }) {
    this.renderer = renderer;
    this.hooks = hooks;

    this.isDestroyed = false;

    // Visibility/backgrounding suspension.
    // When suspended, the loop stops scheduling play ticks and does not drive rendering.
    // This reduces battery usage and lowers the risk of WebGPU device loss on mobile browsers.
    this.isSuspended = false;
    // If invalidations occur while suspended, we remember that a render is needed so
    // the first visible frame after resuming is up-to-date.
    this._renderDirtyWhileSuspended = false;

    // Simulation step serialization.
    this.stepQueue = Promise.resolve();

    // Play mode state.
    this.isPlaying = false;
    this.playTimer = null;
    this.playSessionId = 0;
    this.playTickInProgress = false;

    // Render scheduling.
    this.renderRafId = 0;
    this.renderTimerId = 0;
    this.renderRequested = true; // render once after init
    this.lastRenderTimeMs = 0;

    // Resize handling.
    this.lastResizeEventMs = 0;
    this.appResizePending = true;

    // Bind once.
    this._onFrameBound = (ts) => this._onFrame(ts);

    // Last completed step info (used by play tick for auto-stop decisions).
    this._lastStepInfo = { statsFresh: false, population: 0, changed: true };
  }

  /**
   * Treat a resize/orientation change as a render trigger.
   */
  notifyResizeEvent() {
    if (this.isDestroyed) return;
    this.lastResizeEventMs = performance.now();
    this.appResizePending = true;
    this.requestRender(true);
  }

  /**
   * Request a render. Uses invalidation to avoid rendering when idle.
   *
   * @param {boolean} [immediate]
   */
  requestRender(immediate = false) {
    if (this.isDestroyed || !this.renderer) return;
    this.renderRequested = true;

    if (this.isSuspended) {
      // Do not schedule any callbacks while backgrounded.
      // Keep a single "dirty" bit so we can render promptly on resume.
      this._renderDirtyWhileSuspended = true;
      if (immediate && this.renderTimerId) {
        clearTimeout(this.renderTimerId);
        this.renderTimerId = 0;
      }
      return;
    }

    if (immediate && this.renderTimerId) {
      clearTimeout(this.renderTimerId);
      this.renderTimerId = 0;
    }

    if (this.renderRafId) return;
    if (this.renderTimerId && !immediate) return;

    this.renderRafId = requestAnimationFrame(this._onFrameBound);
  }

  /**
   * Suspend or resume the loop controller.
   *
   * Suspension is used for tab backgrounding / app switching:
   * - Stop play ticks (no further simulation steps are queued).
   * - Stop animation-driven rendering (lantern/screen show do not run in background).
   *
   * @param {boolean} suspended
   */
  setSuspended(suspended) {
    if (this.isDestroyed) return;
    const next = !!suspended;
    if (next === this.isSuspended) return;

    this.isSuspended = next;

    if (this.isSuspended) {
      // Cancel any scheduled renders immediately.
      if (this.renderTimerId) {
        clearTimeout(this.renderTimerId);
        this.renderTimerId = 0;
      }
      if (this.renderRafId) {
        cancelAnimationFrame(this.renderRafId);
        this.renderRafId = 0;
      }

      // Stop scheduling play ticks while backgrounded.
      //
      // Important: we intentionally DO NOT change this.isPlaying here.
      // Backgrounding is treated as a temporary "freeze" rather than a user-initiated pause.
      // This preserves Screen show pass state so it can resume exactly where it left off.
      if (this.playTimer) {
        clearTimeout(this.playTimer);
        this.playTimer = null;
      }
      return;
    }

    // On resume, render promptly if anything changed while we were suspended.
    if (this._renderDirtyWhileSuspended) {
      this._renderDirtyWhileSuspended = false;
      this.requestRender(true);
    }

    // If we were playing before suspension, resume ticking immediately.
    if (this.isPlaying && !this.playTickInProgress && !this.playTimer) {
      const sessionId = this.playSessionId;
      this.playTimer = setTimeout(() => this._playTick(sessionId), 0);
    }
  }

  /**
   * Stop play mode and invalidate any scheduled ticks.
   * Note: This cannot cancel an in-flight GPU step; it prevents the next tick.
   */
  stopPlaying() {
    // Invalidate any pending tick callbacks.
    this.playSessionId++;

    if (this.playTimer) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }

    if (!this.isPlaying) return;

    this.isPlaying = false;
    try {
      this.hooks.onPlayStateChanged(false);
    } catch (_) {
      // ignore
    }

    this.requestRender(true);
  }

  /**
   * Tear down scheduled work owned by the loop controller.
   *
   * This cannot cancel an in-flight GPU step, but it prevents future ticks/renders
   * and detaches the renderer reference so callbacks become no-ops.
   */
  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    try {
      this.stopPlaying();
    } catch (_) {
      // ignore
    }

    if (this.playTimer) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }

    if (this.renderTimerId) {
      clearTimeout(this.renderTimerId);
      this.renderTimerId = 0;
    }

    if (this.renderRafId) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = 0;
    }

    // Best-effort: allow the queue to drain without touching the renderer.
    this.renderer = null;
    this.hooks = null;
  }

  /**
   * If a tick is currently waiting on a timer, reschedule it using the current
   * speed delay. Useful when the user changes the speed slider during play.
   */
  rescheduleNextTick() {
    if (!this.isPlaying) return;
    if (this.playTickInProgress) return;
    if (this.isSuspended) return;

    if (this.playTimer) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    const sessionId = this.playSessionId;
    this.playTimer = setTimeout(() => this._playTick(sessionId), this.hooks.getSpeedDelayMs());
  }

  /**
   * Start play mode (if not already playing).
   */
  startPlaying() {
    if (this.isDestroyed || !this.renderer) return;
    if (this.isSuspended) return;
    if (this.isPlaying) return;

    // Any previous play session is obsolete.
    this.playSessionId++;

    this.isPlaying = true;
    try {
      this.hooks.onPlayStateChanged(true);
    } catch (_) {
      // ignore
    }

    this.requestRender(true);

    // Schedule first tick.
    const id = this.playSessionId;
    this.playTimer = setTimeout(() => this._playTick(id), 0);
  }

  /**
   * @returns {Promise<void>}
   */
  async waitForIdle() {
    try {
      await this.stepQueue;
    } catch (_) {
      // Ignore errors from prior steps; the UI can still recover.
    }
  }

  /**
   * Queue exactly one simulation step, ensuring steps never overlap.
   * Returns the renderer's "changed" value for that step.
   *
   * @param {boolean} [syncStats]
   * @returns {Promise<boolean>}
   */
  queueStep(syncStats = true) {
    if (this.isDestroyed || !this.renderer) return Promise.resolve(false);
    if (this.isSuspended) return Promise.resolve(false);
    const p = this.stepQueue.then(async () => {
      const changed = await this.renderer.step({ syncStats, pace: true });

      let statsFresh = false;
      let population = 0;
      try {
        const res = this.hooks.onAfterStep({ syncStats, changed });
        statsFresh = !!res.statsFresh;
        population = res.population;
      } catch (_) {
        // ignore
      }

      this._lastStepInfo = { statsFresh, population, changed };

      this.requestRender();

      // In fast-play mode (syncStats=false), refresh population periodically without stalling steps.
      if (!syncStats && typeof this.renderer.requestPopulationReadback === "function") {
        this.renderer
          .requestPopulationReadback()
          .then((r) => {
            if (!r) return;
            try {
              this.hooks.onPopulationReadback(r);
            } catch (_) {
              // ignore
            }
          })
          .catch(() => {});
      }

      return changed;
    });

    // Keep the queue alive even if a step fails.
    this.stepQueue = p.catch(() => {});
    return p;
  }

  /**
   * One tick of play mode: run one step, then schedule the next tick.
   *
   * @param {number} sessionId
   */
  async _playTick(sessionId) {
    if (this.isDestroyed || !this.renderer) return;
    if (this.isSuspended) return;
    if (!this.isPlaying || sessionId !== this.playSessionId) return;
    if (this.playTickInProgress) return; // extra safety against re-entry

    this.playTickInProgress = true;
    const t0 = performance.now();

    let changed = true;

    try {
      const speedDelayMs = this.hooks.getSpeedDelayMs();
      const syncStats = speedDelayMs >= 200;
      changed = await this.queueStep(syncStats);
    } catch (e) {
      // Step errors are fatal for the current run session. Stop play mode and
      // let the app decide how to surface the failure (toast/overlay/etc.).
      error(LOG_MSG.STEP_FAILED, e);
      if (this.hooks && typeof this.hooks.onStepError === "function") {
        try {
          this.hooks.onStepError(e);
        } catch (_) {
          // ignore
        }
      }
      this.stopPlaying();
      this.playTickInProgress = false;
      return;
    } finally {
      this.playTickInProgress = false;
    }

    if (!this.isPlaying || sessionId !== this.playSessionId) return;

    // Auto-stop if population is zero or scene is static (only when stats for this generation are fresh).
    const autoStopEnabled =
      typeof this.hooks.getAutoStopEnabled === "function"
        ? !!this.hooks.getAutoStopEnabled()
        : true;

    const { statsFresh, population } = this._lastStepInfo;
    // Auto-stop policy:
    // - Always stop when the grid becomes empty (population == 0).
    // - Optionally stop when the configuration becomes stable (changed == false).
    if (statsFresh && population === 0) {
      this.stopPlaying();
      return;
    }
    if (autoStopEnabled && statsFresh && !changed) {
      this.stopPlaying();
      return;
    }

    const elapsed = performance.now() - t0;
    const delay = Math.max(0, this.hooks.getSpeedDelayMs() - elapsed);

    // If the page backgrounded during this tick, do not schedule the next one.
    if (this.isSuspended) return;

    this.playTimer = setTimeout(() => this._playTick(sessionId), delay);
  }

  /**
   * Rendering callback.
   * @param {number} ts
   */
  _onFrame(ts) {
    this.renderRafId = 0;
    if (!this.renderer) return;
    if (this.isSuspended) return;

    // Treat resize events as a rendering trigger; we only reconfigure the swapchain when we are
    // about to render, and we cap the cadence during continuous resizing to avoid flicker.
    const resizingActive = !!this.lastResizeEventMs && ts - this.lastResizeEventMs < 250;
    let resized = false;

    const screenShowAnimating = (() => {
      try {
        return !!this.hooks.updateScreenShow(ts);
      } catch (_) {
        return false;
      }
    })();

    const inertiaActive = (() => {
      try {
        return !!this.hooks.updateInertia();
      } catch (_) {
        return false;
      }
    })();

    const lanternAnimating = !!(
      this.renderer && this.renderer.lanternEnabled > 0.5
    );

    const interacting = (() => {
      try {
        return !!this.hooks.isInteracting();
      } catch (_) {
        return false;
      }
    })();

    const animating = lanternAnimating || screenShowAnimating;

    let targetFps = 0;
    if (animating) {
      targetFps = IS_COARSE_POINTER
        ? Math.min(LANTERN_MAX_FPS_COARSE, SCREENSHOW_MAX_FPS_COARSE)
        : Math.min(LANTERN_MAX_FPS_FINE, SCREENSHOW_MAX_FPS_FINE);
    } else if (resizingActive || this.appResizePending) {
      targetFps = IS_COARSE_POINTER ? 20 : 30;
    } else if (IS_COARSE_POINTER) {
      targetFps = COARSE_POINTER_MAX_FPS;
    }

    const minIntervalMs = targetFps ? 1000 / targetFps : 0;
    const canRender =
      interacting ||
      !minIntervalMs ||
      !this.lastRenderTimeMs ||
      ts - this.lastRenderTimeMs >= minIntervalMs;

    const needsRender =
      this.appResizePending ||
      resizingActive ||
      inertiaActive ||
      this.renderRequested ||
      animating;

    if (needsRender && canRender) {
      if (this.appResizePending || resizingActive) {
        try {
          resized = !!this.renderer.resize();
        } catch (_) {
          resized = false;
        }
        this.appResizePending = false;
      }

      this.renderer.render();
      this.lastRenderTimeMs = ts;
      this.renderRequested = false;
    }

    if (
      inertiaActive ||
      this.renderRequested ||
      this.appResizePending ||
      resizingActive ||
      resized ||
      animating
    ) {
      if (!interacting && minIntervalMs) {
        const dueMs = this.lastRenderTimeMs ? this.lastRenderTimeMs + minIntervalMs : ts;
        const delayMs = Math.max(0, dueMs - ts);

        this.renderTimerId = setTimeout(() => {
          this.renderTimerId = 0;
          if (!this.renderRafId) {
            this.renderRafId = requestAnimationFrame(this._onFrameBound);
          }
        }, delayMs);
      } else {
        this.renderRafId = requestAnimationFrame(this._onFrameBound);
      }
    }
  }
}
