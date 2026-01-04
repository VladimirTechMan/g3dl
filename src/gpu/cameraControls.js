import {
  quatFromYawPitch,
  quatMultiply,
  quatNormalize,
  quatToMat4,
  mat4ToQuat,
} from "../util/math3d.js";

/**
 * Camera control helpers for WebGPURenderer.
 *
 * The renderer's public API exposes a small set of imperative camera methods
 * (rotate/pan/zoom, inertia, overrides). This module keeps the implementation
 * out of the renderer facade, while retaining the same behavior.
 */

/**
 * Initialize camera scratch storage on the renderer instance (idempotent).
 *
 * @param {any} r
 */
export function ensureCameraScratch(r) {
  if (r._tmpQuat0 && r._tmpQuat1 && r._tmpQuatX && r._tmpQuatY) return;
  r._tmpQuat0 = [0, 0, 0, 1];
  r._tmpQuat1 = [0, 0, 0, 1];
  r._tmpQuatX = [0, 0, 0, 1];
  r._tmpQuatY = [0, 0, 0, 1];
}

/**
 * Update r.cameraMatrix from r.cameraQuat.
 * @param {any} r
 */
export function syncCameraMatrix(r) {
  quatToMat4(r.cameraMatrix, r.cameraQuat);
}

/**
 * Set camera quaternion from yaw/pitch Euler angles (Y then X).
 * @param {any} r
 * @param {number} yaw
 * @param {number} pitch
 */
export function setQuatFromEuler(r, yaw, pitch) {
  quatFromYawPitch(r.cameraQuat, yaw, pitch);
}

/**
 * Apply a rotation delta (dx/dy are pointer deltas in CSS pixels).
 * Stores velocity for inertia.
 * @param {any} r
 * @param {number} dx
 * @param {number} dy
 */
export function rotate(r, dx, dy) {
  r.rotationVelocityX = dx;
  r.rotationVelocityY = dy;
  applyRotation(r, dx, dy);
}

/**
 * Internal rotation implementation (arcball-ish):
 * - yaw about world up (Y)
 * - pitch about camera local right (X)
 *
 * @param {any} r
 * @param {number} dx
 * @param {number} dy
 */
export function applyRotation(r, dx, dy) {
  ensureCameraScratch(r);

  const sensitivity = 0.01;
  const yAngle = -dx * sensitivity;
  const xAngle = -dy * sensitivity;

  // qY = rotation about world Y
  const qY = r._tmpQuatY;
  qY[0] = 0;
  qY[1] = Math.sin(yAngle / 2);
  qY[2] = 0;
  qY[3] = Math.cos(yAngle / 2);

  // qX = rotation about local X
  const qX = r._tmpQuatX;
  qX[0] = Math.sin(xAngle / 2);
  qX[1] = 0;
  qX[2] = 0;
  qX[3] = Math.cos(xAngle / 2);

  // newQuat = qY * currentQuat * qX
  quatMultiply(r._tmpQuat0, qY, r.cameraQuat);
  quatMultiply(r._tmpQuat1, r._tmpQuat0, qX);

  // Write back to cameraQuat in-place to avoid changing references.
  r.cameraQuat[0] = r._tmpQuat1[0];
  r.cameraQuat[1] = r._tmpQuat1[1];
  r.cameraQuat[2] = r._tmpQuat1[2];
  r.cameraQuat[3] = r._tmpQuat1[3];

  quatNormalize(r.cameraQuat);
  syncCameraMatrix(r);
}

/**
 * Apply a pan delta (dx/dy are pointer deltas in CSS pixels).
 * Stores velocity for inertia.
 * @param {any} r
 * @param {number} dx
 * @param {number} dy
 */
export function pan(r, dx, dy) {
  r.panVelocityX = dx;
  r.panVelocityY = dy;
  applyPan(r, dx, dy);
}

/**
 * Internal pan implementation.
 * @param {any} r
 * @param {number} dx
 * @param {number} dy
 */
export function applyPan(r, dx, dy) {
  const s = 0.08 * r.cameraDistance;
  r.panX -= dx * s;
  r.panY += dy * s;
}

/**
 * Call every frame to apply inertia.
 * @param {any} r
 * @returns {boolean} whether the camera changed
 */
export function updateInertia(r) {
  let needsUpdate = false;

  if (Math.abs(r.rotationVelocityX) > r.minVelocity || Math.abs(r.rotationVelocityY) > r.minVelocity) {
    applyRotation(r, r.rotationVelocityX, r.rotationVelocityY);
    r.rotationVelocityX *= r.inertiaDecay;
    r.rotationVelocityY *= r.inertiaDecay;
    needsUpdate = true;
  } else {
    r.rotationVelocityX = 0;
    r.rotationVelocityY = 0;
  }

  if (Math.abs(r.panVelocityX) > r.minVelocity || Math.abs(r.panVelocityY) > r.minVelocity) {
    applyPan(r, r.panVelocityX, r.panVelocityY);
    r.panVelocityX *= r.inertiaDecay;
    r.panVelocityY *= r.inertiaDecay;
    needsUpdate = true;
  } else {
    r.panVelocityX = 0;
    r.panVelocityY = 0;
  }

  return needsUpdate;
}

/**
 * Stop all inertia.
 * @param {any} r
 */
export function stopInertia(r) {
  r.rotationVelocityX = 0;
  r.rotationVelocityY = 0;
  r.panVelocityX = 0;
  r.panVelocityY = 0;
}

/**
 * Zoom camera by wheel/pinch delta.
 * @param {any} r
 * @param {number} d
 */
export function zoomCamera(r, d) {
  r.cameraDistance *= 1 + d * 0.001;
  r.cameraDistance = Math.max(0.5, Math.min(5, r.cameraDistance));
}

/**
 * Reset pan to the origin and stop inertia.
 * @param {any} r
 */
export function resetPan(r) {
  r.panX = 0;
  r.panY = 0;
  stopInertia(r);
}

/**
 * Reset view to the initial orientation and distance.
 * @param {any} r
 */
export function resetView(r) {
  setQuatFromEuler(r, 0.7, -0.5);
  syncCameraMatrix(r);
  r.cameraDistance = 1.8;
  r.panX = 0;
  r.panY = 0;
  stopInertia(r);
}

/**
 * Enable an explicit camera override (used by Screen show).
 * @param {any} r
 * @param {number[]} eye
 * @param {number[]} target
 * @param {number[]} [up]
 */
export function setCameraOverride(r, eye, target, up = [0, 1, 0]) {
  r.cameraOverrideEnabled = true;
  r._overrideEye[0] = eye[0];
  r._overrideEye[1] = eye[1];
  r._overrideEye[2] = eye[2];
  r._overrideTarget[0] = target[0];
  r._overrideTarget[1] = target[1];
  r._overrideTarget[2] = target[2];
  r._overrideUp[0] = up[0];
  r._overrideUp[1] = up[1];
  r._overrideUp[2] = up[2];
}

/**
 * Disable the camera override.
 * @param {any} r
 */
export function clearCameraOverride(r) {
  r.cameraOverrideEnabled = false;
}

/**
 * Commit the current override camera pose into the user trackball camera state.
 *
 * @param {any} r
 */
export function commitCameraOverrideToUser(r) {
  if (!r.cameraOverrideEnabled) return;

  const ex = r._overrideEye[0],
    ey = r._overrideEye[1],
    ez = r._overrideEye[2];
  const tx = r._overrideTarget[0],
    ty = r._overrideTarget[1],
    tz = r._overrideTarget[2];
  const upx0 = r._overrideUp[0],
    upy0 = r._overrideUp[1],
    upz0 = r._overrideUp[2];

  // Forward points from target to eye.
  let fx = ex - tx,
    fy = ey - ty,
    fz = ez - tz;
  let fl = Math.max(1e-6, Math.hypot(fx, fy, fz));
  fx /= fl;
  fy /= fl;
  fz /= fl;

  // Right = up x forward
  let rx = upy0 * fz - upz0 * fy;
  let ry = upz0 * fx - upx0 * fz;
  let rz = upx0 * fy - upy0 * fx;
  let rl = Math.max(1e-6, Math.hypot(rx, ry, rz));
  rx /= rl;
  ry /= rl;
  rz /= rl;

  // Orthonormal up = forward x right
  let ux = fy * rz - fz * ry;
  let uy = fz * rx - fx * rz;
  let uz = fx * ry - fy * rx;
  let ul = Math.max(1e-6, Math.hypot(ux, uy, uz));
  ux /= ul;
  uy /= ul;
  uz /= ul;

  // Trackball distance along forward axis.
  let distWorld = ex * fx + ey * fy + ez * fz;
  if (!isFinite(distWorld) || distWorld < 1e-3) {
    distWorld = fl;
  }

  // Pan is the eye projected into the view plane.
  const px = ex - fx * distWorld;
  const py = ey - fy * distWorld;
  const pz = ez - fz * distWorld;

  // Populate camera basis (columns) in world space.
  const cm = r.cameraMatrix;
  cm[0] = rx;
  cm[1] = ry;
  cm[2] = rz;
  cm[3] = 0;
  cm[4] = ux;
  cm[5] = uy;
  cm[6] = uz;
  cm[7] = 0;
  cm[8] = fx;
  cm[9] = fy;
  cm[10] = fz;
  cm[11] = 0;
  cm[12] = 0;
  cm[13] = 0;
  cm[14] = 0;
  cm[15] = 1;

  // Convert rotation matrix to quaternion (keeps future rotations stable).
  mat4ToQuat(cm, r.cameraQuat);
  quatNormalize(r.cameraQuat);

  // Decompose pan into the view plane basis.
  r.panX = px * rx + py * ry + pz * rz;
  r.panY = px * ux + py * uy + pz * uz;

  // Convert world distance to the app's dimensionless distance parameter.
  const gs = Math.max(1e-6, r.gridSize);
  const cd = distWorld / gs;
  r.cameraDistance = Math.max(0.5, Math.min(5.0, cd));
  stopInertia(r);
}
