/**
 * Shared, UI-facing helpers for input validation and keyboard behavior.
 *
 * These helpers are intentionally tiny and DOM-centric so they can be reused
 * across small controller modules without creating heavy coupling.
 */

/**
 * Toggle invalid UI state on an input wrapper.
 *
 * @param {HTMLElement | null} wrapper
 * @param {boolean} isInvalid
 */
export function setInvalid(wrapper, isInvalid) {
  if (!wrapper) return;
  wrapper.classList.toggle("invalid", isInvalid);
}

/**
 * Handle Enter key on an input by blurring it, which triggers 'change' handlers.
 *
 * @param {KeyboardEvent} e
 * @param {HTMLInputElement} input
 */
export function blurOnEnter(e, input) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  input.blur();
}
