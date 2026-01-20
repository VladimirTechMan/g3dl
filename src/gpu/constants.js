/**
 * GPU-wide constants.
 *
 * These values are part of the renderer <-> shader data contract. Keeping them in
 * a dedicated module avoids duplication and reduces the chance of accidental drift
 * during refactors.
 */

// Packed cell coordinate format: 10 bits per axis.
//
// The GPU compaction path stores live cell coordinates in a single u32:
//   x (10 bits) | y (10 bits) << 10 | z (10 bits) << 20
//
// This supports coordinates 0..1023, so gridSize must be <= 1024.
// Intentionally module-private: shaders and consumers should only rely on
// MAX_PACKED_GRID_SIZE as the public contract.
const PACKED_CELL_AXIS_BITS = 10;
export const MAX_PACKED_GRID_SIZE = 1 << PACKED_CELL_AXIS_BITS;
