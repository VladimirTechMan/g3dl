/**
 * GPU queue pacing helper.
 *
 * In fast-play modes, the CPU may submit simulation steps faster than the GPU can execute them.
 * This can increase input latency and, on some mobile browsers, lead to device loss due to
 * memory pressure from queued work.
 */

/**
 * Potentially await queue completion to keep the submission queue bounded.
 *
 * @param {import("../renderer.js").WebGPURenderer} r
 * @param {boolean} [force=false]
 */
export async function maybePace(r, force = false) {
  if (!r.device || !r.device.queue || typeof r.device.queue.onSubmittedWorkDone !== "function") {
    return;
  }

  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  const dueBySteps = r._stepsSincePace >= r._paceEveryNSteps;
  const dueByTime = now - r._lastPaceTimeMs >= r._paceMinIntervalMs;

  if (force || dueBySteps || dueByTime) {
    r._stepsSincePace = 0;
    r._lastPaceTimeMs = now;
    try {
      await r.device.queue.onSubmittedWorkDone();
    } catch (_) {
      // Ignore device-lost / transient failures; caller handles the overall error path.
    }
  }
}
