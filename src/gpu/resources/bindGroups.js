/**
 * Bind group rebuilding.
 *
 * This function intentionally mutates the renderer instance by writing:
 *  - bgBindGroup, cellBindGroup
 *  - computeBindGroups[], extractBindGroups[], initBindGroups[]
 *  - drawArgsBindGroup
 *  - optional gridProjBindGroup, aabbBindGroup, aabbArgsBindGroup
 */
export function rebuildBindGroups(r) {
  if (!r.device) throw new Error("WebGPU device not initialized.");

  // Background bind group (constant binding)
  r.bgBindGroup = r.device.createBindGroup({
    layout: r.bgPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: r.bgUniformBuffer } }],
  });

  // Render bind group (uniform + living cell list)
  r.cellBindGroup = r.device.createBindGroup({
    layout: r.renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.uniformBuffer } },
      { binding: 1, resource: { buffer: r.livingCellsBuffer } },
    ],
  });

  // AABB bind groups (optional; used for Screensaver camera targeting)
  if (
    r.aabbPipeline &&
    r.aabbArgsPipeline &&
    r.aabbDispatchArgsBuffer &&
    r.aabbBuffer &&
    r.livingCellsBuffer &&
    r.atomicCounterBuffer
  ) {
    r.aabbBindGroup = r.device.createBindGroup({
      layout: r.aabbPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: r.atomicCounterBuffer } },
        { binding: 1, resource: { buffer: r.livingCellsBuffer } },
        { binding: 2, resource: { buffer: r.aabbBuffer } },
      ],
    });

    r.aabbArgsBindGroup = r.device.createBindGroup({
      layout: r.aabbArgsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: r.atomicCounterBuffer } },
        { binding: 1, resource: { buffer: r.aabbDispatchArgsBuffer } },
      ],
    });
  } else {
    r.aabbBindGroup = null;
    r.aabbArgsBindGroup = null;
  }

  // Grid projection bind group (uniform only)
  if (r.gridProjPipeline) {
    r.gridProjBindGroup = r.device.createBindGroup({
      layout: r.gridProjPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: r.uniformBuffer } }],
    });
  } else {
    r.gridProjBindGroup = null;
  }

  // Compute bind groups (double-buffered state)
  r.computeBindGroups[0] = r.device.createBindGroup({
    layout: r.computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.computeParamsBuffer } },
      { binding: 1, resource: { buffer: r.gridBuffers[0] } },
      { binding: 2, resource: { buffer: r.gridBuffers[1] } },
      { binding: 3, resource: { buffer: r.changeCounterBuffer } },
    ],
  });

  r.computeBindGroups[1] = r.device.createBindGroup({
    layout: r.computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.computeParamsBuffer } },
      { binding: 1, resource: { buffer: r.gridBuffers[1] } },
      { binding: 2, resource: { buffer: r.gridBuffers[0] } },
      { binding: 3, resource: { buffer: r.changeCounterBuffer } },
    ],
  });

  // Extract bind groups (read current grid, write living list + counter)
  r.extractBindGroups[0] = r.device.createBindGroup({
    layout: r.extractPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.extractParamsBuffer } },
      { binding: 1, resource: { buffer: r.gridBuffers[0] } },
      { binding: 2, resource: { buffer: r.livingCellsBuffer } },
      { binding: 3, resource: { buffer: r.atomicCounterBuffer } },
    ],
  });

  r.extractBindGroups[1] = r.device.createBindGroup({
    layout: r.extractPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.extractParamsBuffer } },
      { binding: 1, resource: { buffer: r.gridBuffers[1] } },
      { binding: 2, resource: { buffer: r.livingCellsBuffer } },
      { binding: 3, resource: { buffer: r.atomicCounterBuffer } },
    ],
  });

  // Init bind groups (GPU random initialization; write grid buffer)
  r.initBindGroups[0] = r.device.createBindGroup({
    layout: r.initPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.initParamsBuffer } },
      { binding: 1, resource: { buffer: r.gridBuffers[0] } },
    ],
  });

  r.initBindGroups[1] = r.device.createBindGroup({
    layout: r.initPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.initParamsBuffer } },
      { binding: 1, resource: { buffer: r.gridBuffers[1] } },
    ],
  });

  // Draw args bind group (counter -> indirect args buffer)
  r.drawArgsBindGroup = r.device.createBindGroup({
    layout: r.drawArgsPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: r.drawArgsParamsBuffer } },
      { binding: 1, resource: { buffer: r.atomicCounterBuffer } },
      { binding: 2, resource: { buffer: r.indirectArgsBuffer } },
    ],
  });
}
