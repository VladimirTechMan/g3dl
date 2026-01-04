/*
 * shaders.js
 * ----------
 * Centralized WGSL shader sources for G3DL (3D Conway's Game of Life).
 *
 * Goals:
 *  - Keep shader source audit-friendly (bindings + structs documented in one place).
 *  - Keep renderer.js focused on WebGPU wiring, not large WGSL literals.
 *
 * NOTE: Shader bindings/layouts must remain consistent with buffer packing in renderer.js.
 */

import { G3DL_LAYOUT } from "./dataLayout.js";

// ES module note:
// This file is intentionally a pure module (no global wrappers / IIFEs).
// Import order is enforced by the module graph: dataLayout.js is evaluated before this file.

  /**
   * Dedent a template string for readable WGSL blocks in JS source.
   * This keeps shader code visually aligned in this file while emitting clean WGSL.
   */
  function dedent(text) {
    // Drop a single leading newline to make template literals nicer.
    text = text.replace(/^\n/, "");
    const lines = text.split("\n");
    let minIndent = Infinity;

    for (const line of lines) {
      if (!line.trim()) continue;
      const m = line.match(/^(\s+)/);
      if (!m) {
        minIndent = 0;
        break;
      }
      minIndent = Math.min(minIndent, m[1].length);
    }

    if (!isFinite(minIndent) || minIndent <= 0) return lines.join("\n");
    const pad = " ".repeat(minIndent);
    return lines.map((l) => (l.startsWith(pad) ? l.slice(minIndent) : l)).join("\n");
  }

  /** Tagged template for WGSL blocks (supports normal ${...} interpolation). */
  function wgsl(strings, ...values) {
    // Use String.raw so backslashes are not double-interpreted.
    const raw = String.raw({ raw: strings }, ...values);
    return dedent(raw);
  }

  /**
   * validateWorkgroupSize()
   * Minimal runtime assertion to make shader generation failures obvious.
   * (This is intentionally lightweight to avoid overhead in hot paths.)
   */
  function validateWorkgroupSize(workgroupSize) {
    if (!workgroupSize || typeof workgroupSize.x !== "number") {
      throw new Error("Invalid workgroupSize passed to shader generator.");
    }
  }

  /**
   * Simulation compute shader
   * ------------------------
   * Updates a 3D u32 grid (0=dead, 1=alive), with a 26-neighborhood rule.
   *
   * Bindings (group(0)):
   *  - binding(0): uniform Params
   *      gridSize      : u32   // cubic dimension (N)
   *      surviveRule   : u32   // bitmask: if bit[count] set => alive cell survives
   *      birthRule     : u32   // bitmask: if bit[count] set => dead cell becomes alive
   *      toroidal      : u32   // 1=toroidal wrap, 0=hard edges
   *      changeEnabled : u32   // 1=increment changeCount on state flips
   *  - binding(1): storage, read       gridIn  : array<u32>  // generation n
   *  - binding(2): storage, read_write gridOut : array<u32>  // generation n+1
   *  - binding(3): storage, read_write changeCount : atomic<u32>
   */
  function simulation({ workgroupSize }) {
    validateWorkgroupSize(workgroupSize);
    return wgsl`
        ${G3DL_LAYOUT.PARAMS.SIM.WGSL_STRUCT}
        @group(0) @binding(0) var<uniform> params: Params;
        @group(0) @binding(1) var<storage, read> gridIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> gridOut: array<u32>;
        @group(0) @binding(3) var<storage, read_write> changeCount: atomic<u32>;

        @compute @workgroup_size(${workgroupSize.x}, ${workgroupSize.y}, ${workgroupSize.z})
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            if (id.x >= params.gridSize || id.y >= params.gridSize || id.z >= params.gridSize) { return; }

            let gs = params.gridSize;
            let plane = gs * gs;
            let idx0 = id.x + id.y * gs + id.z * plane;

            // Current cell is always in-bounds here; read directly.
            let curr = gridIn[idx0];

            let size = i32(gs);
            let x0 = i32(id.x);
            let y0 = i32(id.y);
            let z0 = i32(id.z);

            var neighbors = 0u;

            for (var dz: i32 = -1; dz <= 1; dz++) {
                var z = z0 + dz;
                if (params.toroidal != 0u) {
                    if (z < 0) { z += size; } else if (z >= size) { z -= size; }
                } else {
                    if (z < 0 || z >= size) { continue; }
                }

                for (var dy: i32 = -1; dy <= 1; dy++) {
                    var y = y0 + dy;
                    if (params.toroidal != 0u) {
                        if (y < 0) { y += size; } else if (y >= size) { y -= size; }
                    } else {
                        if (y < 0 || y >= size) { continue; }
                    }

                    for (var dx: i32 = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0 && dz == 0) { continue; }

                        var x = x0 + dx;
                        if (params.toroidal != 0u) {
                            if (x < 0) { x += size; } else if (x >= size) { x -= size; }
                        } else {
                            if (x < 0 || x >= size) { continue; }
                        }

                        let nidx = u32(x) + u32(y) * gs + u32(z) * plane;
                        neighbors += gridIn[nidx];
                    }
                }
            }

            var next = 0u;
            let bit = 1u << neighbors;
            if (curr != 0u && (params.surviveRule & bit) != 0u) { next = 1u; }
            else if (curr == 0u && (params.birthRule & bit) != 0u) { next = 1u; }

            gridOut[idx0] = next;

            // Fold change detection into the main compute pass.
            if (params.changeEnabled != 0u && curr != next) {
                atomicAdd(&changeCount, 1u);
            }
        }
    
    `;
  }

  /**
   * Extract live cells compute shader
   * --------------------------------
   * Scans the grid and compacts live cells into a packed u32 list.
   *
   * Packing: x (10 bits) | y (10 bits) << 10 | z (10 bits) << 20.
   * This supports gridSize up to 1024 (renderer clamps to <= 256 today).
   *
   * Bindings (group(0)):
   *  - binding(0): uniform Params { gridSize, maxCells, ... }
   *  - binding(1): storage, read       grid   : array<u32>
   *  - binding(2): storage, read_write cells  : array<u32>   // packed XYZ
   *  - binding(3): storage, read_write counter: atomic<u32>  // population
   */
  function extract({ workgroupSize }) {
    validateWorkgroupSize(workgroupSize);
    return wgsl`
            ${G3DL_LAYOUT.PARAMS.EXTRACT.WGSL_STRUCT}
            @group(0) @binding(0) var<uniform> params: Params;
            @group(0) @binding(1) var<storage, read> grid: array<u32>;
            @group(0) @binding(2) var<storage, read_write> cells: array<u32>;
            @group(0) @binding(3) var<storage, read_write> counter: atomic<u32>;

            @compute @workgroup_size(${workgroupSize.x}, ${workgroupSize.y}, ${workgroupSize.z})
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                if (id.x >= params.gridSize || id.y >= params.gridSize || id.z >= params.gridSize) { return; }
                let idx = id.x + id.y * params.gridSize + id.z * params.gridSize * params.gridSize;
                if (grid[idx] != 0u) {
                    let cellIdx = atomicAdd(&counter, 1u);
                    if (cellIdx < params.maxCells) {
                        cells[cellIdx] = (id.x & 0x3FFu) | ((id.y & 0x3FFu) << 10u) | ((id.z & 0x3FFu) << 20u);
                    }
                }
            }
        
    `;
  }

  /**
   * GPU-side random/grid initialization shader
   * ------------------------------------------
   * Populates the grid with deterministic pseudo-random values, constrained to a sub-region.
   *
   * Bindings (group(0)):
   *  - binding(0): uniform Params
   *      gridSize   : u32
   *      region     : u32   // size of cube region to randomize
   *      offset     : u32   // offset of region from 0
   *      threshold  : u32   // 0..0xFFFFFFFF: alive if hash3(x,y,z,seed) < threshold
   *      seed       : u32
   *  - binding(1): storage, read_write grid : array<u32>
   */
  function init({ workgroupSize }) {
    validateWorkgroupSize(workgroupSize);
    return wgsl`
            ${G3DL_LAYOUT.PARAMS.INIT.WGSL_STRUCT}
            @group(0) @binding(0) var<uniform> params: Params;
            @group(0) @binding(1) var<storage, read_write> grid: array<u32>;

            fn hash32(v: u32) -> u32 {
                var x = v;
                x ^= x >> 16u;
                x *= 0x7feb352du;
                x ^= x >> 15u;
                x *= 0x846ca68bu;
                x ^= x >> 16u;
                return x;
            }

            fn hash3(x: u32, y: u32, z: u32, seed: u32) -> u32 {
                let n = seed ^ (x * 73856093u) ^ (y * 19349663u) ^ (z * 83492791u);
                return hash32(n);
            }

            @compute @workgroup_size(${workgroupSize.x}, ${workgroupSize.y}, ${workgroupSize.z})
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                if (id.x >= params.gridSize || id.y >= params.gridSize || id.z >= params.gridSize) { return; }

                let gs = params.gridSize;
                let plane = gs * gs;
                let idx = id.x + id.y * gs + id.z * plane;

                let lo = params.offset;
                let hi = params.offset + params.region;

                var alive = 0u;
                if (id.x >= lo && id.x < hi && id.y >= lo && id.y < hi && id.z >= lo && id.z < hi) {
                    let r = hash3(id.x, id.y, id.z, params.seed);
                    alive = select(0u, 1u, r < params.threshold);
                }
                grid[idx] = alive;
            }
        
    `;
  }

  /**
   * AABB reduction shader (live-cell list -> atomic min/max)
   * --------------------------------------------------------
   * Consumes the compact live-cell list and atomically computes min/max per axis.
   * The AABB buffer is initialized by JS before dispatch (e.g., min=0xFFFFFFFF, max=0).
   *
   * Bindings (group(0)):
   *  - binding(0): storage, read_write counter: atomic<u32>  // population
   *  - binding(1): storage, read       cells  : array<u32>   // packed XYZ
   *  - binding(2): storage, read_write aabb   : Aabb         // atomic min/max accumulators
   */
  function aabb({ aabbWorkgroupSize }) {
    if (typeof aabbWorkgroupSize !== "number" || !isFinite(aabbWorkgroupSize)) {
      throw new Error("Invalid aabbWorkgroupSize passed to shader generator.");
    }
    return wgsl`
      const WG: u32 = ${aabbWorkgroupSize}u;

      @group(0) @binding(0) var<storage, read_write> counter: atomic<u32>;
      @group(0) @binding(1) var<storage, read> cells: array<u32>;

      // Atomic min/max accumulator. Backed by a raw u32 buffer initialized by JS.
      ${G3DL_LAYOUT.AABB.WGSL_STRUCT}
      @group(0) @binding(2) var<storage, read_write> aabb: Aabb;

      var<workgroup> wMinX: array<u32, WG>;
      var<workgroup> wMinY: array<u32, WG>;
      var<workgroup> wMinZ: array<u32, WG>;
      var<workgroup> wMaxX: array<u32, WG>;
      var<workgroup> wMaxY: array<u32, WG>;
      var<workgroup> wMaxZ: array<u32, WG>;

      @compute @workgroup_size(WG)
      fn main(
        @builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(global_invocation_id) gid: vec3<u32>
      ) {
        let idx = gid.x;
        let count = atomicLoad(&counter);

        var minX: u32 = 0xFFFFFFFFu;
        var minY: u32 = 0xFFFFFFFFu;
        var minZ: u32 = 0xFFFFFFFFu;
        var maxX: u32 = 0u;
        var maxY: u32 = 0u;
        var maxZ: u32 = 0u;

        if (idx < count) {
          let p = cells[idx];
          let ux = p & 0x3FFu;
          let uy = (p >> 10u) & 0x3FFu;
          let uz = (p >> 20u) & 0x3FFu;

          minX = ux;
          minY = uy;
          minZ = uz;
          maxX = ux;
          maxY = uy;
          maxZ = uz;
        }

        let li = lid.x;
        wMinX[li] = minX;
        wMinY[li] = minY;
        wMinZ[li] = minZ;
        wMaxX[li] = maxX;
        wMaxY[li] = maxY;
        wMaxZ[li] = maxZ;
        workgroupBarrier();

        var stride: u32 = WG / 2u;
        loop {
          if (stride == 0u) {
            break;
          }
          if (li < stride) {
            let j = li + stride;
            wMinX[li] = min(wMinX[li], wMinX[j]);
            wMinY[li] = min(wMinY[li], wMinY[j]);
            wMinZ[li] = min(wMinZ[li], wMinZ[j]);
            wMaxX[li] = max(wMaxX[li], wMaxX[j]);
            wMaxY[li] = max(wMaxY[li], wMaxY[j]);
            wMaxZ[li] = max(wMaxZ[li], wMaxZ[j]);
          }
          workgroupBarrier();
          stride = stride / 2u;
        }

        if (li == 0u) {
          atomicMin(&aabb.minX, wMinX[0]);
          atomicMin(&aabb.minY, wMinY[0]);
          atomicMin(&aabb.minZ, wMinZ[0]);
          atomicMax(&aabb.maxX, wMaxX[0]);
          atomicMax(&aabb.maxY, wMaxY[0]);
          atomicMax(&aabb.maxZ, wMaxZ[0]);
        }
      }
    
    `;
  }

  /**
   * AABB indirect-dispatch-args shader
   * ---------------------------------
   * Produces dispatchWorkgroupsIndirect() arguments based on current live-cell count.
   * This avoids CPU readback and makes the AABB computation robust under throttled stats.
   *
   * Bindings (group(0)):
   *  - binding(0): storage, read_write counter: atomic<u32>
   *  - binding(1): storage, read_write args   : array<u32>  // dispatch x,y,z as u32
   */
  function aabbArgs({ aabbWorkgroupSize }) {
    if (typeof aabbWorkgroupSize !== "number" || !isFinite(aabbWorkgroupSize)) {
      throw new Error("Invalid aabbWorkgroupSize passed to shader generator.");
    }
    return wgsl`
      const WG: u32 = ${aabbWorkgroupSize}u;

      @group(0) @binding(0) var<storage, read_write> counter: atomic<u32>;
      @group(0) @binding(1) var<storage, read_write> args: array<u32>;

      @compute @workgroup_size(1)
      fn main() {
        let count = atomicLoad(&counter);
        let groups = (count + WG - 1u) / WG;
        args[0] = groups;
        args[1] = 1u;
        args[2] = 1u;
        args[3] = 0u;
      }
    
    `;
  }

  /**
   * Draw-indirect args builder compute shader
   * -----------------------------------------
   * Creates GPUIndirectDrawIndexedArgs in a buffer, clamping instanceCount to maxCells.
   *
   * Bindings (group(0)):
   *  - binding(0): uniform Params { indexCount, maxCells, ... }
   *  - binding(1): storage, read_write counter: atomic<u32>
   *  - binding(2): storage, read_write args   : array<u32>  // 5 u32s
   */
  function drawArgs() {
    return wgsl`
            ${G3DL_LAYOUT.PARAMS.DRAW_ARGS.WGSL_STRUCT}
            @group(0) @binding(0) var<uniform> params: Params;
            // WGSL requires atomic variables in the 'storage' address space to be bound with
            // read_write access, even if the shader only performs atomicLoad.
            @group(0) @binding(1) var<storage, read_write> counter: atomic<u32>;
            @group(0) @binding(2) var<storage, read_write> args: array<u32>;

            @compute @workgroup_size(1)
            fn main() {
                let pop = atomicLoad(&counter);
                let inst = min(pop, params.maxCells);
                args[0] = params.indexCount; // indexCount
                args[1] = inst;              // instanceCount (clamped)
                args[2] = 0u;                // firstIndex
                args[3] = 0u;                // baseVertex
                args[4] = 0u;                // firstInstance
            }
        
    `;
  }

  /**
   * Cell render pipeline shader
   * ---------------------------
   * Renders instanced cubes for each live cell in the compact list.
   *
   * Bindings (group(0)):
   *  - binding(0): uniform Uniforms  // camera, colors, lantern params, time, etc.
   *  - binding(1): storage, read cells: array<u32>  // packed XYZ per instance
   */
  function render() {
    return wgsl`
            ${G3DL_LAYOUT.UNIFORMS.WGSL_STRUCT}
            struct VOut {
                @builtin(position) pos: vec4<f32>,
                @location(0) norm: vec3<f32>,
                @location(1) local: vec3<f32>,
                @location(2) grid: vec3<f32>,
                @location(3) cellColor: vec3<f32>,
                @location(4) phase: f32
            }

            @group(0) @binding(0) var<uniform> u: Uniforms;
            @group(0) @binding(1) var<storage, read> cells: array<u32>;

            // Small, cheap integer hash used to assign each cell a stable phase.
            fn hash3(x: u32, y: u32, z: u32) -> f32 {
                var n: u32 = (x * 73856093u) ^ (y * 19349663u) ^ (z * 83492791u);
                n = (n ^ (n >> 13u)) * 1274126177u;
                return f32(n & 0x00FFFFFFu) / 16777216.0;
            }

            // Triangle wave in [0..1], cheaper than sin() and good enough for candle-like flicker.
            fn tri(t: f32) -> f32 {
                let x = fract(t);
                return 1.0 - abs(x * 2.0 - 1.0);
            }

            @vertex fn vs(@location(0) pos: vec3<f32>, @location(1) norm: vec3<f32>, @builtin(instance_index) i: u32) -> VOut {
                let p = cells[i];
                let ux = p & 0x3FFu;
                let uy = (p >> 10u) & 0x3FFu;
                let uz = (p >> 20u) & 0x3FFu;
                let off = vec3<f32>(f32(ux), f32(uy), f32(uz));
                let centered = off - vec3<f32>(u.gridSize * 0.5);
                let wpos = (pos * u.cellSize * 0.9) + (centered * u.cellSize);

                // Calculate cell color based on Y position (gradient along vertical axis)
                let t = off.y / u.gridSize;
                let color = mix(u.cellColorBottom.rgb, u.cellColorTop.rgb, t);

                var o: VOut;
                o.norm = (u.model * vec4<f32>(norm, 0.0)).xyz;
                o.local = pos + 0.5;
                o.grid = off / u.gridSize;
                o.cellColor = color;
                o.phase = hash3(ux, uy, uz);
                o.pos = u.projection * u.view * u.model * vec4<f32>(wpos, 1.0);
                return o;
            }

            @fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
                // Camera-relative lighting - lights fixed relative to viewer

                // Light directions in view space (fixed relative to screen)
                // Key light: from behind-right-above the viewer
                let l1 = normalize(vec3<f32>(0.5, 0.4, 0.8));  // right, up, toward viewer
                // Fill light: from behind-left
                let l2 = normalize(vec3<f32>(-0.3, 0.2, 0.6));

                // Transform normal to view space for lighting
                let viewNormal = normalize((u.view * vec4<f32>(i.norm, 0.0)).xyz);

                // Strong directional lighting for 3D effect
                let diff1 = max(dot(viewNormal, l1), 0.0) * 0.75;  // Key light
                let diff2 = max(dot(viewNormal, l2), 0.0) * 0.2;   // Fill light
                let rim = pow(max(1.0 - abs(viewNormal.z), 0.0), 2.0) * 0.1; // Subtle rim on edges
                let ambient = 0.2;

                let lighting = diff1 + diff2 + rim + ambient;

                // Use the interpolated cell color (solid per cube, gradient across grid)
                let base = i.cellColor;
                let edge = (vec3<f32>(1.0) - i.cellColor) * 0.4;
                let an = abs(i.norm);
                var uv: vec2<f32>;
                if (an.x > 0.5) { uv = i.local.yz; } else if (an.y > 0.5) { uv = i.local.xz; } else { uv = i.local.xy; }
                let ed = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
                let ef = 1.0 - smoothstep(0.0, 0.06, ed);
                let shaded = mix(base, edge, ef);
                var rgb = shaded * lighting;

                // Optional per-cell emissive "lantern" effect (very low cost: a few ALU ops).
                // We brighten the face center using the same per-face UV used for edge highlighting.
                if (u.lanternEnabled > 0.5) {
                    let d = max(abs(uv.x - 0.5), abs(uv.y - 0.5)); // 0 at face center, 0.5 at edges
                    let glow = pow(clamp(1.0 - d * 2.0, 0.0, 1.0), 2.2);

                    // Candle-like flicker: combine two cheap triangle waves with a per-cell phase.
                    let t1 = tri(u.time * 0.40 + i.phase);
                    let t2 = tri(u.time * 0.685 + i.phase * 1.91);
                    // Slightly more pronounced flicker (amplitude + variation), while preserving the original look.
                    let flick = 0.82 + 0.34 * (0.60 * t1 + 0.40 * t2);

                    // Slight warm bias to suggest a candle inside a paper lantern.
                    let warm = vec3<f32>(1.0, 0.78, 0.45);
                    let emColor = mix(base, warm, 0.15);

                    let emissive = emColor * u.lanternStrength * flick * (0.20 + 0.80 * glow);
                    rgb = rgb * 0.72 + emissive;
                }

                return vec4<f32>(min(rgb, vec3<f32>(1.0)), 1.0);
            }
        
    `;
  }

  /**
   * Grid projection overlay shader
   * ------------------------------
   * Draws 3 orthogonal grid planes (XY/YZ/ZX) projected in 3D as wireframe-like quads.
   *
   * Bindings (group(0)):
   *  - binding(0): uniform Uniforms  // same as render() for camera + colors
   */
  function gridProjection() {
    return wgsl`
        ${G3DL_LAYOUT.UNIFORMS.WGSL_STRUCT}

        @group(0) @binding(0) var<uniform> u: Uniforms;

        struct VOut {
            @builtin(position) pos: vec4<f32>,
            @location(0) local: vec2<f32>, // [-0.5..0.5] quad-local, used for subtle alpha shaping
        };

        fn localForVertex(vid: u32) -> vec2<f32> {
            // Two triangles (6 vertices) covering a quad.
            if (vid == 0u) { return vec2<f32>(-0.5, -0.5); }
            if (vid == 1u) { return vec2<f32>( 0.5, -0.5); }
            if (vid == 2u) { return vec2<f32>(-0.5,  0.5); }
            if (vid == 3u) { return vec2<f32>(-0.5,  0.5); }
            if (vid == 4u) { return vec2<f32>( 0.5, -0.5); }
            return vec2<f32>( 0.5,  0.5);
        }

        @vertex fn vs(
            @location(0) center: vec4<f32>,
            @location(1) axisU: vec4<f32>,
            @location(2) axisV: vec4<f32>,
            @builtin(vertex_index) vid: u32
        ) -> VOut {
            let l = localForVertex(vid);
            let wpos = center.xyz + axisU.xyz * l.x + axisV.xyz * l.y;

            var o: VOut;
            o.local = l;
            o.pos = u.projection * u.view * u.model * vec4<f32>(wpos, 1.0);
            return o;
        }

        @fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
            // Filled translucent plane: slightly stronger in the middle, softer near edges.
            let edge = max(abs(i.local.x), abs(i.local.y)); // 0..0.5
            let fade = 1.0 - smoothstep(0.40, 0.50, edge);  // fade toward edges
            let a = 0.11 * (0.65 + 0.35 * fade);
            return vec4<f32>(0.82, 0.86, 0.95, a);
        }
    
    `;
  }

  /**
   * Background shader (fullscreen triangle)
   * ---------------------------------------
   * Renders a static/animated background; lantern flicker is controlled via uniforms.
   *
   * Bindings (group(0)):
   *  - binding(0): uniform BgUniforms  // gradient + vignette parameters
   */
  function background() {
    return wgsl`
            ${G3DL_LAYOUT.BG_UNIFORMS.WGSL_STRUCT}

            @group(0) @binding(0) var<uniform> bg: BgUniforms;

            struct VOut {
                @builtin(position) pos: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

            @vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
                // Fullscreen triangle
                var positions = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(3.0, -1.0),
                    vec2<f32>(-1.0, 3.0)
                );
                var o: VOut;
                o.pos = vec4<f32>(positions[i], 0.9999, 1.0);
                o.uv = positions[i]; // -1 to 1 range
                return o;
            }

            @fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
                // Project screen position onto the up direction to get gradient
                // upDir.xy is the screen-space direction of the scene's Y axis
                let upDir2D = normalize(bg.upDir.xy);

                // Dot product gives us how far along the up direction we are
                let t = dot(i.uv, upDir2D) * 0.5 + 0.5;

                let color = mix(bg.colorBottom.rgb, bg.colorTop.rgb, t);
                return vec4<f32>(color, 1.0);
            }
        
    `;
  }


export const G3DL_SHADERS = Object.freeze({
  simulation,
  extract,
  init,
  aabb,
  aabbArgs,
  drawArgs,
  render,
  gridProjection,
  background,
});
