# Game of 3D Life

Game of 3D Life is a [3D cellular automaton](https://content.wolfram.com/sites/13/2018/02/01-3-1.pdf) inspired by [Conway's Game of Life](https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life), running in modern web browsers. Simulation and rendering run entirely on the GPU via [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API). This web app was intentionally built as "self-contained", not using any external frameworks, only the features of modern JavaScript, HTML and CSS.

For a bit of story behind the project, you can check [this LinkedIn post](https://www.linkedin.com/posts/vladimirtechman_webgpu-genai-cellular-activity-7414016801057067008-nl7_).

## Features

- **Configurable rules**: Customize survival and birth rules
- **WebGPU compute shaders**: Simulation runs entirely on the GPU for maximum performance
- **Instanced rendering**: Efficient rendering of hundreds of thousands of cubes
- **Interactive camera**: Rotate, pan, and zoom with mouse or touch
- **Screen show**: Optional cinematic camera autopilot while the simulation is running (Run). Disables user camera controls until turned off; uses 15–20s passes with brief fade transitions.
- **Lantern lighting**: Optional per-cell emissive lighting with subtle time-based flicker (continues even when the simulation is paused)
- **Copy URL with settings**: Generate a shareable URL snapshot of the current Settings values
- **Toroidal mode**: Optional wrap-around boundaries
- **Real-time stats**: Population and generation counters
- **Auto-stop when stable**: Optionally stop playback when the automaton reaches a static state
- **Device-aware grid limits**: UI clamps grid size to conservative limits based on WebGPU buffer limits, memory budget heuristics, and an interactive rendering cap.
- **Auto-suspend when not visible**: Stop simulation and rendering when the web app is hidden, to reduce resource and power usage

## Requirements

A browser with **WebGPU enabled**. In practice this means a recent:
- Chromium-based browser (Chrome / Edge)
- Safari (macOS/iOS) with WebGPU enabled/available
- Firefox with WebGPU enabled/available

Because [WebGPU availability](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API#browser_compatibility) changes quickly across versions and platforms, check your browser’s current feature status.

## Usage

Open `index.html` in a supported browser (must be served over HTTPS, even if from `localhost`). Check the Help panel for usage details.

**Note**: The maximum grid size depends on device WebGPU limits; the UI will attempt clamping the value accordingly.

To share a custom configuration, use the **Copy URL with settings** button at the bottom of the Settings panel.

## Navigation and keyboard shortcuts

- **Drag**: Rotate view
- **Shift+Drag** / **Alt+Drag** / **right-drag** or **2-finger drag**: Pan view
- **Scroll** or **Pinch**: Zoom
- **Space**: Run/Pause
- **S**: Step
- **R**: Reset
- **C**: Center view
- **B**: Reset camera
- **F**: Toggle fullscreen
- **Esc**: Exit fullscreen or close an open panel, if any

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

## Implementation notes

- **Correct rendering for dense states**: the living-cell instance list buffer is sized for the full grid (worst-case: all cells alive). This avoids silent truncation that can make rendering disagree with simulation results.
- **Resize correctness**: when the canvas backing size changes (resize/orientation/devicePixelRatio), the WebGPU canvas context is reconfigured and the depth buffer is recreated.
- **Responsiveness**: rendering is scheduled on-demand (invalidation-based) rather than continuously. In fast play mode, simulation steps are optionally paced using `queue.onSubmittedWorkDone()` to prevent unbounded GPU queue growth on slower/mobile devices.
- **Teardown (SPA embeds)**: `destroyApp()` (in `src/app/app.js`) stops timers/listeners and calls `renderer.destroy()` to proactively release GPU buffers/textures. This is defensive hygiene for apps that mount/unmount the simulator without a full page reload.

Rendering compacts live cells into a packed `u32` list for GPU-driven instanced drawing (10 bits per axis), so `gridSize` is additionally capped at 1024.

## Files

Top-level:
- `index.html` - Main HTML structure and UI
- `styles.css` - Styling
- `README.md` - Overview and developer notes

App source (ES module) under `src/`:
- `src/app/app.js` - App entrypoint; wires UI, input, and GPU renderer
- `src/app/state.js` - Centralized mutable app state and default values
- `src/app/settings.js` - Settings schema, URL import/export, and validation
- `src/app/loop.js` - Render/step orchestration (RAF + pacing + play loop)
- `src/app/selfTest/selfTestSuite.js` - Debug-only deterministic correctness suite (GPU vs CPU, plus extraction validation)

App input:
- `src/app/orbitControls.js` - Pointer/touch/mouse navigation state machine

App UI:
- `src/ui/dom.js` - Cached DOM element references
- `src/ui/bindings.js` - Stable `bindUI()` facade (delegates to controls/panels)
- `src/ui/controls.js` - Buttons/sliders/inputs/checkbox bindings
- `src/ui/panels.js` - Settings/Help/About panel UX + wheel capture policy

GPU contracts:
- `src/gpu/dataLayout.js` - Single source of truth for JS <-> WGSL buffer/uniform layouts

GPU engine:
- `src/gpu/renderer.js` - WebGPU simulation + rendering engine (public renderer API; orchestrates submodules)
- `src/gpu/renderer/*` - Renderer implementation split by concern (lifecycle, step encoding, render encoding, pacing, optional AABB queries)
- `src/gpu/rendererApi.js` - Runtime contract check to detect renderer API mismatches during refactors
- `src/gpu/shaders.js` - WGSL shader sources assembled from the data layout contract
- `src/gpu/pipelines/*` - Compute and render pipeline creation (async/lazy when possible)
- `src/gpu/resources/*` - GPU buffer lifecycle (grid/geometry/uniforms/bind groups, per-frame uniform updates)
- `src/gpu/readback.js` - Stats + population readback ring buffers (paced to avoid UI stalls)
- `src/gpu/util/bufferManager.js` - Centralized CPU→GPU writes with layout-aware debug validation
- `src/gpu/cameraControls.js` - Pointer-driven camera controls + inertia + Screen show override plumbing

Shared utilities:
- `src/util/math3d.js` - Small allocation-free 3D math helpers (mat4/quats) used by camera + uniforms
- `src/util/log.js` - Logging helpers; debug logging is enabled via `?debug=...` URL flag

## Shader sources

WGSL shader code is centralized in `shaders.js` to make bindings and structs easier to audit and keep `renderer.js` focused on WebGPU setup and orchestration.

## Buffer layout contract (dataLayout.js)

`src/gpu/dataLayout.js` defines the authoritative JS↔WGSL buffer layouts (uniform/params/indirect/AABB), including field offsets and the WGSL struct definitions used by the shader generators.

Debug-only runtime checks can be enabled with `?debug=1`, `?debug=true`, or simply `?debug` in the URL.

## CPU→GPU write helpers

All CPU-to-GPU writes use small helper methods in `renderer.js` (`_queueWrite*`), rather than calling
`device.queue.writeBuffer()` directly. A reusable scratch `ArrayBuffer` backs small parameter writes
to avoid per-step allocations (important for UI responsiveness on mobile browsers)

When debug checks are enabled (`?debug=1` / `?debug=true`), the write helpers additionally validate:
- 4-byte alignment requirements for `writeBuffer()` offsets and sizes
- that each write stays within the expected GPUBuffer size (buffers are registered via `this._createBuffer()`)

This catches layout/offset mistakes early, before they manifest as platform-specific rendering or simulation errors.

## Code structure (ES modules)

This project uses native browser ES modules (no bundler). The page loads a single module entrypoint:

- `src/app/app.js` — application controller (UI wiring, input, main loop)

Key modules:

- `src/gpu/renderer.js` — `WebGPURenderer` (WebGPU simulation + rendering engine)
- `src/gpu/dataLayout.js` — `G3DL_LAYOUT` (authoritative JS <-> WGSL buffer layout contract)
- `src/gpu/shaders.js` — `G3DL_SHADERS` (centralized WGSL sources; imports `G3DL_LAYOUT`)

### Debug checks and self-test

Developer option to validate buffer layouts between JS and WGSL. The same flag also enables
additional debug-only console logging and exposes a **Self-test** button in the Settings panel.

Enable debug mode with:
- `?debug=1` / `?debug=true` / `?debug` in the URL

Debug mode is intentionally **URL-scoped** (not persisted) to avoid surprising "sticky" debug
output after a temporary debug session.

#### Self-test

When debug mode is enabled, the Settings panel shows a **Self-test** button. Clicking it runs a
deterministic correctness suite that compares:

- GPU simulation results vs a CPU reference implementation (same rules and boundary mode)
- GPU extraction/compaction (live-cell list + population counter) vs the simulated grid

The self-test module is dynamically imported only when the button is clicked to keep normal
startup and runtime overhead minimal.
