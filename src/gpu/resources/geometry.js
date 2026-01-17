/**
 * Geometry resource helpers.
 *
 * These functions manage vertex/index data and small geometry-related vertex buffers.
 */

/**
 * Create cube geometry buffers (vertex + index) used to render individual live cells.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 */
export function _createCubeGeometry(r) {
  const v = new Float32Array([
    -0.5, -0.5, 0.5, 0, 0, 1, 0.5, -0.5, 0.5, 0, 0, 1, 0.5, 0.5, 0.5, 0, 0, 1,
    -0.5, 0.5, 0.5, 0, 0, 1, -0.5, -0.5, -0.5, 0, 0, -1, -0.5, 0.5, -0.5, 0,
    0, -1, 0.5, 0.5, -0.5, 0, 0, -1, 0.5, -0.5, -0.5, 0, 0, -1, -0.5, 0.5,
    -0.5, 0, 1, 0, -0.5, 0.5, 0.5, 0, 1, 0, 0.5, 0.5, 0.5, 0, 1, 0, 0.5, 0.5,
    -0.5, 0, 1, 0, -0.5, -0.5, -0.5, 0, -1, 0, 0.5, -0.5, -0.5, 0, -1, 0, 0.5,
    -0.5, 0.5, 0, -1, 0, -0.5, -0.5, 0.5, 0, -1, 0, 0.5, -0.5, -0.5, 1, 0, 0,
    0.5, 0.5, -0.5, 1, 0, 0, 0.5, 0.5, 0.5, 1, 0, 0, 0.5, -0.5, 0.5, 1, 0, 0,
    -0.5, -0.5, -0.5, -1, 0, 0, -0.5, -0.5, 0.5, -1, 0, 0, -0.5, 0.5, 0.5, -1,
    0, 0, -0.5, 0.5, -0.5, -1, 0, 0,
  ]);
  const idx = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12,
    14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
  ]);

  r.cubeVertexBuffer = r._createBuffer("cubeVertexBuffer", {
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  r._queueWriteF32(r.cubeVertexBuffer, 0, v);

  r.cubeIndexBuffer = r._createBuffer("cubeIndexBuffer", {
    size: idx.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  r._queueWrite(r.cubeIndexBuffer, 0, idx);

  r.indexCount = idx.length;
}

/**
 * (Re)build the instance buffer used to render the outer grid projection faces.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 */
export function _rebuildGridProjectionInstances(r) {
  if (!r.gridProjInstanceBuffer || !r.device) return;

  const size = r.gridSize * r.cellSize;
  const half = size * 0.5;
  const eps = r.cellSize * 0.02;

  const d = new Float32Array(6 * 12);
  let o = 0;
  const push = (cx, cy, cz, ux, uy, uz, vx, vy, vz) => {
    d[o + 0] = cx;
    d[o + 1] = cy;
    d[o + 2] = cz;
    d[o + 3] = 0;
    d[o + 4] = ux;
    d[o + 5] = uy;
    d[o + 6] = uz;
    d[o + 7] = 0;
    d[o + 8] = vx;
    d[o + 9] = vy;
    d[o + 10] = vz;
    d[o + 11] = 0;
    o += 12;
  };

  // +X face
  push(half + eps, 0, 0, 0, 0, size, 0, size, 0);
  // -X face
  push(-half - eps, 0, 0, 0, size, 0, 0, 0, size);
  // +Y face
  push(0, half + eps, 0, size, 0, 0, 0, 0, size);
  // -Y face
  push(0, -half - eps, 0, 0, 0, size, size, 0, 0);
  // +Z face
  push(0, 0, half + eps, 0, size, 0, size, 0, 0);
  // -Z face
  push(0, 0, -half - eps, size, 0, 0, 0, size, 0);

  r.gridProjInstanceCount = 6;
  r._queueWriteF32(r.gridProjInstanceBuffer, 0, d);
}
