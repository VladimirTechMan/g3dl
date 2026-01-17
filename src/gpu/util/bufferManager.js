import { G3DL_LAYOUT } from "../dataLayout.js";
import { warn } from "../../util/log.js";
import { LOG_MSG } from "../../util/messages.js";

/**
 * BufferManager
 *
 * Centralizes:
 *  - GPUBuffer creation (and optional debug metadata registration)
 *  - scratch-backed TypedArray views for small parameter updates
 *  - validated CPU→GPU queue.writeBuffer() calls
 *
 * Notes on scratch:
 *  - queue.writeBuffer() copies synchronously from the provided ArrayBufferView.
 *    Reusing a single scratch ArrayBuffer across sequential writes is safe.
 */
export class BufferManager {
  constructor() {
    /** @type {GPUDevice|null} */
    this.device = null;

    // Debug metadata for size checking CPU→GPU writes.
    /** @type {WeakMap<GPUBuffer, {name:string, byteLength:number, usage:number}>} */
    this._bufferMeta = new WeakMap();
    this._warnedUnregisteredWrite = false;

    // Scratch storage for small param updates.
    /** @type {ArrayBuffer|null} */
    this._scratch = null;
    /** @type {Uint32Array|null} */
    this._scratchU32 = null;
  }

  /**
   * Attach the GPUDevice used for buffer creation and writes.
   *
   * @param {GPUDevice|null} device
   */
  setDevice(device) {
    this.device = device || null;
  }

  /**
   * Release references held by this manager.
   *
   * WebGPU resources are owned by the renderer. This method exists to support
   * renderer.destroy() for SPA-style unmounts (where we want to allow garbage
   * collection of JS-side objects promptly).
   */
  destroy() {
    this.device = null;
    this._scratch = null;
    this._scratchU32 = null;

    // Reset debug bookkeeping.
    this._bufferMeta = new WeakMap();
    this._warnedUnregisteredWrite = false;
  }

  _assertDevice() {
    if (!this.device) throw new Error("WebGPU device not initialized.");
  }

  /**
   * Register buffer metadata for debug-time validation.
   *
   * @param {GPUBuffer} buffer
   * @param {string} name
   * @param {number} byteLength
   * @param {number} usage
   */
  registerBuffer(buffer, name, byteLength, usage) {
    if (!buffer) return;
    this._bufferMeta.set(buffer, {
      name: String(name || "unnamedBuffer"),
      byteLength: Number(byteLength) || 0,
      usage: usage ?? 0,
    });
  }

  /**
   * Create a GPUBuffer and register metadata for debug builds.
   *
   * @param {string} name
   * @param {GPUBufferDescriptor} desc
   * @returns {GPUBuffer}
   */
  createBuffer(name, desc) {
    this._assertDevice();
    if (!desc || typeof desc.size !== "number") {
      throw new TypeError(
        `Invalid createBuffer() descriptor for ${name || "buffer"} (missing numeric size).`,
      );
    }
    const buffer = this.device.createBuffer(desc);
    this.registerBuffer(buffer, name, desc.size, desc.usage);
    return buffer;
  }

  _ensureScratchBytes(minBytes) {
    if (this._scratch && this._scratch.byteLength >= minBytes) return;
    const cur = this._scratch ? this._scratch.byteLength : 0;
    const next = Math.max(256, minBytes, cur ? cur * 2 : 256);
    this._scratch = new ArrayBuffer(next);
    this._scratchU32 = new Uint32Array(this._scratch);
  }

  /**
   * Return a scratch Uint32Array view of length `count`.
   *
   * @param {number} count
   * @returns {Uint32Array}
   */
  scratchU32View(count) {
    this._ensureScratchBytes(count * 4);
    // eslint-disable-next-line no-non-null-assertion
    return this._scratchU32.subarray(0, count);
  }

  /**
   * Validated CPU→GPU write.
   *
   * @param {GPUBuffer} buffer
   * @param {number} offsetBytes
   * @param {ArrayBufferView} view
   */
  queueWrite(buffer, offsetBytes, view) {
    this._assertDevice();
    if (!ArrayBuffer.isView(view)) {
      throw new TypeError("writeBuffer() expects an ArrayBufferView (TypedArray or DataView).");
    }

    if (G3DL_LAYOUT.DEBUG) {
      if (!Number.isInteger(offsetBytes) || offsetBytes < 0) {
        throw new RangeError(`Invalid writeBuffer offset: ${offsetBytes}`);
      }
      // WebGPU requires writeBuffer offset and size be multiples of 4 bytes.
      if ((offsetBytes & 3) !== 0) {
        throw new RangeError(`writeBuffer offset must be 4-byte aligned (got ${offsetBytes}).`);
      }
      if ((view.byteLength & 3) !== 0) {
        throw new RangeError(`writeBuffer size must be a multiple of 4 bytes (got ${view.byteLength}).`);
      }

      const meta = this._bufferMeta.get(buffer);
      if (meta && meta.byteLength) {
        const end = offsetBytes + view.byteLength;
        if (end > meta.byteLength) {
          const name = meta.name || "unnamedBuffer";
          throw new RangeError(
            `CPU→GPU write overflow: ${name} size=${meta.byteLength} bytes, ` +
              `write=[${offsetBytes}..${end}) (${view.byteLength} bytes).`,
          );
        }
      } else if (!this._warnedUnregisteredWrite) {
        this._warnedUnregisteredWrite = true;
        warn(LOG_MSG.BUFFER_UNREGISTERED_WRITE);
      }
    }

    this.device.queue.writeBuffer(buffer, offsetBytes, view);
  }

  /**
   * @param {GPUBuffer} buffer
   * @param {number} offsetBytes
   * @param {Uint32Array} u32View
   */
  queueWriteU32(buffer, offsetBytes, u32View) {
    if (!(u32View instanceof Uint32Array)) {
      throw new TypeError("Expected Uint32Array for u32 writeBuffer().");
    }
    this.queueWrite(buffer, offsetBytes, u32View);
  }

  /**
   * @param {GPUBuffer} buffer
   * @param {number} offsetBytes
   * @param {Float32Array} f32View
   */
  queueWriteF32(buffer, offsetBytes, f32View) {
    if (!(f32View instanceof Float32Array)) {
      throw new TypeError("Expected Float32Array for f32 writeBuffer().");
    }
    this.queueWrite(buffer, offsetBytes, f32View);
  }
}
