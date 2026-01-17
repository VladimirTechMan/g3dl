import { G3DL_LAYOUT } from "../dataLayout.js";
import { G3DL_SHADERS } from "../shaders.js";
import { _rebuildGridProjectionInstances as rebuildGridProjectionInstancesImpl } from "../resources/geometry.js";

/**
 * Render pipeline factory functions.
 *
 * As with the compute pipeline module, these functions keep the renderer's
 * public API stable by mutating fields on the renderer instance.
 */

/**
 * Create (or reuse) the main cell rendering pipeline.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPURenderPipeline>}
 */
export async function createCellsRenderPipeline(r) {
  if (r.renderPipeline) return r.renderPipeline;
  const code = G3DL_SHADERS.render();
  const mod = r._getShaderModule(code);
  r.renderPipeline = await r._createRenderPipeline({
    layout: "auto",
    vertex: {
      module: mod,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        },
      ],
    },
    fragment: {
      module: mod,
      entryPoint: "fs",
      targets: [{ format: r.format }],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });
  return r.renderPipeline;
}

/**
 * Create (or reuse) the grid projection pipeline.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPURenderPipeline>}
 */
export async function _createGridProjectionPipeline(r) {
  if (r.gridProjPipeline) return r.gridProjPipeline;

  const code = G3DL_SHADERS.gridProjection();
  const mod = r._getShaderModule(code);

  r.gridProjPipeline = await r._createRenderPipeline({
    layout: "auto",
    vertex: {
      module: mod,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 48,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: mod,
      entryPoint: "fs",
      targets: [
        {
          format: r.format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "back",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });

  // Allocate instance buffer for up to 6 faces.
  r.gridProjInstanceCount = 6;
  if (!r.gridProjInstanceBuffer) {
    r.gridProjInstanceBuffer = r._createBuffer("gridProjInstanceBuffer", {
      size: r.gridProjMaxInstanceCount * 48,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
  }
  // Face instances depend on gridSize/cellSize.
  rebuildGridProjectionInstancesImpl(r);
  return r.gridProjPipeline;
}

/**
 * Create (or reuse) the background pipeline (full-screen gradient).
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPURenderPipeline>}
 */
export async function _createBackgroundPipeline(r) {
  if (r.bgPipeline) return r.bgPipeline;
  const code = G3DL_SHADERS.background();
  const mod = r._getShaderModule(code);
  r.bgPipeline = await r._createRenderPipeline({
    layout: "auto",
    vertex: { module: mod, entryPoint: "vs" },
    fragment: {
      module: mod,
      entryPoint: "fs",
      targets: [{ format: r.format }],
    },
    primitive: { topology: "triangle-list" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });

  // Background uniform buffer is part of the background feature set; allocate here.
  if (!r.bgUniformBuffer) {
    r.bgUniformBuffer = r._createBuffer("bgUniformBuffer", {
      size: G3DL_LAYOUT.BG_UNIFORMS.DATA_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  return r.bgPipeline;
}
