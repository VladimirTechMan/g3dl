import { G3DL_SHADERS } from "../shaders.js";

/**
 * Compute pipeline factory functions.
 *
 * These functions intentionally mutate the renderer instance by setting
 * `r.*Pipeline` fields. This keeps the public WebGPURenderer API stable while
 * moving shader/pipeline boilerplate out of renderer.js.
 */

/**
 * Create (or reuse) the main simulation compute pipeline.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPUComputePipeline>}
 */
export async function createSimulationPipeline(r) {
  if (r.computePipeline) return r.computePipeline;
  const code = G3DL_SHADERS.simulation({ workgroupSize: r.workgroupSize });
  const mod = r._getShaderModule(code);
  r.computePipeline = await r._createComputePipeline({
    layout: "auto",
    compute: { module: mod, entryPoint: "main" },
  });
  return r.computePipeline;
}

/**
 * Create (or reuse) the living-cell extraction pipeline.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPUComputePipeline>}
 */
export async function _createExtractPipeline(r) {
  if (r.extractPipeline) return r.extractPipeline;
  const code = G3DL_SHADERS.extract({ workgroupSize: r.workgroupSize });
  const mod = r._getShaderModule(code);
  r.extractPipeline = await r._createComputePipeline({
    layout: "auto",
    compute: { module: mod, entryPoint: "main" },
  });
  return r.extractPipeline;
}

/**
 * Create (or reuse) the GPU-side random initialization pipeline.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPUComputePipeline>}
 */
export async function _createInitPipeline(r) {
  if (r.initPipeline) return r.initPipeline;
  const code = G3DL_SHADERS.init({ workgroupSize: r.workgroupSize });
  const mod = r._getShaderModule(code);
  r.initPipeline = await r._createComputePipeline({
    layout: "auto",
    compute: { module: mod, entryPoint: "main" },
  });
  return r.initPipeline;
}

/**
 * Create (or reuse) the draw-args pipeline used to fill the indirect draw buffer.
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<GPUComputePipeline>}
 */
export async function _createDrawArgsPipeline(r) {
  if (r.drawArgsPipeline) return r.drawArgsPipeline;
  const code = G3DL_SHADERS.drawArgs();
  const mod = r._getShaderModule(code);
  r.drawArgsPipeline = await r._createComputePipeline({
    layout: "auto",
    compute: { module: mod, entryPoint: "main" },
  });
  return r.drawArgsPipeline;
}

/**
 * Create (or reuse) AABB pipelines used by Screen show camera targeting.
 *
 * This optional feature is compiled lazily via WebGPURenderer._ensureAabbPipelines().
 *
 * @param {object} r Renderer instance (WebGPURenderer)
 * @returns {Promise<void>}
 */
export async function createAabbPipelines(r) {
  if (r.aabbPipeline && r.aabbArgsPipeline) return;

  const WG = r.aabbWorkgroupSize;

  const aabbCode = G3DL_SHADERS.aabb({ aabbWorkgroupSize: WG });
  const aabbMod = r._getShaderModule(aabbCode);
  r.aabbPipeline = await r._createComputePipeline({
    layout: "auto",
    compute: { module: aabbMod, entryPoint: "main" },
  });

  const argsCode = G3DL_SHADERS.aabbArgs({ aabbWorkgroupSize: WG });
  const argsMod = r._getShaderModule(argsCode);
  r.aabbArgsPipeline = await r._createComputePipeline({
    layout: "auto",
    compute: { module: argsMod, entryPoint: "main" },
  });
}
