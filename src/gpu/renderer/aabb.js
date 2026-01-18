/**
 * Live-cell AABB readback helper.
 *
 * This feature is optional (used by Screen show camera targeting). It is kept in a
 * dedicated module so the core renderer remains easier to audit.
 */

/**
 * Request a best-effort AABB (in cell coordinates) of the current live-cell list.
 *
 * This reads the authoritative live-cell count directly from the GPU-side atomic counter
 * produced by the extract pass, so it remains correct even when CPU stats readback is
 * throttled.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 * @returns {Promise<null|{min:number[],max:number[],count:number}>}
 */
export async function requestLivingCellsAABB(r) {
  if (
    !r.device ||
    !r.aabbDispatchArgsBuffer ||
    !r.aabbBuffer ||
    !r.aabbStagingBuffers ||
    !r.atomicCounterBuffer
  ) {
    return null;
  }

  // Coalesce concurrent requests.
  if (r.aabbReadbackPending && r.aabbReadbackPromise) {
    return await r.aabbReadbackPromise;
  }

  // Lazily compile the pipelines used by this optional feature.
  const ready = await r._ensureAabbPipelines();
  if (!ready || !r.aabbPipeline || !r.aabbArgsPipeline || !r.aabbBindGroup || !r.aabbArgsBindGroup) {
    return null;
  }

  const slot = r.aabbReadbackSlot % r.aabbStagingBuffers.length;
  const staging = r.aabbStagingBuffers[slot];
  r.aabbReadbackSlot = (slot + 1) % r.aabbStagingBuffers.length;

  // Initialize the accumulator: min = 0xFFFFFFFF, max = 0.
  r._writeAabbInitAccumulator();

  const enc = r.device.createCommandEncoder();

  // Pass 1: generate dispatchWorkgroupsIndirect() args from the atomic live-cell counter.
  {
    const pass = enc.beginComputePass();
    pass.setPipeline(r.aabbArgsPipeline);
    pass.setBindGroup(0, r.aabbArgsBindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  // Pass 2: reduce live-cell coordinates into an AABB (indirect dispatch).
  {
    const pass = enc.beginComputePass();
    pass.setPipeline(r.aabbPipeline);
    pass.setBindGroup(0, r.aabbBindGroup);
    pass.dispatchWorkgroupsIndirect(r.aabbDispatchArgsBuffer, 0);
    pass.end();
  }

  // Copy both AABB and the current live-cell count into a staging buffer for readback.
  enc.copyBufferToBuffer(r.aabbBuffer, 0, staging, 0, 32);
  enc.copyBufferToBuffer(r.atomicCounterBuffer, 0, staging, 32, 4);
  r.device.queue.submit([enc.finish()]);

  // Best-effort: ensure unmapped prior to mapping
  try {
    staging.unmap();
  } catch (_) {}

  r.aabbReadbackPending = true;
  r.aabbReadbackPromise = staging
    .mapAsync(GPUMapMode.READ)
    .then(() => {
      const u = new Uint32Array(staging.getMappedRange());
      const minX = u[0],
        minY = u[1],
        minZ = u[2];
      const maxX = u[3],
        maxY = u[4],
        maxZ = u[5];
      const count = u[8] >>> 0; // offset 32 bytes

      staging.unmap();

      r.aabbReadbackPending = false;
      r.aabbReadbackPromise = null;

      if (!count || minX === 0xffffffff) {
        r.lastAabb = null;
        return null;
      }

      const res = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], count };
      r.lastAabb = res;
      return res;
    })
    .catch(() => {
      try {
        staging.unmap();
      } catch (_) {}
      r.aabbReadbackPending = false;
      r.aabbReadbackPromise = null;
      return null;
    });

  return r.aabbReadbackPromise;
}
