import { updateFrameUniforms as updateFrameUniformsImpl } from "../resources/frameUniforms.js";

/**
 * Render-pass encoding.
 *
 * The main renderer uses a single render pass:
 *  - background full-screen triangle
 *  - optional grid projection overlay
 *  - instanced cubes via drawIndexedIndirect()
 */

/**
 * Encode and submit one frame.
 * @param {import("../renderer.js").WebGPURenderer} r
 */
export function renderFrame(r) {
  // Update frame uniforms (camera + background) once per frame.
  updateFrameUniformsImpl(r);

  const encoder = r.device.createCommandEncoder();
  const textureView = r.context.getCurrentTexture().createView();

  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: textureView,
        loadOp: "clear",
        clearValue: {
          r: r.bgColorBottom[0],
          g: r.bgColorBottom[1],
          b: r.bgColorBottom[2],
          a: 1.0,
        },
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: r.depthTextureView,
      depthLoadOp: "clear",
      depthClearValue: 1.0,
      depthStoreOp: "store",
    },
  });

  pass.setPipeline(r.bgPipeline);
  pass.setBindGroup(0, r.bgBindGroup);
  pass.draw(3);

  // Optional subtle projection of the outer grid box (drawn blended over the background).
  if (
    r.gridProjectionEnabled > 0.5 &&
    r.gridProjPipeline &&
    r.gridProjBindGroup &&
    r.gridProjInstanceBuffer
  ) {
    if (r.gridProjInstanceCount > 0) {
      pass.setPipeline(r.gridProjPipeline);
      pass.setBindGroup(0, r.gridProjBindGroup);
      pass.setVertexBuffer(0, r.gridProjInstanceBuffer);
      pass.draw(6, r.gridProjInstanceCount);
    }
  }

  // Cell pass (GPU-driven instance count)
  pass.setPipeline(r.renderPipeline);
  pass.setBindGroup(0, r.cellBindGroup);
  pass.setVertexBuffer(0, r.cubeVertexBuffer);
  pass.setIndexBuffer(r.cubeIndexBuffer, "uint16");
  pass.drawIndexedIndirect(r.indirectArgsBuffer, 0);

  pass.end();
  r.device.queue.submit([encoder.finish()]);
}
