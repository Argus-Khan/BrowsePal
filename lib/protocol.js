/**
 * Shared protocol constants for the Browser Agent Bridge.
 * Used by background.js (ES modules) and content.js (injected as-is).
 */

// ─── Action types for page.act ──────────────────────────────────────────────
export const ACTION_TYPES = {
  SNAPSHOT:    "snapshot",
  CLICK:       "click",
  FILL:        "fill",
  PRESS:       "press",
  HOVER:       "hover",
  SCROLL:      "scroll",
  SCROLL_VIEW: "scrollIntoView",
  WAIT:        "wait",
  SELECT:      "select",
  EVAL:        "eval",
  SCREENSHOT:  "screenshot",
  READ:        "read",
  FOCUS:       "focus",
};

// ─── Event types for subscriptions ──────────────────────────────────────────
export const EVENT_TYPES = {
  DOM_MUTATION:    "dom.mutation",
  NETWORK_REQUEST: "network.request",
  NAVIGATION:      "navigation",
  ELEMENT_STATE:   "element.state",
  PAGE_LOADED:     "page.loaded",
};

// ─── Internal message types (background ↔ content script) ───────────────────
export const MSG = {
  // High-level (new)
  SNAPSHOT:        "ba:snapshot",
  ACT:             "ba:act",
  WATCH:           "ba:watch",
  UNWATCH:         "ba:unwatch",
  SUBSCRIBE:       "ba:subscribe",
  UNSUBSCRIBE:     "ba:unsubscribe",

  // Low-level (legacy, kept for power users)
  EVAL:            "ba:eval",
  GET_OUTER_HTML:  "ba:getOuterHTML",
  GET_TEXT:        "ba:getText",
  QUERY_SELECTOR:  "ba:querySelector",
  QUERY_ALL:       "ba:querySelectorAll",
  GET_VALUE:       "ba:getValue",
  SET_VALUE:       "ba:setValue",
  CLICK:           "ba:click",
  CLICK_BY_TEXT:   "ba:clickByText",
  HOVER:           "ba:hover",
  FOCUS:           "ba:focus",
  TYPE:            "ba:type",
  PRESS_KEY:       "ba:pressKey",
  SCROLL:          "ba:scroll",
  SCROLL_INTO:     "ba:scrollIntoView",
  WAIT_FOR:        "ba:waitFor",
  SCREENSHOT:      "ba:screenshot",
  NAVIGATE:        "ba:navigate",
  RELOAD:          "ba:reload",
  FRAMES:          "ba:frames",

  // Storage
  STORAGE:         "ba:storage",
  CACHE:           "ba:cache",
  INDEXED_DB:      "ba:indexedDB",

  // Events from content → background
  EVENT:           "ba:event",
};

// ─── Wait conditions ────────────────────────────────────────────────────────
export const WAIT_STATES = {
  VISIBLE:    "visible",
  HIDDEN:     "hidden",
  ATTACHED:   "attached",
  TEXT:       "text",
  NAVIGATION: "navigation",
};

// ─── Default config ─────────────────────────────────────────────────────────
export const DEFAULTS = {
  host: "127.0.0.1",
  port: 9222,
  token: "",
  allowRead: true,
  allowInteract: true,
  excludedUrls: [],
  disabled: false,
};

export const CONFIG_KEYS = ["host", "port", "token", "allowRead", "allowInteract", "excludedUrls", "disabled"];
