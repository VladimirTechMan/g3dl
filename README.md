# Game of 3D Life

Game of 3D Life is a [3D cellular automaton](https://content.wolfram.com/sites/13/2018/02/01-3-1.pdf) inspired by [Conway's Game of Life](https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life), running in modern web browsers. Simulation and rendering run entirely on the GPU via [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).

## Features

- **3D Cellular Automaton**: Extends the classic 2D rules into 3D space
- **WebGPU Compute Shaders**: Simulation runs entirely on the GPU for maximum performance
- **Instanced Rendering**: Efficient rendering of hundreds of thousands of cubes
- **Configurable Rules**: Customize survival and birth rules
- **Interactive Camera**: Rotate, pan, and zoom with mouse or touch
- **Copy URL with settings**: Generate a shareable URL snapshot of the current Settings values
- **Lantern Lighting**: Optional per-cell emissive lighting with subtle time-based flicker (continues even when the simulation is paused)
- **Screen show**: Optional cinematic camera autopilot while the simulation is running (Run). Disables user camera controls until turned off; uses 15–20s passes with brief fade transitions.
- **Toroidal Mode**: Optional wrap-around boundaries
- **Real-time Stats**: Population and generation counters
- **Auto-stop When Stable**: Optionally stop playback when the automaton reaches a static state
- **Device-aware Grid Limits**: UI clamps grid size to conservative limits based on WebGPU buffer limits, memory budget heuristics, and an interactive rendering cap.

## Files

Top-level:
- `index.html` - Main HTML structure and UI
- `styles.css` - Styling
- `README.md` - Overview and developer notes

Source (ES modules) under `src/`:
- `src/app/app.js` - App entrypoint; wires UI, input, and GPU renderer
- `src/app/state.js` - Centralized mutable app state and default values
- `src/app/settings.js` - Settings schema, URL import/export, and validation
- `src/app/loop.js` - Render/step orchestration (RAF + pacing + play loop)

UI:
- `src/ui/dom.js` - Cached DOM element references
- `src/ui/bindings.js` - Stable `bindUI()` facade (delegates to controls/panels)
- `src/ui/controls.js` - Buttons/sliders/inputs/checkbox bindings
- `src/ui/panels.js` - Settings/Help/About panel UX + wheel capture policy

Input:
- `src/app/orbitControls.js` - Pointer/touch/mouse navigation state machine

GPU contracts:
- `src/gpu/dataLayout.js` - Single source of truth for JS <-> WGSL buffer/uniform layouts

GPU engine:
- `src/gpu/renderer.js` - WebGPU simulation + rendering engine (public renderer API; orchestrates submodules)
- `src/gpu/shaders.js` - WGSL shader sources assembled from the data layout contract
- `src/gpu/pipelines/*` - Compute and render pipeline creation (async/lazy when possible)
- `src/gpu/resources/*` - GPU buffer lifecycle (grid/geometry/uniforms/bind groups, per-frame uniform updates)
- `src/gpu/readback.js` - Stats + population readback ring buffers (paced to avoid UI stalls)
- `src/gpu/util/bufferManager.js` - Centralized CPU→GPU writes with layout-aware debug validation
- `src/gpu/cameraControls.js` - Pointer-driven camera controls + inertia + Screen show override plumbing

Shared utilities:
- `src/util/math3d.js` - Small allocation-free 3D math helpers (mat4/quats) used by camera + uniforms

## Requirements

A browser with **WebGPU enabled**. In practice this means a recent:
- Chromium-based browser (Chrome / Edge)
- Safari (macOS/iOS) with WebGPU enabled/available
- Firefox with WebGPU enabled/available

Because WebGPU availability changes quickly across versions and platforms, prefer checking your browser’s feature status (e.g., the browser’s WebGPU/WebGL diagnostics page) rather than relying on hard-coded version numbers.

## Usage

Open `index.html` in a supported browser (must be served over HTTPS, even if from `localhost`).

Note: The maximum grid size depends on device WebGPU limits; the UI will attempt clamping the value accordingly.

Rendering compacts live cells into a packed `u32` list for GPU-driven instanced drawing (10 bits per axis), so `gridSize` is additionally capped at 1024.

To share a configuration, use the **Copy URL with settings** button at the bottom of the Settings panel.

## Implementation notes

- **Correct rendering for dense states**: the living-cell instance list buffer is sized for the full grid (worst-case: all cells alive). This avoids silent truncation that can make rendering disagree with simulation results.
- **Resize correctness**: when the canvas backing size changes (resize/orientation/devicePixelRatio), the WebGPU canvas context is reconfigured and the depth buffer is recreated.
- **Responsiveness**: rendering is scheduled on-demand (invalidation-based) rather than continuously. In fast play mode, simulation steps are optionally paced using `queue.onSubmittedWorkDone()` to prevent unbounded GPU queue growth on slower/mobile devices.
- **Teardown (SPA embeds)**: `destroyApp()` (in `src/app/app.js`) stops timers/listeners and calls `renderer.destroy()` to proactively release GPU buffers/textures. This is defensive hygiene for apps that mount/unmount the simulator without a full page reload.

## Navigation and keyboard shortcuts

- **Drag**: Rotate view
- **Shift+Drag** / **Alt+Drag** / **right-drag** or **2-finger drag**: Pan view
- **Scroll** or **Pinch**: Zoom
- **Space**: Play/Pause
- **S**: Step
- **R**: Reset
- **C**: Center view
- **B**: Reset camera

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

## Shader sources

WGSL shader code is centralized in `shaders.js` to make bindings and structs easier to audit and keep `renderer.js` focused on WebGPU setup and orchestration.

## Buffer layout contract (dataLayout.js)

`src/gpu/dataLayout.js` defines the authoritative JS↔WGSL buffer layouts (uniform/params/indirect/AABB), including field offsets and the WGSL struct definitions used by the shader generators.

Debug-only runtime checks can be enabled with `?debug=1` in the URL (or by setting `localStorage.g3dl_debug = "1"`).

## CPU→GPU write helpers

All CPU-to-GPU writes use small helper methods in `renderer.js` (`_queueWrite*`), rather than calling
`device.queue.writeBuffer()` directly. A reusable scratch `ArrayBuffer` backs small parameter writes
to avoid per-step allocations (important for UI responsiveness on mobile browsers)

When debug checks are enabled (`?debug=1`), the write helpers additionally validate:
- 4-byte alignment requirements for `writeBuffer()` offsets and sizes
- that each write stays within the expected GPUBuffer size (buffers are registered via `this._createBuffer()`)

This catches layout/offset mistakes early, before they manifest as platform-specific rendering or simulation errors..

## Code structure (ES modules)

This project uses native browser ES modules (no bundler). The page loads a single module entrypoint:

- `src/app/app.js` — application controller (UI wiring, input, main loop)

Key modules:

- `src/gpu/renderer.js` — `WebGPURenderer` (WebGPU simulation + rendering engine)
- `src/gpu/dataLayout.js` — `G3DL_LAYOUT` (authoritative JS <-> WGSL buffer layout contract)
- `src/gpu/shaders.js` — `G3DL_SHADERS` (centralized WGSL sources; imports `G3DL_LAYOUT`)

### Debug checks

Developer option to validate buffer layouts between JS and WGSL. Enable extra assertions with:
- `?debug=1` in the URL, or
- `localStorage.g3dl_debug = "1"` (then reload)

Debug mode can reduce performance and is not intended for normal use.
