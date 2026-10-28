/**
 * Browser Agent Bridge — console capture, MAIN world.
 *
 * Declared in the manifest with "world": "MAIN" and "run_at": "document_start"
 * so it runs inside the page's own execution world. An ISOLATED-world content
 * script (content.js) shares the DOM but not the page's globals, so it can
 * never see the page's console.* calls — this hook is what makes console.* work.
 *
 * Entries cross to content.js over a DOM CustomEvent, the only channel both
 * worlds share. Until content.js attaches (document_idle) entries are also held
 * in `bootstrap` and replayed when content.js dispatches a flush, so messages
 * logged during page load survive.
 *
 * Requires Chrome 111+ (manifest minimum_chrome_version) / Firefox 128+
 * (manifest-firefox strict_min_version) for "world": "MAIN".
 */
(() => {
  "use strict";
  if (window.__babConsoleCapture) return;
  window.__babConsoleCapture = true;

  const ENTRY_EVENT = "bab:console";
  const FLUSH_EVENT = "bab:console-flush";
  // Matches the buffer content.js keeps, so "history since page load" still
  // holds on pages that log heavily before content.js attaches at document_idle.
  const BOOTSTRAP_MAX = 1000;
  const MAX_TEXT = 2000;

  let seq = 0;
  let flushed = false;
  const bootstrap = [];

  function fmtArg(a) {
    try {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "function") return "[Function " + (a.name || "anonymous") + "]";
      if (typeof a === "object" && a !== null) return JSON.stringify(a);
      return String(a);
    } catch (e) {
      return "[unserializable]";
    }
  }

  /** Drop our own frames — a captured stack is about the page, not this file. */
  function cleanStack(stack) {
    if (!stack) return null;
    const lines = stack.split("\n").filter((l) => l.indexOf("console-capture") === -1);
    return lines.length ? lines.join("\n") : null;
  }

  /**
   * Never throws: a page must not lose its console, or break outright, because
   * this hook choked on a hostile object.
   */
  function record(level, args, extra) {
    try {
      let text;
      try {
        text = Array.prototype.map.call(args, fmtArg).join(" ");
      } catch (e) {
        text = "[unserializable]";
      }
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "…";

      const entry = {
        seq: ++seq,
        ts: Date.now(),
        level: level,
        url: location.href,
        text: text,
        line: (extra && extra.line) || null,
        col: (extra && extra.col) || null,
        source: (extra && extra.source) || null,
        stack: cleanStack(extra && extra.stack),
      };
      if (!flushed && bootstrap.length < BOOTSTRAP_MAX) bootstrap.push(entry);
      window.dispatchEvent(new CustomEvent(ENTRY_EVENT, { detail: entry }));
    } catch (e) { /* never propagate into the page */ }
  }

  function callerStack() {
    try { return new Error().stack; } catch (e) { return null; }
  }

  // ─── Wrap console.* ─────────────────────────────────────────────────────
  //
  // Each assignment is guarded: a frozen or already-wrapped method must not
  // abort this IIFE, or the error listeners and the flush replay installed
  // further down never get registered and pre-load history is lost for good.

  const LEVELS = ["log", "info", "warn", "error", "debug", "trace", "table", "dir"];
  for (const name of LEVELS) {
    try {
      const orig = console[name];
      if (typeof orig !== "function") continue;
      console[name] = function () {
        record(name, arguments, name === "trace" ? { stack: callerStack() } : null);
        return orig.apply(console, arguments);
      };
    } catch (e) { /* skip this level */ }
  }

  try {
    if (typeof console.assert === "function") {
      const origAssert = console.assert;
      console.assert = function (cond) {
        if (!cond) {
          const rest = Array.prototype.slice.call(arguments, 1);
          record("assert", rest.length ? rest : ["Assertion failed"], null);
        }
        return origAssert.apply(console, arguments);
      };
    }
  } catch (e) { /* skip */ }

  // ─── Uncaught errors ────────────────────────────────────────────────────

  window.addEventListener("error", (ev) => {
    record("error", [ev.message || "Uncaught error"], {
      stack: ev.error && ev.error.stack ? ev.error.stack : null,
      line: ev.lineno,
      col: ev.colno,
      source: ev.filename,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    record("error", ["Unhandled promise rejection: " + fmtArg(ev.reason)], null);
  });

  // ─── Replay for content.js ──────────────────────────────────────────────
  //
  // Trust model: this channel is the page's own window, so a hostile page can
  // dispatch "bab:console" itself or defeat capture by reassigning console.*.
  // That is not a privilege it gains — it already owns its own console. Treat
  // captured output as untrusted page data (it always was).

  window.addEventListener(FLUSH_EVENT, () => {
    if (flushed) return;
    flushed = true;
    for (let i = 0; i < bootstrap.length; i++) {
      try {
        window.dispatchEvent(new CustomEvent(ENTRY_EVENT, { detail: bootstrap[i] }));
      } catch (e) { /* ignore */ }
    }
    bootstrap.length = 0;
  });
})();
