/**
 * Lightweight 3D math utilities (column-major matrices, XYZW quaternions).
 *
 * Design goals:
 * - No heap allocations in hot paths (callers provide output arrays).
 * - Small surface area: only operations used by the renderer/camera.
 * - Deterministic floating-point behavior (no platform-specific APIs).
 *
 * Conventions:
 * - Matrices are 4x4, column-major, Float32Array-compatible (length 16).
 * - Quaternions are [x, y, z, w] (length 4).
 */


/**
 * Column-major perspective projection matrix.
 * @param {Float32Array|number[]} out
 * @param {number} fovRadians
 * @param {number} aspect
 * @param {number} near
 * @param {number} far
 * @returns {Float32Array|number[]}
 */
export function mat4Perspective(out, fovRadians, aspect, near, far) {
  const t = 1 / Math.tan(fovRadians / 2);
  // Fill explicitly (faster + avoids allocation from out.fill(0) on some engines).
  out[0] = t / aspect;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;

  out[4] = 0;
  out[5] = t;
  out[6] = 0;
  out[7] = 0;

  out[8] = 0;
  out[9] = 0;
  out[10] = (far + near) / (near - far);
  out[11] = -1;

  out[12] = 0;
  out[13] = 0;
  out[14] = (2 * far * near) / (near - far);
  out[15] = 0;
  return out;
}

/**
 * Column-major look-at view matrix.
 *
 * This matches the previous inline implementation used by the renderer.
 *
 * @param {Float32Array|number[]} out
 * @param {number} ex Eye x
 * @param {number} ey Eye y
 * @param {number} ez Eye z
 * @param {number} tx Target x
 * @param {number} ty Target y
 * @param {number} tz Target z
 * @param {number} ux Up x
 * @param {number} uy Up y
 * @param {number} uz Up z
 * @returns {Float32Array|number[]}
 */
export function mat4LookAt(out, ex, ey, ez, tx, ty, tz, ux, uy, uz) {
  // z axis (camera forward, pointing from target to eye)
  let zx = ex - tx;
  let zy = ey - ty;
  let zz = ez - tz;
  let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
  l = Math.max(1e-6, l);
  zx /= l;
  zy /= l;
  zz /= l;

  // x axis (right) = up x z
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  l = Math.max(1e-6, l);
  xx /= l;
  xy /= l;
  xz /= l;

  // y axis = z x x
  let yx = zy * xz - zz * xy;
  let yy = zz * xx - zx * xz;
  let yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;

  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;

  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;

  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}


/**
 * Writes a yaw (around Y) + pitch (around X) quaternion into `out`.
 * @param {number[]} out
 * @param {number} yaw
 * @param {number} pitch
 * @returns {number[]}
 */
export function quatFromYawPitch(out, yaw, pitch) {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  // qY * qX
  out[0] = cy * sp;
  out[1] = sy * cp;
  out[2] = -sy * sp;
  out[3] = cy * cp;
  return out;
}

/**
 * out = a * b (quaternion multiplication), where quaternions are [x,y,z,w].
 * @param {number[]} out
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function quatMultiply(out, a, b) {
  const ax = a[0],
    ay = a[1],
    az = a[2],
    aw = a[3];
  const bx = b[0],
    by = b[1],
    bz = b[2],
    bw = b[3];

  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * Normalize a quaternion in place.
 * @param {number[]} q
 * @returns {number[]}
 */
export function quatNormalize(q) {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (len > 0) {
    q[0] /= len;
    q[1] /= len;
    q[2] /= len;
    q[3] /= len;
  }
  return q;
}

/**
 * Convert quaternion to a column-major 4x4 rotation matrix.
 * @param {Float32Array|number[]} out
 * @param {number[]} q
 * @returns {Float32Array|number[]}
 */
export function quatToMat4(out, q) {
  const x = q[0],
    y = q[1],
    z = q[2],
    w = q[3];
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;

  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = 0;

  out[4] = xy - wz;
  out[5] = 1 - (xx + zz);
  out[6] = yz + wx;
  out[7] = 0;

  out[8] = xz + wy;
  out[9] = yz - wx;
  out[10] = 1 - (xx + yy);
  out[11] = 0;

  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/**
 * Convert a column-major rotation matrix to a quaternion.
 *
 * The matrix is expected to be orthonormal (rotation only).
 * @param {Float32Array|number[]} m
 * @param {number[]} out
 * @returns {number[]}
 */
export function mat4ToQuat(m, out) {
  const m00 = m[0],
    m01 = m[4],
    m02 = m[8];
  const m10 = m[1],
    m11 = m[5],
    m12 = m[9];
  const m20 = m[2],
    m21 = m[6],
    m22 = m[10];

  const trace = m00 + m11 + m22;
  let x, y, z, w;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2.0;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2.0;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2.0;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2.0;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }

  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}
