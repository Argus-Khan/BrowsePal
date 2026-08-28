/**
 * Single source of truth for default configuration values.
 * Used by background.js, options.js, and ws.js.
 */
export const DEFAULTS = {
  url: "ws://127.0.0.1:9222",
  token: "",
  autoReconnect: true,
  allowRead: true,
  allowInteract: true,
  excludedUrls: [],
  disabled: false,
};

/**
 * Allowed keys for agent.config.set RPC method.
 */
export const CONFIG_KEYS = ["url", "token", "autoReconnect", "allowRead", "allowInteract", "excludedUrls", "disabled"];
