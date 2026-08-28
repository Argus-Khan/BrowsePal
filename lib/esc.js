/**
 * Shared HTML escape utility.
 * Used by popup.js and options.js.
 */
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
