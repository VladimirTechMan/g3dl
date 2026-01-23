/**
 * Correctness self-test suite (debug-only).
 *
 * This module is dynamically imported when the user clicks the "Self-test"
 * button (available only when debug mode is enabled via the URL, e.g., ?debug or ?debug=1).
 *
 * Design goals:
 * - Provide a deterministic GPU-vs-CPU validation of the simulation kernel.
 * - Validate the GPU live-cell extraction/compaction path used by rendering.
 * - Be small, self-contained, and safe to run on mobile.
 * - Avoid mutating the user's current simulation state (uses separate buffers).
 */

import { G3DL_SHADERS } from "../../gpu/shaders.js";
import { G3DL_LAYOUT } from "../../gpu/dataLayout.js";

/**
 * @typedef {{ x: number, y: number, z: number }} WorkgroupSize
 */

/**
 * @typedef {Object} SelfTestDeps
 * @property {GPUDevice} device
 * @property {WorkgroupSize} [workgroupSize]
 * @property {() => Promise<void>} [yieldToUi]
 */

/**
 * @typedef {Object} SelfTestResult
 * @property {boolean} ok
 * @property {string} message
 */

function bitmaskFromCounts(counts) {
  let m = 0;
  for (const c of counts) {
    const n = c | 0;
    if (n < 0 || n > 26) continue;
    m = (m | (1 << n)) >>> 0;
  }
  return m >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function indexToXYZ(i, n) {
  const x = i % n;
  const y = ((i / n) | 0) % n;
  const z = (i / (n * n)) | 0;
  return { x, y, z };
}

function cpuStep3d(gridIn, n, surviveMask, birthMask, toroidal) {
  const out = new Uint32Array(gridIn.length);
  const plane = n * n;

  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const idx0 = x + y * n + z * plane;
        const curr = gridIn[idx0] ? 1 : 0;
        let neighbors = 0;

        for (let dz = -1; dz <= 1; dz++) {
          let zz = z + dz;
          if (toroidal) {
            if (zz < 0) zz += n;
            else if (zz >= n) zz -= n;
          } else {
            if (zz < 0 || zz >= n) continue;
          }

          for (let dy = -1; dy <= 1; dy++) {
            let yy = y + dy;
            if (toroidal) {
              if (yy < 0) yy += n;
              else if (yy >= n) yy -= n;
            } else {
              if (yy < 0 || yy >= n) continue;
            }

            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;

              let xx = x + dx;
              if (toroidal) {
                if (xx < 0) xx += n;
                else if (xx >= n) xx -= n;
              } else {
                if (xx < 0 || xx >= n) continue;
              }

              const nidx = xx + yy * n + zz * plane;
              neighbors += gridIn[nidx] ? 1 : 0;
            }
          }
        }

        const bit = (1 << neighbors) >>> 0;
        let next = 0;
        if (curr && (surviveMask & bit)) next = 1;
        else if (!curr && (birthMask & bit)) next = 1;
        out[idx0] = next;
      }
    }
  }

  return out;
}

async function createComputePipeline(device, desc) {
  if (typeof device.createComputePipelineAsync === "function") {
    return await device.createComputePipelineAsync(desc);
  }
  return device.createComputePipeline(desc);
}

function safeToString(v) {
  try {
    return String(v);
  } catch {
    return "";
  }
}

function popcountU32Grid(grid) {
  let p = 0;
  for (let i = 0; i < grid.length; i++) p += grid[i] ? 1 : 0;
  return p;
}

function decodePackedXYZ(packed) {
  const x = packed & 0x3ff;
  const y = (packed >>> 10) & 0x3ff;
  const z = (packed >>> 20) & 0x3ff;
  return { x, y, z };
}

async function runCase({
  device,
  workgroupSize,
  name,
  n,
  steps,
  seed,
  density,
  surviveMask,
  birthMask,
  toroidal,
  yieldToUi,
}) {
  const totalCells = n * n * n;
  const gridBytes = totalCells * 4;

  const extractParamsU32 = new Uint32Array(G3DL_LAYOUT.PARAMS.EXTRACT.U32S);
  extractParamsU32[G3DL_LAYOUT.PARAMS.EXTRACT.U32.GRID_SIZE] = n >>> 0;
  extractParamsU32[G3DL_LAYOUT.PARAMS.EXTRACT.U32.MAX_CELLS] = totalCells >>> 0;

  const paramsU32 = new Uint32Array(G3DL_LAYOUT.PARAMS.SIM.U32S);
  paramsU32[G3DL_LAYOUT.PARAMS.SIM.U32.GRID_SIZE] = n >>> 0;
  paramsU32[G3DL_LAYOUT.PARAMS.SIM.U32.SURVIVE_RULE] = surviveMask >>> 0;
  paramsU32[G3DL_LAYOUT.PARAMS.SIM.U32.BIRTH_RULE] = birthMask >>> 0;
  paramsU32[G3DL_LAYOUT.PARAMS.SIM.U32.TOROIDAL] = toroidal ? 1 : 0;
  paramsU32[G3DL_LAYOUT.PARAMS.SIM.U32.CHANGE_ENABLED] = 0;

  const rng = mulberry32(seed >>> 0);
  const initGrid = new Uint32Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    initGrid[i] = rng() < density ? 1 : 0;
  }

  // Create isolated resources for the self-test.
  const paramsBuf = device.createBuffer({
    size: G3DL_LAYOUT.PARAMS.SIM.BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const extractParamsBuf = device.createBuffer({
    size: G3DL_LAYOUT.PARAMS.EXTRACT.BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const gridA = device.createBuffer({
    size: gridBytes,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  });

  const gridB = device.createBuffer({
    size: gridBytes,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  });

  const changeCount = device.createBuffer({
    size: 4,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  });

  const livingCells = device.createBuffer({
    size: totalCells * 4,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
  });

  const populationCount = device.createBuffer({
    size: 4,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  });

  const stage = device.createBuffer({
    size: gridBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const stageCells = device.createBuffer({
    size: totalCells * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const stagePop = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const wg = workgroupSize || { x: 8, y: 4, z: 4 };

  const code = G3DL_SHADERS.simulation({ workgroupSize: wg });
  const mod = device.createShaderModule({ code });
  const pipeline = await createComputePipeline(device, {
    layout: "auto",
    compute: { module: mod, entryPoint: "main" },
  });

  const extractCode = G3DL_SHADERS.extract({ workgroupSize: wg });
  const extractMod = device.createShaderModule({ code: extractCode });
  const extractPipeline = await createComputePipeline(device, {
    layout: "auto",
    compute: { module: extractMod, entryPoint: "main" },
  });

  const layout0 = pipeline.getBindGroupLayout(0);
  const bindAtoB = device.createBindGroup({
    layout: layout0,
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: gridA } },
      { binding: 2, resource: { buffer: gridB } },
      { binding: 3, resource: { buffer: changeCount } },
    ],
  });

  const bindBtoA = device.createBindGroup({
    layout: layout0,
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: gridB } },
      { binding: 2, resource: { buffer: gridA } },
      { binding: 3, resource: { buffer: changeCount } },
    ],
  });

  const extractLayout0 = extractPipeline.getBindGroupLayout(0);
  const extractBindReadA = device.createBindGroup({
    layout: extractLayout0,
    entries: [
      { binding: 0, resource: { buffer: extractParamsBuf } },
      { binding: 1, resource: { buffer: gridA } },
      { binding: 2, resource: { buffer: livingCells } },
      { binding: 3, resource: { buffer: populationCount } },
    ],
  });
  const extractBindReadB = device.createBindGroup({
    layout: extractLayout0,
    entries: [
      { binding: 0, resource: { buffer: extractParamsBuf } },
      { binding: 1, resource: { buffer: gridB } },
      { binding: 2, resource: { buffer: livingCells } },
      { binding: 3, resource: { buffer: populationCount } },
    ],
  });

  let result = { ok: true, message: `${name}: ok` };

  try {
    // Upload init state.
    device.queue.writeBuffer(paramsBuf, 0, paramsU32);
    device.queue.writeBuffer(extractParamsBuf, 0, extractParamsU32);
    device.queue.writeBuffer(gridA, 0, initGrid);

    let cpu = initGrid;
    let gpuOutIsB = true;

    const wgX = Math.ceil(n / wg.x);
    const wgY = Math.ceil(n / wg.y);
    const wgZ = Math.ceil(n / wg.z);

    for (let step = 1; step <= steps; step++) {
      if (yieldToUi) await yieldToUi();

      // CPU reference step.
      const cpuNext = cpuStep3d(cpu, n, surviveMask, birthMask, toroidal);

      // GPU step.
      device.queue.writeBuffer(changeCount, 0, new Uint32Array([0]));
      device.queue.writeBuffer(populationCount, 0, new Uint32Array([0]));

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, gpuOutIsB ? bindAtoB : bindBtoA);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);

      // Validate the extraction/compaction path used by rendering.
      pass.setPipeline(extractPipeline);
      pass.setBindGroup(0, gpuOutIsB ? extractBindReadB : extractBindReadA);
      pass.dispatchWorkgroups(wgX, wgY, wgZ);
      pass.end();

      // Copy the newly produced grid to the staging buffer for readback.
      const src = gpuOutIsB ? gridB : gridA;
      enc.copyBufferToBuffer(src, 0, stage, 0, gridBytes);
      enc.copyBufferToBuffer(populationCount, 0, stagePop, 0, 4);
      enc.copyBufferToBuffer(livingCells, 0, stageCells, 0, totalCells * 4);

      device.queue.submit([enc.finish()]);

      // Read back and compare.
      if (typeof device.queue.onSubmittedWorkDone === "function") {
        await device.queue.onSubmittedWorkDone();
      }

      await stage.mapAsync(GPUMapMode.READ);
      const mapped = stage.getMappedRange();
      const gpu = new Uint32Array(mapped.slice(0));
      stage.unmap();

      // Read back extraction results and validate against the grid.
      await stagePop.mapAsync(GPUMapMode.READ);
      const popBuf = stagePop.getMappedRange();
      const pop = new Uint32Array(popBuf.slice(0))[0] >>> 0;
      stagePop.unmap();

      await stageCells.mapAsync(GPUMapMode.READ);
      const cellsBuf = stageCells.getMappedRange();
      const cells = new Uint32Array(cellsBuf.slice(0));
      stageCells.unmap();

      const gpuPop = popcountU32Grid(gpu);
      if (pop !== gpuPop) {
        // eslint-disable-next-line no-console
        console.error("Self-test extract mismatch (population)", { name, step, pop, gpuPop });
        result = {
          ok: false,
          message: `${name}: extract population mismatch at step ${step} (counter=${pop}, grid=${gpuPop}).`,
        };
        break;
      }

      const visited = new Uint8Array(totalCells);
      const plane = n * n;
      let badEntry = null;
      for (let i = 0; i < pop; i++) {
        const packed = cells[i] >>> 0;
        const { x, y, z } = decodePackedXYZ(packed);
        if (x >= n || y >= n || z >= n) {
          badEntry = { i, packed, x, y, z, reason: "out_of_range" };
          break;
        }
        const idx = x + y * n + z * plane;
        if (!gpu[idx]) {
          badEntry = { i, packed, x, y, z, reason: "dead_in_grid" };
          break;
        }
        if (visited[idx]) {
          badEntry = { i, packed, x, y, z, reason: "duplicate" };
          break;
        }
        visited[idx] = 1;
      }

      if (badEntry) {
        // eslint-disable-next-line no-console
        console.error("Self-test extract mismatch (cell list)", { name, step, badEntry });
        result = {
          ok: false,
          message: `${name}: extract list mismatch at step ${step} (${badEntry.reason}).`,
        };
        break;
      }

      // Completeness: every alive cell in the grid must be present exactly once.
      let missing = 0;
      for (let i = 0; i < totalCells; i++) {
        if (gpu[i] && !visited[i]) missing++;
      }
      if (missing) {
        // eslint-disable-next-line no-console
        console.error("Self-test extract mismatch (missing cells)", { name, step, missing });
        result = {
          ok: false,
          message: `${name}: extract missing cells at step ${step} (${missing} missing).`,
        };
        break;
      }

      let mismatches = 0;
      const first = [];
      for (let i = 0; i < totalCells; i++) {
        const a = gpu[i] ? 1 : 0;
        const b = cpuNext[i] ? 1 : 0;
        if (a !== b) {
          mismatches++;
          if (first.length < 5) {
            const { x, y, z } = indexToXYZ(i, n);
            first.push({ x, y, z, gpu: a, cpu: b });
          }
        }
      }

      if (mismatches) {
        const details = first
          .map((m) => `(${m.x},${m.y},${m.z}) gpu=${m.gpu} cpu=${m.cpu}`)
          .join(", ");
        // Provide detailed info in the console (toast text should stay short).
        // eslint-disable-next-line no-console
        console.error("Self-test mismatch:", { name, step, n, mismatches, sample: first });
        result = {
          ok: false,
          message: `${name}: mismatch at step ${step} (${mismatches} cells differ). Sample: ${details}`,
        };
        break;
      }

      // Advance.
      cpu = cpuNext;
      gpuOutIsB = !gpuOutIsB;
    }
  } finally {
    // Ensure we release buffers promptly; mobile GPUs are memory constrained.
    try {
      paramsBuf.destroy();
      extractParamsBuf.destroy();
      gridA.destroy();
      gridB.destroy();
      changeCount.destroy();
      livingCells.destroy();
      populationCount.destroy();
      stage.destroy();
      stageCells.destroy();
      stagePop.destroy();
    } catch (_) {}
  }

  return result;
}

/**
 * Runs a small suite of deterministic GPU-vs-CPU checks.
 *
 * @param {SelfTestDeps} deps
 * @returns {Promise<SelfTestResult>}
 */
export async function runSelfTestSuite(deps) {
  const device = deps?.device;
  if (!device) {
    return { ok: false, message: "Self-test unavailable: no GPU device." };
  }

  const wg = deps.workgroupSize || { x: 8, y: 4, z: 4 };
  const yieldToUi = deps.yieldToUi;

  // Use two well-known 3D Life-style rule sets.
  const RULES = [
    {
      name: "B6/S567",
      survive: bitmaskFromCounts([5, 6, 7]),
      birth: bitmaskFromCounts([6]),
    },
    {
      name: "B5/S45",
      survive: bitmaskFromCounts([4, 5]),
      birth: bitmaskFromCounts([5]),
    },
  ];

  const CASES = [];
  for (const r of RULES) {
    CASES.push({
      name: `${r.name} (edges)`,
      n: 12,
      steps: 3,
      seed: 0x1234abcd,
      density: 0.22,
      surviveMask: r.survive,
      birthMask: r.birth,
      toroidal: false,
    });
    CASES.push({
      name: `${r.name} (toroidal)`,
      n: 12,
      steps: 3,
      seed: 0x9e3779b9,
      density: 0.22,
      surviveMask: r.survive,
      birthMask: r.birth,
      toroidal: true,
    });
  }

  // Quick sanity: ensure workgroup size is usable (avoid obvious invalid configs).
  if (!wg || !wg.x || !wg.y || !wg.z) {
    return { ok: false, message: "Self-test unavailable: invalid workgroup size." };
  }

  try {
    for (const c of CASES) {
      if (yieldToUi) await yieldToUi();

      const res = await runCase({
        device,
        workgroupSize: wg,
        yieldToUi,
        ...c,
      });

      if (!res.ok) return res;
    }

    return {
      ok: true,
      message: `Self-test passed: ${CASES.length} cases validated (GPU simulation + extraction are consistent).`,
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Self-test exception:", e);
    return {
      ok: false,
      message: `Self-test error: ${safeToString(e?.message || e)}`,
    };
  }
}
