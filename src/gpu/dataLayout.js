/* dataLayout.js
 *
 * Authoritative GPU buffer layout contract for G3DL (3D Conway's Game of Life).
 *
 * Why this exists
 *  - WebGPU is intentionally explicit. Uniform/storage buffer layouts must match *exactly*
 *    between JavaScript (CPU writes) and WGSL (GPU reads).
 *  - Some issues only surface on certain backends (Metal/Vulkan/D3D) or certain GPUs,
 *    especially when padding/alignment assumptions drift over time.
 *
 * Scope
 *  - Uniform layouts (render uniforms + background uniforms)
 *  - Uniform parameter blocks for compute passes (simulation/extract/init/drawArgs)
 *  - Storage layouts that are initialized/reset from JS (AABB accumulator, indirect args)
 *
 * Notes on WGSL uniform layout
 *  - Scalars (f32/u32/i32) have 4-byte alignment.
 *  - vec4<f32> has 16-byte alignment and occupies 16 bytes.
 *  - mat4x4<f32> is stored as 4 x vec4<f32>: 64 bytes, 16-byte aligned.
 *  - Struct sizes are rounded up to a multiple of the struct alignment (typically 16 for
 *    anything containing vec4/mat4x4).
 *
 * ES module. Exports the authoritative JS↔WGSL layout contract:
 *   export const G3DL_LAYOUT
 */

const DEBUG = (() => {
  // Debug checks are intentionally URL-scoped (not persisted) to avoid surprising
  // "sticky" debug assertions/logging when users temporarily enable debug mode.
  //
  // Supported forms:
  //   ?debug=1 | ?debug=true | ?debug=yes | ?debug=on | ?debug   -> enabled
  //   ?debug=0 | ?debug=false | ?debug=no  | ?debug=off          -> disabled
  try {
    if (typeof location === "undefined") return false;
    const params = new URLSearchParams(String(location.search || ""));
    if (!params.has("debug")) return false;
    const raw = params.get("debug");
    if (raw == null) return true; // presence without value
    const s = String(raw).trim().toLowerCase();
    if (s === "" || s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    return true; // unknown values default to enabled
  } catch {
    return false;
  }
})();

function invariant(cond, msg) {
  if (!cond) throw new Error(`G3DL layout contract violation: ${msg}`);
}

function isMultipleOf(n, m) {
  return (n % m) === 0;
}

// ----------------------------
// Render uniforms (group(0), binding(0))
// ----------------------------
//
// WGSL: struct Uniforms
// JS:  Float32Array (72 floats = 288 bytes) written at offset 0.
//
// We allocate a slightly larger uniform buffer (currently 512 bytes) to leave room for
// future extensions without having to re-plumb buffer creation; the *active* region is
// defined by DATA_BYTES below.
const UNIFORMS = Object.freeze({
  DATA_FLOATS: 72,
  DATA_BYTES: 72 * 4,

  // Offsets in 32-bit floats (Float32Array indices).
  F32: Object.freeze({
    PROJECTION: 0, // mat4x4<f32> (16 floats) => bytes 0..63
    VIEW: 16, // mat4x4<f32> (16 floats) => bytes 64..127
    MODEL: 32, // mat4x4<f32> (16 floats) => bytes 128..191

    CELL_COLOR_TOP: 48, // vec4<f32> => bytes 192..207
    CELL_COLOR_BOTTOM: 52, // vec4<f32> => bytes 208..223
    CAMERA_DIR: 56, // vec4<f32> => bytes 224..239

    GRID_SIZE: 60, // f32 => byte 240
    CELL_SIZE: 61, // f32 => byte 244
    // Explicit padding to keep the scalar tail 16-byte aligned. Not read by shaders.
    PAD0: 62,
    PAD1: 63,

    LANTERN_ENABLED: 64, // f32 => byte 256
    LANTERN_STRENGTH: 65, // f32 => byte 260
    // Explicit padding (16B alignment). Not read by shaders.
    PAD2: 66,
    PAD3: 67,

    TIME: 68, // f32 => byte 272
    // Explicit padding (16B alignment). Not read by shaders.
    PAD4: 69,
    PAD5: 70,
    PAD6: 71,
  }),

  WGSL_STRUCT: `struct Uniforms {
// 0..191 bytes
projection: mat4x4<f32>,
view: mat4x4<f32>,
model: mat4x4<f32>,

// 192..239 bytes
cellColorTop: vec4<f32>,
cellColorBottom: vec4<f32>,
cameraDir: vec4<f32>,

// 240..255 bytes (scalars + explicit padding to 16B boundary)
gridSize: f32,
cellSize: f32,
pad0: f32,
pad1: f32,

// 256..271 bytes
lanternEnabled: f32,
lanternStrength: f32,
pad2: f32,
pad3: f32,

// 272..287 bytes
time: f32,
pad4: f32,
pad5: f32,
pad6: f32
}`,
});

// ----------------------------
// Background uniforms (group(0), binding(0) for bg pipeline)
// ----------------------------
// WGSL: struct BgUniforms { colorTop, colorBottom, upDir }
// JS:  Float32Array (12 floats = 48 bytes).
const BG_UNIFORMS = Object.freeze({
  DATA_FLOATS: 12,
  DATA_BYTES: 12 * 4,
  F32: Object.freeze({
    COLOR_TOP: 0, // vec4
    COLOR_BOTTOM: 4, // vec4
    UP_DIR: 8, // vec4
  }),
  WGSL_STRUCT: `struct BgUniforms {
colorTop: vec4<f32>,
colorBottom: vec4<f32>,
upDir: vec4<f32>,  // Camera's view of world Y axis (in screen space)
}`,
});

// ----------------------------
// Compute uniform parameter blocks (group(0), binding(0))
// ----------------------------
const PARAMS = Object.freeze({
  SIM: Object.freeze({
    U32S: 8,
    BYTES: 8 * 4,
    U32: Object.freeze({
      GRID_SIZE: 0,
      SURVIVE_RULE: 1,
      BIRTH_RULE: 2,
      TOROIDAL: 3,
      CHANGE_ENABLED: 4,
      // Explicit padding (uniform structs are rounded up to 16-byte alignment).
      // Not read by shaders.
      PAD0: 5,
      PAD1: 6,
      PAD2: 7,
    }),
    WGSL_STRUCT: `struct Params {
gridSize: u32,
surviveRule: u32,
birthRule: u32,
toroidal: u32,
changeEnabled: u32,
pad0: u32,
pad1: u32,
pad2: u32
}`,
  }),
  EXTRACT: Object.freeze({
    U32S: 4,
    BYTES: 4 * 4,
    U32: Object.freeze({
      GRID_SIZE: 0,
      MAX_CELLS: 1,
      // Explicit padding (16-byte alignment). Not read by shaders.
      PAD0: 2,
      PAD1: 3,
    }),
    WGSL_STRUCT: `struct Params { gridSize: u32, maxCells: u32, pad0: u32, pad1: u32 }`,
  }),
  INIT: Object.freeze({
    U32S: 8,
    BYTES: 8 * 4,
    U32: Object.freeze({
      GRID_SIZE: 0,
      REGION: 1,
      OFFSET: 2,
      THRESHOLD: 3,
      SEED: 4,
      // Explicit padding (16-byte alignment). Not read by shaders.
      PAD0: 5,
      PAD1: 6,
      PAD2: 7,
    }),
    WGSL_STRUCT: `struct Params {
gridSize: u32,
region: u32,
offset: u32,
threshold: u32,
seed: u32,
pad0: u32,
pad1: u32,
pad2: u32
}`,
  }),
  DRAW_ARGS: Object.freeze({
    U32S: 4,
    BYTES: 4 * 4,
    U32: Object.freeze({
      INDEX_COUNT: 0,
      MAX_CELLS: 1,
      // Explicit padding (16-byte alignment). Not read by shaders.
      PAD0: 2,
      PAD1: 3,
    }),
    WGSL_STRUCT: `struct Params { indexCount: u32, maxCells: u32, pad0: u32, pad1: u32 }`,
  }),
});

// ----------------------------
// Indirect argument buffers
// ----------------------------
//
// drawIndexedIndirect() expects 5 u32 values:
//  indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const INDIRECT = Object.freeze({
  DRAW_INDEXED_U32S: 5,
  DRAW_INDEXED_BYTES: 5 * 4,
  DRAW_INDEXED_U32: Object.freeze({
    INDEX_COUNT: 0,
    INSTANCE_COUNT: 1,
    FIRST_INDEX: 2,
    BASE_VERTEX: 3,
    FIRST_INSTANCE: 4,
  }),
  // dispatchWorkgroupsIndirect() expects 3 u32 values; we allocate 16 bytes for convenience/alignment.
  DISPATCH_U32S: 4, // last element is unused padding
  DISPATCH_BYTES: 16,
  DISPATCH_U32: Object.freeze({
    X: 0,
    Y: 1,
    Z: 2,
    // Explicit padding to keep the struct 16-byte aligned. Not read by shaders.
    PAD0: 3,
  }),
});

// ----------------------------
// AABB accumulator (storage buffer)
// ----------------------------
// Atomic min/max over packed cell coordinates. Must match initialization/reset code.
const AABB = Object.freeze({
  U32S: 8,
  BYTES: 8 * 4,
  // Layout order is important (6 atomic<u32> + 2 padding u32).
  WGSL_STRUCT: `struct Aabb {
minX: atomic<u32>,
minY: atomic<u32>,
minZ: atomic<u32>,
maxX: atomic<u32>,
maxY: atomic<u32>,
maxZ: atomic<u32>,
_pad0: u32,
_pad1: u32,
};`,
});

// ----------------------------
// Assertions
// ----------------------------
function assertStatic() {
  invariant(isMultipleOf(UNIFORMS.DATA_BYTES, 16), "Uniforms size must be multiple of 16 bytes.");
  invariant(isMultipleOf(BG_UNIFORMS.DATA_BYTES, 16), "BgUniforms size must be multiple of 16 bytes.");
  invariant(UNIFORMS.DATA_BYTES === 288, "Uniforms bytes expected to be 288 (72 f32).");
  invariant(BG_UNIFORMS.DATA_BYTES === 48, "BgUniforms bytes expected to be 48 (12 f32).");
  invariant(PARAMS.SIM.BYTES === 32, "SIM params bytes expected to be 32 (8 u32).");
  invariant(PARAMS.EXTRACT.BYTES === 16, "EXTRACT params bytes expected to be 16 (4 u32).");
  invariant(PARAMS.INIT.BYTES === 32, "INIT params bytes expected to be 32 (8 u32).");
  invariant(PARAMS.DRAW_ARGS.BYTES === 16, "DRAW_ARGS params bytes expected to be 16 (4 u32).");
  invariant(INDIRECT.DRAW_INDEXED_BYTES === 20, "drawIndexedIndirect args bytes expected to be 20 (5 u32).");
  invariant(AABB.BYTES === 32, "AABB bytes expected to be 32 (8 u32).");
}

function assertRenderer(renderer) {
  // Typed arrays (CPU-side staging)
  invariant(
    renderer._renderUniforms && renderer._renderUniforms.length === UNIFORMS.DATA_FLOATS,
    `renderer._renderUniforms must be Float32Array(${UNIFORMS.DATA_FLOATS}).`,
  );
  invariant(
    renderer._bgUniforms && renderer._bgUniforms.length === BG_UNIFORMS.DATA_FLOATS,
    `renderer._bgUniforms must be Float32Array(${BG_UNIFORMS.DATA_FLOATS}).`,
  );
  invariant(
    renderer._computeParams && renderer._computeParams.length === PARAMS.SIM.U32S,
    `renderer._computeParams must be Uint32Array(${PARAMS.SIM.U32S}).`,
  );
  invariant(
    renderer._extractParams && renderer._extractParams.length === PARAMS.EXTRACT.U32S,
    `renderer._extractParams must be Uint32Array(${PARAMS.EXTRACT.U32S}).`,
  );
  invariant(
    renderer._initParams && renderer._initParams.length === PARAMS.INIT.U32S,
    `renderer._initParams must be Uint32Array(${PARAMS.INIT.U32S}).`,
  );

  // GPUBuffer.size is present in current WebGPU implementations, but guard for robustness.
  function assertBufferMinSize(buf, minBytes, name) {
    if (!buf || typeof buf.size !== "number") return;
    invariant(buf.size >= minBytes, `${name}.size (${buf.size}) < expected minimum (${minBytes}).`);
  }

  assertBufferMinSize(renderer.uniformBuffer, UNIFORMS.DATA_BYTES, "uniformBuffer");
  assertBufferMinSize(renderer.bgUniformBuffer, BG_UNIFORMS.DATA_BYTES, "bgUniformBuffer");
  assertBufferMinSize(renderer.computeParamsBuffer, PARAMS.SIM.BYTES, "computeParamsBuffer");
  assertBufferMinSize(renderer.extractParamsBuffer, PARAMS.EXTRACT.BYTES, "extractParamsBuffer");
  assertBufferMinSize(renderer.initParamsBuffer, PARAMS.INIT.BYTES, "initParamsBuffer");
  if (renderer.drawArgsParamsBuffer) {
    assertBufferMinSize(renderer.drawArgsParamsBuffer, PARAMS.DRAW_ARGS.BYTES, "drawArgsParamsBuffer");
  }
  if (renderer.indirectArgsBuffer) {
    assertBufferMinSize(renderer.indirectArgsBuffer, INDIRECT.DRAW_INDEXED_BYTES, "indirectArgsBuffer");
  }
  if (renderer.aabbBuffer) {
    assertBufferMinSize(renderer.aabbBuffer, AABB.BYTES, "aabbBuffer");
  }
  if (renderer.aabbDispatchArgsBuffer) {
    assertBufferMinSize(renderer.aabbDispatchArgsBuffer, INDIRECT.DISPATCH_BYTES, "aabbDispatchArgsBuffer");
  }
}

assertStatic();

export const G3DL_LAYOUT = Object.freeze({
  DEBUG,
  UNIFORMS,
  BG_UNIFORMS,
  PARAMS,
  INDIRECT,
  AABB,
  invariant,
  assertRenderer,
});
