import { G3DL_LAYOUT } from "../dataLayout.js";
import { mat4LookAt, mat4Perspective } from "../../util/math3d.js";

/**
 * Update per-frame uniforms used by rendering and background shading.
 *
 * The renderer stores matrices and uniform arrays on itself to avoid per-frame allocations.
 * This module contains the logic for populating those arrays in a layout-aware way, keeping
 * WebGPURenderer (the facade) focused on orchestration.
 */

/**
 * Updates the render uniform buffer (camera, colors, lantern parameters, time).
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 */
function updateRenderUniforms(r) {
  const w = r.canvas.width || 1;
  const h = r.canvas.height || 1;
  const asp = w / h;

  // Projection
  mat4Perspective(r._proj, Math.PI / 4, asp, 0.1, 1000);

  // Camera: either user trackball camera (default) or an explicit override (Screen show).
  // `camDir` points from the camera to the target (used for lighting).
  let camDirX = 0.0,
    camDirY = 0.0,
    camDirZ = -1.0;

  if (r.cameraOverrideEnabled) {
    const eyeX = r._overrideEye[0],
      eyeY = r._overrideEye[1],
      eyeZ = r._overrideEye[2];
    const tgtX = r._overrideTarget[0],
      tgtY = r._overrideTarget[1],
      tgtZ = r._overrideTarget[2];
    const upX = r._overrideUp[0],
      upY = r._overrideUp[1],
      upZ = r._overrideUp[2];

    r._eye[0] = eyeX;
    r._eye[1] = eyeY;
    r._eye[2] = eyeZ;
    r._target[0] = tgtX;
    r._target[1] = tgtY;
    r._target[2] = tgtZ;

    // View (explicit)
    mat4LookAt(r._view, eyeX, eyeY, eyeZ, tgtX, tgtY, tgtZ, upX, upY, upZ);

    // Camera direction (normalized, pointing from camera to target)
    const dx = tgtX - eyeX;
    const dy = tgtY - eyeY;
    const dz = tgtZ - eyeZ;
    const invLen = 1.0 / Math.max(1e-6, Math.hypot(dx, dy, dz));
    camDirX = dx * invLen;
    camDirY = dy * invLen;
    camDirZ = dz * invLen;
  } else {
    // Camera basis vectors (columns of cameraMatrix): right, up, forward in world space.
    const cm = r.cameraMatrix;
    const rtX = cm[0],
      rtY = cm[1],
      rtZ = cm[2];
    const upX = cm[4],
      upY = cm[5],
      upZ = cm[6];
    const fwdX = cm[8],
      fwdY = cm[9],
      fwdZ = cm[10];

    const dist = r.gridSize * r.cameraDistance;
    const panX = r.panX;
    const panY = r.panY;

    // Eye and target positions in world space.
    const eyeX = fwdX * dist + rtX * panX + upX * panY;
    const eyeY = fwdY * dist + rtY * panX + upY * panY;
    const eyeZ = fwdZ * dist + rtZ * panX + upZ * panY;

    const tgtX = rtX * panX + upX * panY;
    const tgtY = rtY * panX + upY * panY;
    const tgtZ = rtZ * panX + upZ * panY;

    r._eye[0] = eyeX;
    r._eye[1] = eyeY;
    r._eye[2] = eyeZ;
    r._target[0] = tgtX;
    r._target[1] = tgtY;
    r._target[2] = tgtZ;

    // View
    mat4LookAt(r._view, eyeX, eyeY, eyeZ, tgtX, tgtY, tgtZ, upX, upY, upZ);

    // Camera direction (normalized, pointing from camera to target)
    camDirX = -fwdX;
    camDirY = -fwdY;
    camDirZ = -fwdZ;
  }

  // Render uniform layout is defined in src/gpu/dataLayout.js (G3DL_LAYOUT.UNIFORMS).
  const u = r._renderUniforms;
  const uf = G3DL_LAYOUT.UNIFORMS.F32;

  // Matrices
  u.set(r._proj, uf.PROJECTION);
  u.set(r._view, uf.VIEW);
  u.set(r._model, uf.MODEL);

  // cellColorTop vec4
  u[uf.CELL_COLOR_TOP + 0] = r.cellColorTop[0];
  u[uf.CELL_COLOR_TOP + 1] = r.cellColorTop[1];
  u[uf.CELL_COLOR_TOP + 2] = r.cellColorTop[2];
  u[uf.CELL_COLOR_TOP + 3] = 1.0;

  // cellColorBottom vec4
  u[uf.CELL_COLOR_BOTTOM + 0] = r.cellColorBottom[0];
  u[uf.CELL_COLOR_BOTTOM + 1] = r.cellColorBottom[1];
  u[uf.CELL_COLOR_BOTTOM + 2] = r.cellColorBottom[2];
  u[uf.CELL_COLOR_BOTTOM + 3] = 1.0;

  // cameraDir vec4 (XYZ + padding)
  u[uf.CAMERA_DIR + 0] = camDirX;
  u[uf.CAMERA_DIR + 1] = camDirY;
  u[uf.CAMERA_DIR + 2] = camDirZ;
  u[uf.CAMERA_DIR + 3] = 0.0;

  // gridSize/cellSize + padding to 16-byte boundary
  u[uf.GRID_SIZE] = r.gridSize;
  u[uf.CELL_SIZE] = r.cellSize;
  u[uf.PAD0] = 0.0;
  u[uf.PAD1] = 0.0;

  // lantern + padding
  u[uf.LANTERN_ENABLED] = r.lanternEnabled;
  u[uf.LANTERN_STRENGTH] = r.lanternStrength;
  u[uf.PAD2] = 0.0;
  u[uf.PAD3] = 0.0;

  // time (seconds since renderer creation), padding (_p5.._p7)
  const nowMs =
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  u[uf.TIME] = (nowMs - r._startTimeMs) * 0.001;
  u[uf.PAD4] = 0.0;
  u[uf.PAD5] = 0.0;
  u[uf.PAD6] = 0.0;

  r._queueWriteF32(r.uniformBuffer, 0, u);
}

/**
 * Updates background uniforms controlling the gradient direction and colors.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 */
function updateBackgroundUniforms(r) {
  // Background gradient direction: project the world +Y axis into the camera's screen plane.
  // In camera space, world-up transforms to (view * vec4(0,1,0,0)).xy.
  // With our column-major view matrix, that is (view[4], view[5]).
  const screenUpX = r._view[4];
  const screenUpY = r._view[5];

  // Reuse a fixed buffer to avoid per-frame allocations.
  const bg = r._bgUniforms;
  const bf = G3DL_LAYOUT.BG_UNIFORMS.F32;

  bg[bf.COLOR_TOP + 0] = r.bgColorTop[0];
  bg[bf.COLOR_TOP + 1] = r.bgColorTop[1];
  bg[bf.COLOR_TOP + 2] = r.bgColorTop[2];
  bg[bf.COLOR_TOP + 3] = 1.0;

  bg[bf.COLOR_BOTTOM + 0] = r.bgColorBottom[0];
  bg[bf.COLOR_BOTTOM + 1] = r.bgColorBottom[1];
  bg[bf.COLOR_BOTTOM + 2] = r.bgColorBottom[2];
  bg[bf.COLOR_BOTTOM + 3] = 1.0;

  // upDir is a view-space representation of world +Y (used for gradient orientation).
  bg[bf.UP_DIR + 0] = screenUpX;
  bg[bf.UP_DIR + 1] = screenUpY;
  bg[bf.UP_DIR + 2] = 0.0;
  bg[bf.UP_DIR + 3] = 0.0;

  r._queueWriteF32(r.bgUniformBuffer, 0, bg);
}

/**
 * Convenience: update render uniforms first (camera, time), then background uniforms
 * that depend on the view matrix.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 */
export function updateFrameUniforms(r) {
  updateRenderUniforms(r);
  updateBackgroundUniforms(r);
}
