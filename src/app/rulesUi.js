/**
 * Rules UI controller.
 *
 * Responsibilities:
 * - Sanitize and validate the Survival/Birth rule text inputs.
 * - Apply valid rules to the renderer.
 * - Maintain preset select state (including matching manual inputs back to a preset).
 * - Emit user-visible warnings only on "commit" events (blur/change), not on every keystroke.
 *
 * This module intentionally does not attach DOM listeners. It exposes handler functions
 * that are wired by app.js via ui/bindings.js.
 */

import { RULE_PRESETS, normalizeRule } from "./settings.js";
import { parseRuleNumbers } from "./ruleParse.js";
import { setInvalid } from "./domHelpers.js";

/**
 * @typedef {import("../gpu/renderer.js").WebGPURenderer} WebGPURenderer
 */

/**
 * Create a controller for rule-related UI.
 *
 * @param {{
 *  surviveInput: HTMLInputElement|null,
 *  birthInput: HTMLInputElement|null,
 *  presetSelect: HTMLSelectElement|null,
 *  getRenderer: () => WebGPURenderer|null,
 *  toast: { show: (o: { kind: "info"|"warn"|"error", message: string }) => void }|null,
 *  uiMsg: any,
 *  presets?: Record<string, { survive: string, birth: string }>
 * }} opts
 */
export function createRulesController(opts) {
  const {
    surviveInput,
    birthInput,
    presetSelect,
    getRenderer,
    toast,
    uiMsg,
    presets = RULE_PRESETS,
  } = opts || {};

  const hasDom = !!(surviveInput && birthInput && presetSelect);
  const getSafeRenderer =
    typeof getRenderer === "function" ? getRenderer : () => null;

  /**
   * Parse and apply Survival/Birth rules to the renderer.
   *
   * This is intentionally defensive: even if called accidentally with an invalid
   * string, it must never do unbounded work (e.g., expanding a huge range).
   */
  function parseRules() {
    if (!hasDom) return;

    const renderer = getSafeRenderer();
    if (!renderer) return;

    const surviveParsed = parseRuleNumbers(surviveInput.value);
    const birthParsed = parseRuleNumbers(birthInput.value);

    if (
      !surviveParsed.hasError &&
      surviveParsed.isNonEmpty &&
      surviveParsed.values.length > 0
    ) {
      renderer.setSurviveRule(surviveParsed.values);
    }

    if (!birthParsed.hasError && birthParsed.isNonEmpty && birthParsed.values.length > 0) {
      renderer.setBirthRule(birthParsed.values);
    }
  }

  /**
   * Validate and sanitize rule input.
   *
   * Rules:
   * - Allow digits, commas, spaces, and hyphens.
   * - Clamp values to 0..26.
   * - Reject descending ranges and malformed patterns.
   *
   * Blank input is treated as "not applied" (not visually invalid).
   *
   * @param {HTMLInputElement} input
   * @param {{ allowTrailingHyphen?: boolean }=} opts
   */
  function validateRuleInput(input, opts = undefined) {
    const parsed = parseRuleNumbers(input.value, opts);

    // Update the input value to sanitized version (remove invalid chars only)
    if (input.value !== parsed.sanitized) {
      input.value = parsed.sanitized;
    }

    const isValid = !parsed.hasError && parsed.isNonEmpty;

    // Update visual feedback:
    // - Blank input is treated as "not applied" but not visually invalid.
    setInvalid(input.parentElement, !(isValid || parsed.sanitized.trim() === ""));

    return isValid;
  }

  /**
   * Handle preset selection change.
   */
  function handlePresetChange() {
    if (!hasDom) return;

    const preset = presetSelect.value;
    if (preset !== "custom" && presets[preset]) {
      surviveInput.value = presets[preset].survive;
      birthInput.value = presets[preset].birth;
      setInvalid(surviveInput.parentElement, false);
      setInvalid(birthInput.parentElement, false);
      parseRules();
    }
  }

  /**
   * Handle manual rule input change.
   *
   * This handler is bound to both:
   * - `input`: live validation / preset matching (no toast feedback)
   * - `change`: commit/blur (safe place for user-visible warnings)
   *
   * @param {Event|undefined|null} e
   */
  function handleRuleInputChange(e) {
    if (!hasDom) return;

    const isCommit = !!(e && /** @type {any} */ (e).type === "change");
    const parseOpts = { allowTrailingHyphen: !isCommit };

    // Validate inputs (sanitizes and updates invalid highlighting).
    const surviveValid = validateRuleInput(surviveInput, parseOpts);
    const birthValid = validateRuleInput(birthInput, parseOpts);

    // Parse again after sanitization so error detection matches the current value.
    const surviveParsed = parseRuleNumbers(surviveInput.value, parseOpts);
    const birthParsed = parseRuleNumbers(birthInput.value, parseOpts);

    // Invalid values (out of range, descending ranges, etc.).
    if (surviveParsed.hasError || birthParsed.hasError) {
      presetSelect.value = "custom";

      // Avoid spamming while typing; only toast on commit/blur.
      if (isCommit && toast && uiMsg) {
        const which = [
          surviveParsed.hasError ? "Survival" : null,
          birthParsed.hasError ? "Birth" : null,
        ]
          .filter(Boolean)
          .join(" and ");

        toast.show({
          kind: "warn",
          message: uiMsg.rules.invalid(which),
        });
      }

      return;
    }

    // Blank input is treated as "not applied" (no error), but it's not a valid rule.
    // Preserve the existing behavior: do not apply, and switch to custom.
    if (!surviveValid || !birthValid) {
      presetSelect.value = "custom";
      return;
    }

    // Normalize current values for comparison
    const currentSurvive = normalizeRule(surviveInput.value);
    const currentBirth = normalizeRule(birthInput.value);

    let matchedPreset = "custom";
    for (const [key, value] of Object.entries(presets)) {
      const presetSurvive = normalizeRule(value.survive);
      const presetBirth = normalizeRule(value.birth);
      if (presetSurvive === currentSurvive && presetBirth === currentBirth) {
        matchedPreset = key;
        break;
      }
    }

    presetSelect.value = matchedPreset;
    parseRules();
  }

  /**
   * Handle Enter key in rule inputs by committing via blur.
   *
   * @param {KeyboardEvent} e
   */
  function handleRuleKeydown(e) {
    if (!e) return;
    if (e.key === "Enter") {
      e.preventDefault();
      // Apply via the 'change' event that fires on blur.
      /** @type {any} */ (e).target?.blur?.();
    }
  }

  return {
    handlePresetChange,
    handleRuleInputChange,
    handleRuleKeydown,

    // Exposed mostly for tests/future debug tooling.
    _parseRules: parseRules,
    _validateRuleInput: validateRuleInput,
  };
}
