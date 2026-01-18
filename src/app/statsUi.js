/**
 * Stats (HUD) controller.
 *
 * Responsibilities:
 * - Update the generation/population readouts from the central state.
 * - Trigger any platform-specific pinning/layout work (e.g., iOS visualViewport).
 *
 * This module is intentionally small and deterministic. It does not register any
 * event listeners.
 */

/**
 * @typedef {Object} StatsControllerDeps
 * @property {{ sim: { generation: number, population: number } }} state
 * @property {HTMLElement | null} generationEl
 * @property {HTMLElement | null} populationEl
 * @property {() => void} [scheduleStatsViewportPin]
 */

/**
 * @param {StatsControllerDeps} deps
 */
export function createStatsController(deps) {
  const { state, generationEl, populationEl, scheduleStatsViewportPin } = deps;

  const schedule =
    typeof scheduleStatsViewportPin === "function" ? scheduleStatsViewportPin : () => {};

  function updateStats() {
    // These are UI elements; they may be absent in headless/test contexts.
    if (generationEl) generationEl.textContent = state.sim.generation.toLocaleString();
    if (populationEl) populationEl.textContent = state.sim.population.toLocaleString();
    schedule();
  }

  return { updateStats };
}
