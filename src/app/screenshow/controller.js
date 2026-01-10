/**
 * Screen show (camera autopilot) controller.
 *
 * Design goals:
 * - Keep Screen show policy and heuristics isolated from general app orchestration.
 * - Avoid hidden cross-module coupling: state mutations are confined to state.screenshow.*.
 * - Preserve existing behavior (fade timing, pass generation, AABB refresh rate).
 */

const SCREENSHOW_PASS_MIN_MS = 15000;
const SCREENSHOW_PASS_MAX_MS = 20000;
const SCREENSHOW_FADE_MS = readCssTimeMs("--screenshow-fade-ms", 900);

/**
 * Read a CSS time custom property (e.g. "900ms" or "0.9s") and return its value in milliseconds.
 * Falls back to fallbackMs if the property is missing or unparseable.
 *
 * @param {string} varName
 * @param {number} fallbackMs
 * @returns {number}
 */
function readCssTimeMs(varName, fallbackMs) {
  // Computed style is used so values set via external stylesheets are visible.
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  if (!raw) return fallbackMs;

  // Normalize to milliseconds.
  if (raw.endsWith("ms")) {
    const v = Number.parseFloat(raw.slice(0, -2));
    return Number.isFinite(v) ? v : fallbackMs;
  }
  if (raw.endsWith("s")) {
    const v = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(v) ? v * 1000 : fallbackMs;
  }
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallbackMs;
}
const SCREENSHOW_AABB_REQUEST_MIN_INTERVAL_MS = 1200;

/**
 * @typedef {import("../state.js").AppState} AppState
 */

/**
 * Screen show orchestrates camera overrides while the simulation is running.
 * When the simulation is paused, Screen show does not animate the camera and returns navigation control to the user.
 */
export class ScreenShowController {
  /**
   * @param {object} deps
   * @param {AppState} deps.state
   * @param {import("../../gpu/renderer.js").WebGPURenderer} deps.renderer
   * @param {HTMLCanvasElement} deps.canvas
   * @param {(immediate?: boolean) => void} deps.requestRender
   * @param {import("../orbitControls.js").OrbitControls|null} [deps.orbitControls]
   */
  constructor({ state, renderer, canvas, requestRender, orbitControls = null }) {
    this.state = state;
    this.renderer = renderer;
    this.canvas = canvas;
    this.requestRender = requestRender;
    this.orbitControls = orbitControls;
  }

  /**
   * OrbitControls is created after renderer init; attach it when available so Screen show can cancel active gestures
   * when navigation becomes locked.
   *
   * @param {import("../orbitControls.js").OrbitControls|null} orbitControls
   */
  setOrbitControls(orbitControls) {
    this.orbitControls = orbitControls;
  }

  /**
   * Determine whether user camera navigation should be locked.
   *
   * Screen show disables manual navigation only while it is actively running (i.e., while the simulation is playing).
   * When the simulation is paused, navigation remains available even if the Screen show checkbox is enabled.
   *
   * @returns {boolean}
   */
  isNavLocked() {
    return !!(this.state.screenshow.enabled && this.state.sim.isPlaying);
  }

  /**
   * Apply the navigation lock to the canvas and cancel any active gesture if needed.
   */
  updateNavLock() {
    const locked = this.isNavLocked();
    if (locked === this.state.screenshow.navLocked) return;
    this.state.screenshow.navLocked = locked;

    if (!this.canvas) return;

    this.canvas.classList.toggle("nav-disabled", locked);

    // Always clear any inline cursor override so CSS controls cursor state.
    this.canvas.style.cursor = "";

    if (locked && this.orbitControls) {
      // Cancel any in-progress user interaction immediately.
      this.orbitControls.cancelInteraction();
    }
  }

  /**
   * Enable/disable Screen show.
   *
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.state.screenshow.enabled = !!enabled;

    if (this.state.screenshow.enabled) {
      this.renderer.stopInertia();

      // Do not start the camera autopilot until the simulation is running.
      if (this.state.sim.isPlaying) {
        this.startPass(true);
      }
    } else {
      this.stop(true);

      // Leave the camera where it currently is when Screen show is disabled.
      this.state.screenshow.savedCamera = null;
    }

    this.updateNavLock();
  }

  /**
   * Called when play state changes (Run/Pause).
   * Assumes the caller has already updated state.sim.isPlaying.
   *
   * @param {boolean} playing
   */
  onPlayStateChanged(playing) {
    this.updateNavLock();

    // Screen show: when pausing, leave the camera where it currently is, but
    // return manual navigation control to the user.
    if (!playing && this.state.screenshow.enabled) {
      this.renderer.commitCameraOverrideToUser();
      this.renderer.clearCameraOverride();

      this._undimCanvas();
      const ss = this.state.screenshow.state;
      if (ss.pendingStartTimer) {
        clearTimeout(ss.pendingStartTimer);
        ss.pendingStartTimer = null;
      }
      ss.pendingStart = false;
      // Restart with a fresh pass on the next Run.
      ss.pass = null;
    }
  }

  /**
   * Fade-out then teleport to a new pass start, and fade back in.
   *
   * Used when the user presses Run while Screen show is enabled.
   */
  startFromRun() {
    if (!this.state.screenshow.enabled || !this.renderer) return;

    const ss = this.state.screenshow.state;

    // Cancel any pending start from a previous Run.
    if (ss.pendingStartTimer) {
      clearTimeout(ss.pendingStartTimer);
      ss.pendingStartTimer = null;
    }
    ss.pendingStart = true;
    const token = ++ss.pendingStartToken;

    // Ensure we don't reuse a stale pass.
    ss.pass = null;

    // Fade out the current scene first (requirement).
    this._dimCanvas();
    this.requestRender(true);

    ss.pendingStartTimer = setTimeout(() => {
      ss.pendingStartTimer = null;

      // If state changed (paused/disabled) during the fade, do nothing.
      if (!this.state.screenshow.enabled || !this.renderer || !this.state.sim.isPlaying) {
        ss.pendingStart = false;
        this._undimCanvas();
        return;
      }
      if (token !== ss.pendingStartToken) {
        // A newer Run took precedence.
        return;
      }

      // Teleport to a new pass while dimmed, then fade back in.
      this.startPass(true);
      ss.pendingStart = false;
      this._undimCanvas();
      this.requestRender(true);
    }, SCREENSHOW_FADE_MS);
  }

  /**
   * Stop Screen show.
   *
   * @param {boolean} alsoClearOverride When true, commits the override to the user view and clears the override state.
   */
  stop(alsoClearOverride = false) {
    const ss = this.state.screenshow.state;
    ss.pass = null;
    if (ss.pendingStartTimer) {
      clearTimeout(ss.pendingStartTimer);
      ss.pendingStartTimer = null;
    }
    ss.pendingStart = false;
    if (alsoClearOverride) {
      // Leave the view where it is when Screen show is disabled.
      this.renderer.commitCameraOverrideToUser();
      this.renderer.clearCameraOverride();
    }
    this._undimCanvas();
  }

  /**
   * Start a new Screen show camera pass.
   *
   * @param {boolean} immediate If false, the pass fades in; if true it starts instantly.
   */
  startPass(immediate = false) {
    const ss = this.state.screenshow.state;
    const nowMs = (performance && performance.now ? performance.now() : Date.now());

    // Ensure we have a usable fallback focus in case AABB isn't available yet.
    const gs = this.renderer.gridSize;
    const cs = this.renderer.cellSize;
    if (!ss.focusRadius || ss.focusRadius < 1) {
      ss.focusCenter[0] = 0;
      ss.focusCenter[1] = 0;
      ss.focusCenter[2] = 0;
      ss.focusRadius = gs * cs * 0.35;
    }

    // Try to refresh the AABB, but only at low frequency.
    if (nowMs - ss.lastAabbRequestMs >= SCREENSHOW_AABB_REQUEST_MIN_INTERVAL_MS) {
      ss.lastAabbRequestMs = nowMs;
      this.renderer
        .requestLivingCellsAABB()
        .then((aabb) => {
          this._updateFocusFromAABB(aabb);
        })
        .catch(() => {});
    }

    const r = ss.focusRadius;
    const center = ss.focusCenter;

    // Choose a distance that keeps the live cluster comfortably visible.
    // These bounds also serve as the "collision" envelope: we stay outside the cluster radius plus padding.
    const minDist = r + cs * 10.0;
    const maxDist = Math.min(gs * cs * 4.0, r * 12.0 + cs * 40.0);

    // Screen show start-point selection: sample points along a radial line from the *grid box center* (world origin),
    // with a target mix of:
    //   - ~60% inside the cube,
    //   - ~30% near the boundary band,
    //   - ~10% outside,
    // and automatically shift toward outside views when "fly-through" becomes implausible (very dense or very large clusters).
    const totalCells = gs * gs * gs;
    const popForDensity = ss.focusCountValid ? ss.focusCount : this.renderer.population;
    // Note: this is the *live* density used only for screenshow heuristics (do not overwrite the user-configured init density).
    const liveDensity = totalCells ? popForDensity / totalCells : 0.0;
    const cubeHalf = gs * cs * 0.5;

    const flyThroughFactor = screenShowFlyThroughFactor(liveDensity, r, cubeHalf);

    const aabbWorld = cellsAabbToWorldAabb(this.renderer.lastAabb, gs, cs);
    const startEye = pickScreenShowStartEyeWorld(
      center,
      r,
      minDist,
      maxDist,
      gs,
      cs,
      flyThroughFactor,
      aabbWorld,
    );

    // Convert the chosen start position into the pass parameterization (yaw/pitch/dist around the focus center).
    const sdx = startEye[0] - center[0];
    const sdy = startEye[1] - center[1];
    const sdz = startEye[2] - center[2];
    const dist0 = Math.max(1e-6, Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz));
    const yaw0 = Math.atan2(sdx, sdz);
    const pitch0 = Math.asin(clamp(sdy / dist0, -1, 1));

    // End-of-pass parameters: drift gently away from the chosen starting framing.
    const yawDelta = (Math.random() < 0.5 ? -1 : 1) * randRange(0.85, 2.4);
    const pitch1 = clamp(pitch0 + randRange(-0.18, 0.18), -0.62, 0.62);
    const dist1 = clamp(dist0 * randRange(0.9, 1.18), minDist, maxDist);

    const pass = {
      startMs: nowMs,
      durationMs: randRange(SCREENSHOW_PASS_MIN_MS, SCREENSHOW_PASS_MAX_MS),
      yaw0: yaw0,
      yawDelta: yawDelta,
      pitch0: pitch0,
      pitch1: pitch1,
      dist0: dist0,
      dist1: dist1,
      roll0: randRange(-0.14, 0.14),
      roll1: randRange(-0.16, 0.16),
      phase: randRange(0, Math.PI * 2),
      targetPhase: randRange(0, Math.PI * 2),
      state: immediate ? "running" : "fadingIn",
      fadeEndMs: immediate ? 0 : nowMs + SCREENSHOW_FADE_MS,
    };

    ss.pass = pass;

    // Reset smoothing so we don't interpolate across teleports between passes.
    ss.smoothReset = true;

    if (!immediate) {
      this._undimCanvas();
    }
  }

  /**
   * Update the Screen show camera for the current frame.
   *
   * @param {number} ts Timestamp (ms).
   * @returns {boolean} True if the camera changed and a render is needed.
   */
  update(ts) {
    if (!this.state.screenshow.enabled || !this.renderer) {
      return false;
    }

    // Only animate while the simulation is running. When paused/stopped,
    // keep the last camera override (if any) and do not spend cycles animating.
    if (!this.state.sim.isPlaying) {
      return false;
    }

    const ss = this.state.screenshow.state;

    if (!ss.pass) {
      if (ss.pendingStart) {
        return false;
      }
      this.startPass(true);
    }

    const pass = ss.pass;

    const nowMs = ts != null ? ts : (performance && performance.now ? performance.now() : Date.now());
    const tRaw = (nowMs - pass.startMs) / Math.max(1, pass.durationMs);
    if (tRaw >= 1.0) {
      // End the current pass.
      //
      // Important: use the same "fade-out -> teleport -> fade-in" sequence we use when
      // starting Screen show from Run mode (startFromRun()). Starting the next pass
      // immediately (teleport + undim) can expose the next scene for a single frame
      // before the dim-out CSS transition kicks in, which appears as a flash.
      this.startFromRun();
      return true;
    }

    // Fade-in gating: keep the first part of the pass dimmed, then fade in.
    if (pass.state === "fadingIn") {
      if (nowMs >= pass.fadeEndMs) {
        pass.state = "running";
      } else {
        // Keep dimmed during fade-in window.
        this._dimCanvas();
      }
    } else {
      // Ensure not dimmed while running.
      this._undimCanvas();
    }

    const t = clamp(tRaw, 0, 1);
    const s = smoothstep(t);

    // Pass param interpolation.
    const yaw = pass.yaw0 + pass.yawDelta * s;
    const pitch = lerp(pass.pitch0, pass.pitch1, s);
    const dist = lerp(pass.dist0, pass.dist1, s);
    const roll = lerp(pass.roll0, pass.roll1, s);

    // Focus parameters (world space).
    const center = ss.focusCenter;
    const driftAmp = Math.max(this.renderer.cellSize * 2.0, ss.focusRadius * 0.08);

    // Target drift: small oscillation around focus center.
    const driftX = driftAmp * 0.65 * Math.sin(pass.targetPhase + Math.PI * 2 * t * 0.31);
    const driftY = driftAmp * 0.35 * Math.sin(pass.targetPhase + Math.PI * 2 * t * 0.44);
    const driftZ = driftAmp * 0.75 * Math.sin(pass.targetPhase + Math.PI * 2 * t * 0.38);

    const tx = center[0] + driftX;
    const ty = center[1] + driftY;
    const tz = center[2] + driftZ;

    // Direction vector from target to eye.
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);

    const dx = sy * cp;
    const dy = sp;
    const dz = cy * cp;

    const ex = tx + dx * dist;
    const ey = ty + dy * dist;
    const ez = tz + dz * dist;

    // Up vector derived from yaw/pitch + roll.
    // Base up approximated by rotating world-up around view direction.
    const upRoll = roll + 0.15 * Math.sin(pass.phase + Math.PI * 2 * t * 0.23);
    const urc = Math.cos(upRoll), urs = Math.sin(upRoll);
    // Start from world up; apply roll by mixing in a right-vector component.
    // Compute right vector = normalize(cross(up, forward)).
    const fx = -dx, fy = -dy, fz = -dz;
    let rx = 0 * fz - 1 * fy;
    let ry = 1 * fx - 0 * fz;
    let rz = 0 * fy - 0 * fx;
    const rl = Math.max(1e-6, Math.hypot(rx, ry, rz));
    rx /= rl; ry /= rl; rz /= rl;

    const upx = 0 * urc + rx * urs;
    const upy = 1 * urc + ry * urs;
    const upz = 0 * urc + rz * urs;

    // Smooth camera motion to avoid micro-jitter.
    if (!ss.smoothEye || ss.smoothReset) {
      ss.smoothEye = [ex, ey, ez];
      ss.smoothTarget = [tx, ty, tz];
      ss.smoothUp = [upx, upy, upz];
      ss.lastSmoothMs = nowMs;
      ss.smoothReset = false;
    } else {
      const dt = Math.max(0, nowMs - (ss.lastSmoothMs || nowMs));
      ss.lastSmoothMs = nowMs;
      const a = clamp(dt / 250.0, 0.05, 0.25); // smoothing coefficient per frame

      const se = ss.smoothEye;
      const st = ss.smoothTarget;
      const su = ss.smoothUp;

      se[0] = lerp(se[0], ex, a);
      se[1] = lerp(se[1], ey, a);
      se[2] = lerp(se[2], ez, a);

      st[0] = lerp(st[0], tx, a);
      st[1] = lerp(st[1], ty, a);
      st[2] = lerp(st[2], tz, a);

      su[0] = lerp(su[0], upx, a);
      su[1] = lerp(su[1], upy, a);
      su[2] = lerp(su[2], upz, a);

      // Re-normalize up vector after lerp to keep it stable.
      const l = Math.max(1e-6, Math.hypot(su[0], su[1], su[2]));
      su[0] /= l;
      su[1] /= l;
      su[2] /= l;
    }

    this.renderer.setCameraOverride(ss.smoothEye, ss.smoothTarget, ss.smoothUp);
    return true;
  }

  _dimCanvas() {
    if (!this.canvas) return;
    const ss = this.state.screenshow.state;
    if (!ss.dimmed) {
      this.canvas.classList.add("screen-show-dimmed");
      ss.dimmed = true;
    }
  }

  _undimCanvas() {
    if (!this.canvas) return;
    const ss = this.state.screenshow.state;
    if (ss.dimmed) {
      this.canvas.classList.remove("screen-show-dimmed");
      ss.dimmed = false;
    }
  }

  /**
   * Update focus center/radius from a cell-space AABB returned by renderer.requestLivingCellsAABB().
   *
   * @param {{min:number[], max:number[], count?:number}|null} aabb
   */
  _updateFocusFromAABB(aabb) {
    if (!aabb || !aabb.min || !aabb.max) return;

    const gs = this.renderer.gridSize;
    const cs = this.renderer.cellSize;

    const min = aabb.min;
    const max = aabb.max;

    // Center in cell coordinates.
    const cx = 0.5 * (min[0] + max[0]);
    const cy = 0.5 * (min[1] + max[1]);
    const cz = 0.5 * (min[2] + max[2]);

    // Convert to world coordinates: shader centers the grid at (gridSize*0.5).
    const wx = (cx - gs * 0.5) * cs;
    const wy = (cy - gs * 0.5) * cs;
    const wz = (cz - gs * 0.5) * cs;

    // Extent in world coordinates.
    const ex = (max[0] - min[0] + 1) * cs;
    const ey = (max[1] - min[1] + 1) * cs;
    const ez = (max[2] - min[2] + 1) * cs;

    // Conservative radius: make sure at least a couple of cubes are included.
    const r = Math.max(cs * 2.0, 0.55 * Math.max(ex, ey, ez));

    const ss = this.state.screenshow.state;
    ss.focusCenter[0] = wx;
    ss.focusCenter[1] = wy;
    ss.focusCenter[2] = wz;
    ss.focusRadius = r;

    if (typeof aabb.count === "number") {
      ss.focusCount = aabb.count >>> 0;
      ss.focusCountValid = true;
    }
  }
}

/* ---------- Helper functions (screenshow-only policy/heuristics) ---------- */

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

function randRangeCenterBiased(a, b, centerBias = 0.35) {
  const u = Math.random();
  const v = Math.random();
  const tri = 0.5 * (u + v); // triangular distribution, peak at 0.5
  const s = (1.0 - centerBias) * u + centerBias * tri;
  return a + s * (b - a);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function randomUnitVec3() {
  const z = randRange(-1, 1);
  const a = randRange(0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

function cellsAabbToWorldAabb(aabb, gs, cs) {
  if (!aabb || !aabb.min || !aabb.max) return null;
  const min = aabb.min,
    max = aabb.max;
  return {
    min: [
      (min[0] - gs * 0.5) * cs,
      (min[1] - gs * 0.5) * cs,
      (min[2] - gs * 0.5) * cs,
    ],
    max: [
      (max[0] - gs * 0.5) * cs,
      (max[1] - gs * 0.5) * cs,
      (max[2] - gs * 0.5) * cs,
    ],
  };
}


function screenShowFlyThroughFactor(density, focusRadius, cubeHalf) {
  const d = clamp(density, 0, 1);
  const td = clamp((d - 0.12) / (0.25 - 0.12), 0, 1); // density transition
  const densityFactor = 1.0 - smoothstep(td);

  const s = clamp(focusRadius / Math.max(1e-6, cubeHalf), 0, 2);
  const ts = clamp((s - 0.5) / (0.85 - 0.5), 0, 1); // size transition
  const sizeFactor = 1.0 - smoothstep(ts);

  return clamp(Math.min(densityFactor, sizeFactor), 0, 1);
}

function pickScreenShowStartEyeWorld(
  focusCenter,
  focusRadius,
  minDist,
  maxDist,
  gs,
  cs,
  flyThroughFactor,
  aabbWorld,
) {
  const half = gs * cs * 0.5;
  const cubeSphereR = half * 1.7320508075688772; // sqrt(3), bounding sphere radius of the grid cube
  const cubeSphereMax = cubeSphereR * 1.2; // allow up to 20% beyond that sphere

  // Radial range: sample from 5% of the cube sphere radius up to the maximum, with a mild center bias.
  // When fly-through is discouraged (dense scenes / large clusters), shift the minimum radius outward.
  const rMinBase = cubeSphereR * 0.05;
  const f = clamp(flyThroughFactor, 0, 1);
  const rMin = lerp(cubeSphereR * 0.55, rMinBase, f);

  // Avoid starting inside (or too close to) the live cluster itself.
  const avoidRadius = focusRadius + cs * 3.5;
  const aabbPad = cs * 1.25;

  for (let attempt = 0; attempt < 32; attempt++) {
    const dir = randomUnitVec3();

    // Sample along the radius from the grid center with a mild bias toward the interval center.
    const t = randRangeCenterBiased(rMin, cubeSphereMax);
    const px = dir[0] * t;
    const py = dir[1] * t;
    const pz = dir[2] * t;

    // Distance constraints relative to the live cluster focus (keeps cells in view and avoids collisions).
    const dx = px - focusCenter[0];
    const dy = py - focusCenter[1];
    const dz = pz - focusCenter[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dist >= minDist && dist <= maxDist)) continue;
    if (dist < avoidRadius) continue;

    // Coarse no-fly region: avoid starting inside the (expanded) live AABB if it exists.
    if (aabbWorld) {
      const mn = aabbWorld.min,
        mx = aabbWorld.max;
      const insideAabb =
        px >= mn[0] - aabbPad &&
        px <= mx[0] + aabbPad &&
        py >= mn[1] - aabbPad &&
        py <= mx[1] + aabbPad &&
        pz >= mn[2] - aabbPad &&
        pz <= mx[2] + aabbPad;
      if (insideAabb) continue;
    }

    // Mild guard: avoid starting very near the cube center (rare but visually unhelpful in dense scenes).
    if (t < rMinBase * 1.05 && f < 0.35) continue;

    return [px, py, pz];
  }

  // Fallback: a stable outside-ish view on the cube sphere shell.
  const dir = randomUnitVec3();
  const t = cubeSphereR;
  return [dir[0] * t, dir[1] * t, dir[2] * t];
}
