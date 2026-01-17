/**
 * Uniform buffer lifecycle helpers.
 */

/**
 * Allocate the main uniform buffer used by the cell render pipeline.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 */
export function _createUniformBuffer(r) {
  r.uniformBuffer = r._createBuffer("uniformBuffer", {
    // G3DL_LAYOUT.UNIFORMS.DATA_BYTES is the active region (currently 288 bytes),
    // but we keep extra room to allow future expansion without reallocating.
    size: 512,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}
