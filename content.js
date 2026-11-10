(() => {
  "use strict";

  // ─── Guard ─────────────────────────────────────────────────────────────
  if (window.__browserAgentBridge) return;
  window.__browserAgentBridge = true;

  // ─── Constants ─────────────────────────────────────────────────────────

  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "meta", "link", "head",
    "br", "hr", "wbr", "source", "track",
  ]);

  const DEFAULT_MAX_DEPTH = 3;
  const MAX_CHILDREN_PER_NODE = 50;
  const MAX_TEXT_LENGTH = 200;
  const SPATIAL_MATCH_THRESHOLD = 80;

  // ─── Module State ──────────────────────────────────────────────────────

  let refMap = new Map();
  let refCounter = 0;
  let lastSnapshot = null;

  const watchers = new Map();
  const subscriptions = new Map();

  // ─── Helpers ───────────────────────────────────────────────────────────

  function ok(v) { return { ok: v }; }
  function err(m) { return { err: m }; }

  const escapeCSS = typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape
    : (s) => s.replace(/([^\w-])/g, "\\$1");

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function serialize(value) {
    if (value === undefined) return null;
    if (value && typeof value === "object" && value.nodeType) return describeNode(value);
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    try { JSON.stringify(value); return value; }
    catch (e) { return String(value); }
  }

  // ─── Expr DSL BEGIN ─────────────────────────────────────────────────────
  // Whitelisted expression evaluator (no Function/eval). Supports:
  //   literals, identifiers, ., ?., [], calls, !, !!, &&, ||, comparisons,
  //   typeof, parentheses, arrays, object literals.
  // Roots: document, window, location, navigator, Math, JSON, Number, String,
  // Boolean, Array, Object, Date, localStorage, sessionStorage, history,
  // performance, undefined, NaN, Infinity, true/false/null.
  function evalExpr(code, roots) {
    if (typeof code !== "string") throw new Error("code must be a string");
    var src = code.replace(/^\uFEFF/, "").trim();
    if (!src) throw new Error("empty expression");
    if (src.charAt(src.length - 1) === ";") src = src.slice(0, -1).trim();
    var i = 0;
    function peek() { return src.charAt(i); }
    function next() { return src.charAt(i++); }
    function skip() {
      while (i < src.length) {
        var c = peek();
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
        if (c === "/" && src.charAt(i + 1) === "/") {
          i += 2;
          while (i < src.length && peek() !== "\n") i++;
          continue;
        }
        break;
      }
    }
    function match(s) {
      skip();
      if (src.slice(i, i + s.length) === s) { i += s.length; return true; }
      return false;
    }
    function expect(s) {
      if (!match(s)) throw new Error("expected '" + s + "' at " + i);
    }
    function isIdentStart(c) {
      return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
    }
    function isIdent(c) {
      return isIdentStart(c) || (c >= "0" && c <= "9");
    }
    function parseIdent() {
      skip();
      if (!isIdentStart(peek())) throw new Error("expected identifier at " + i);
      var start = i;
      i++;
      while (isIdent(peek())) i++;
      return src.slice(start, i);
    }
    function parseString() {
      skip();
      var q = next();
      if (q !== "\"" && q !== "'") throw new Error("expected string at " + (i - 1));
      var out = "";
      while (i < src.length) {
        var c = next();
        if (c === q) return out;
        if (c === "\\") {
          var e = next();
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else out += e;
        } else out += c;
      }
      throw new Error("unterminated string");
    }
    function parseNumber() {
      skip();
      var start = i;
      if (peek() === ".") { /* fraction only */ }
      else if (peek() < "0" || peek() > "9") throw new Error("expected number at " + i);
      while (peek() >= "0" && peek() <= "9") i++;
      if (peek() === ".") {
        i++;
        while (peek() >= "0" && peek() <= "9") i++;
      }
      if (peek() === "e" || peek() === "E") {
        i++;
        if (peek() === "+" || peek() === "-") i++;
        while (peek() >= "0" && peek() <= "9") i++;
      }
      return Number(src.slice(start, i));
    }
    function parseArgs() {
      var args = [];
      skip();
      if (peek() === ")") return args;
      for (;;) {
        args.push(parseOr());
        if (!match(",")) break;
      }
      return args;
    }
    function parsePrimary() {
      skip();
      if (match("(")) {
        var v = parseOr();
        expect(")");
        return v;
      }
      if (match("[")) {
        var arr = [];
        skip();
        if (!match("]")) {
          for (;;) {
            arr.push(parseOr());
            if (!match(",")) break;
          }
          expect("]");
        }
        return arr;
      }
      if (match("{")) {
        var obj = {};
        skip();
        if (!match("}")) {
          for (;;) {
            skip();
            var key;
            if (peek() === "\"" || peek() === "'") key = parseString();
            else key = parseIdent();
            expect(":");
            obj[key] = parseOr();
            if (!match(",")) break;
          }
          expect("}");
        }
        return obj;
      }
      if (peek() === "\"" || peek() === "'") return parseString();
      if ((peek() >= "0" && peek() <= "9") || (peek() === "." && src.charAt(i + 1) >= "0" && src.charAt(i + 1) <= "9"))
        return parseNumber();
      if (isIdentStart(peek())) {
        var id = parseIdent();
        if (id === "true") return true;
        if (id === "false") return false;
        if (id === "null") return null;
        if (id === "undefined") return undefined;
        if (id === "NaN") return NaN;
        if (id === "Infinity") return Infinity;
        if (!Object.prototype.hasOwnProperty.call(roots, id))
          throw new Error("unknown identifier: " + id);
        return roots[id];
      }
      throw new Error("unexpected token at " + i + ": '" + peek() + "'");
    }
    function callValue(fn, thisArg, args) {
      if (typeof fn !== "function") throw new Error("not a function");
      return fn.apply(thisArg, args);
    }
    function parsePostfix() {
      var val = parsePrimary();
      for (;;) {
        skip();
        if (match("?\.")) {
          if (match("[")) {
            var k1 = parseOr();
            expect("]");
            val = (val == null) ? undefined : val[k1];
            continue;
          }
          if (match("(")) {
            var a1 = parseArgs();
            expect(")");
            val = (val == null) ? undefined : callValue(val, undefined, a1);
            continue;
          }
          var p1 = parseIdent();
          skip();
          if (match("(")) {
            var a2 = parseArgs();
            expect(")");
            val = (val == null) ? undefined : callValue(val[p1], val, a2);
          } else {
            val = (val == null) ? undefined : val[p1];
          }
          continue;
        }
        if (match(".")) {
          var prop = parseIdent();
          skip();
          if (match("(")) {
            var a3 = parseArgs();
            expect(")");
            val = callValue(val[prop], val, a3);
          } else {
            val = val == null ? val : val[prop];
          }
          continue;
        }
        if (match("[")) {
          var k2 = parseOr();
          expect("]");
          val = val == null ? val : val[k2];
          continue;
        }
        if (match("(")) {
          var a4 = parseArgs();
          expect(")");
          val = callValue(val, undefined, a4);
          continue;
        }
        break;
      }
      return val;
    }
    function parseUnaryReal() {
      skip();
      var start = i;
      if (isIdentStart(peek())) {
        var kw = parseIdent();
        if (kw === "typeof") {
          skip();
          return typeof parseUnaryReal();
        }
        i = start;
      }
      if (match("!!")) return !!parseUnaryReal();
      if (match("!")) return !parseUnaryReal();
      if (match("+")) return +parseUnaryReal();
      if (match("-")) return -parseUnaryReal();
      return parsePostfix();
    }
    function parseCompare() {
      var left = parseUnaryReal();
      for (;;) {
        skip();
        var op =
          match("===") ? "===" :
          match("!==") ? "!==" :
          match("==") ? "==" :
          match("!=") ? "!=" :
          match("<=") ? "<=" :
          match(">=") ? ">=" :
          match("<") ? "<" :
          match(">") ? ">" : null;
        if (!op) break;
        var right = parseUnaryReal();
        if (op === "===") left = left === right;
        else if (op === "!==") left = left !== right;
        else if (op === "==") left = left == right;
        else if (op === "!=") left = left != right;
        else if (op === "<=") left = left <= right;
        else if (op === ">=") left = left >= right;
        else if (op === "<") left = left < right;
        else left = left > right;
      }
      return left;
    }
    function parseAnd() {
      var left = parseCompare();
      while (match("&&")) {
        var right = parseCompare();
        left = left && right;
      }
      return left;
    }
    function parseOr() {
      var left = parseAnd();
      while (match("||")) {
        var right = parseAnd();
        left = left || right;
      }
      return left;
    }
    var result = parseOr();
    skip();
    if (i < src.length) throw new Error("unexpected trailing input: '" + src.slice(i) + "'");
    return result;
  }
  // ─── Expr DSL END ───────────────────────────────────────────────────────

  function pageRoots() {
    return {
      document: document,
      window: window,
      location: location,
      navigator: navigator,
      Math: Math,
      JSON: JSON,
      Number: Number,
      String: String,
      Boolean: Boolean,
      Array: Array,
      Object: Object,
      Date: Date,
      localStorage: localStorage,
      sessionStorage: sessionStorage,
      history: history,
      performance: performance,
    };
  }

  function runExpr(code) {
    return serialize(evalExpr(code, pageRoots()));
  }

  /** Legacy node descriptor for backward-compatible domOps responses. */
  function describeNode(el, depth) {
    if (depth === undefined) depth = 3;
    if (!el || !el.tagName) return null;
    var attrs = {};
    if (el.attributes) for (var i = 0; i < el.attributes.length; i++) attrs[el.attributes[i].name] = el.attributes[i].value;
    var out = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: el.className || undefined,
      attrs: Object.keys(attrs).length ? attrs : undefined,
      text: (el.innerText || el.textContent || "").slice(0, 2000),
      value: "value" in el ? el.value : undefined,
      outerHTML: depth > 0 ? el.outerHTML.slice(0, 20000) : undefined,
    };
    Object.keys(out).forEach(function (k) { if (out[k] === undefined) delete out[k]; });
    return out;
  }

  function queryEl(selector) {
    try { return document.querySelector(selector); }
    catch (e) { return null; }
  }

  // ─── Selector Computation ──────────────────────────────────────────────

  /**
   * Build a unique CSS selector for an element.
   * Strategy: id -> unique class path -> nth-of-type path.
   */
  function computeSelector(el) {
    if (!el || !el.tagName) return "";
    try { return _computeSelector(el); }
    catch (e) { return el.tagName.toLowerCase(); }
  }

  function _computeSelector(el) {
    if (el.id) {
      var sel = "#" + escapeCSS(el.id);
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* ignore */ }
    }

    var path = [];
    var current = el;
    while (current && current !== document.documentElement && current !== document) {
      var seg = current.tagName.toLowerCase();

      if (current.id) {
        seg = "#" + escapeCSS(current.id);
        path.unshift(seg);
        break;
      }

      if (current.className && typeof current.className === "string") {
        var classes = current.className.trim().split(/\s+/)
          .filter(function (c) { return c && c.length < 40 && !c.startsWith("x-") && !c.startsWith("js-"); });
        if (classes.length > 0 && classes.length <= 3) {
          seg += "." + classes.map(escapeCSS).join(".");
        }
      }

      var parent = current.parentElement;
      if (parent) {
        var siblings = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === current.tagName) siblings.push(parent.children[i]);
        }
        if (siblings.length > 1) {
          seg += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }

      path.unshift(seg);
      current = current.parentElement;

      if (path.length >= 2) {
        var test = path.join(" > ");
        try {
          if (document.querySelectorAll(test).length === 1) break;
        } catch (e) { /* keep going */ }
      }
    }

    return path.join(" > ");
  }

  // ─── Accessibility Helpers ─────────────────────────────────────────────

  function getRole(el) {
    if (!el || !el.tagName) return null;
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;

    var tag = el.tagName.toLowerCase();
    if (tag === "html") return "document";
    if (tag === "body") return "document";
    if (tag === "button") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") return _getInputRole(el);
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "td" || tag === "th") return "cell";
    if (tag === "form") return "form";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (tag === "details") return "group";
    if (tag === "summary") return "button";
    if (tag === "dialog") return "dialog";
    if (tag === "option") return "option";
    if (tag === "optgroup") return "group";
    if (tag === "fieldset") return "group";
    if (tag === "label") return "label";
    if (tag === "article") return "article";
    if (tag === "section") return "region";
    if (tag === "pre" || tag === "code") return "code";
    if (tag === "blockquote") return "blockquote";
    if (tag === "menu") return "menu";

    if (el.onclick || el.hasAttribute("onclick")) return "button";
    if (el.getAttribute("tabindex") != null) return tag;
    return null;
  }

  function _getInputRole(el) {
    var type = (el.type || "text").toLowerCase();
    var map = {
      button: "button", submit: "button", reset: "button",
      checkbox: "checkbox", radio: "radio", range: "slider",
      number: "spinbutton", search: "searchbox",
    };
    return map[type] || "textbox";
  }

  function getAccessibleName(el) {
    if (!el || !el.tagName) return "";

    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/)
        .map(function (id) {
          var ref = document.getElementById(id);
          return ref ? (ref.textContent || "").trim() : "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    var tag = el.tagName.toLowerCase();
    if (tag === "img") return el.getAttribute("alt") || "";
    if ((tag === "input" || tag === "textarea") && el.placeholder) return el.placeholder;

    var title = el.getAttribute("title");
    if (title) return title;

    if (["button", "a", "h1", "h2", "h3", "h4", "h5", "h6",
         "summary", "label", "option", "legend", "caption"].indexOf(tag) !== -1) {
      return (el.textContent || "").trim().slice(0, MAX_TEXT_LENGTH);
    }

    if ("value" in el && el.value) return String(el.value).slice(0, MAX_TEXT_LENGTH);

    return "";
  }

  function isInteractive(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();

    if (tag === "button" || tag === "select" || tag === "textarea") return true;
    if (tag === "input") return true;
    if (tag === "a" && el.hasAttribute("href")) return true;
    if (tag === "details" || tag === "summary") return true;
    if (el.onclick || el.hasAttribute("onclick")) return true;
    if (el.isContentEditable) return true;

    var role = el.getAttribute("role");
    if (role && ["button", "link", "tab", "checkbox", "radio",
                  "menuitem", "option", "switch", "slider"].indexOf(role) !== -1) {
      return true;
    }
    return false;
  }

  function isElementVisible(el) {
    if (!el) return false;
    try {
      var style = getComputedStyle(el);
      if (style.display === "none") return false;
      if (style.visibility === "hidden") return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      var rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    } catch (e) {
      return false;
    }
  }

  // ─── Snapshot Builder ──────────────────────────────────────────────────

  function buildSnapshot(rootEl, maxDepth) {
    if (maxDepth == null) maxDepth = DEFAULT_MAX_DEPTH;
    refMap.clear();
    refCounter = 0;
    var snapshot = _buildNode(rootEl || document.body, 0, maxDepth);
    lastSnapshot = snapshot;
    return snapshot;
  }

  function _buildNode(el, depth, maxDepth) {
    if (!el || !el.tagName) return null;
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (depth > 0 && !isElementVisible(el)) return null;

    var role = getRole(el) || tag;
    var name = getAccessibleName(el);
    var box = el.getBoundingClientRect();
    var selector = computeSelector(el);

    var node = {
      role: role,
      name: name.slice(0, MAX_TEXT_LENGTH),
      selector: selector,
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
    };

    if (isInteractive(el)) {
      node.ref = "e" + (++refCounter);
      refMap.set(node.ref, {
        selector: selector,
        role: role,
        name: name,
        box: node.box,
      });
    }

    if ("value" in el && (tag === "input" || tag === "select" || tag === "textarea")) {
      node.value = String(el.value).slice(0, MAX_TEXT_LENGTH);
    }

    if (depth < maxDepth) {
      var children = [];
      var childCount = 0;
      var domChildren = el.children;
      for (var i = 0; i < domChildren.length && childCount < MAX_CHILDREN_PER_NODE; i++) {
        var childNode = _buildNode(domChildren[i], depth + 1, maxDepth);
        if (childNode) {
          children.push(childNode);
          childCount++;
        }
      }
      if (children.length > 0) node.children = children;
    }

    return node;
  }

  // ─── Ref Resolver ──────────────────────────────────────────────────────

  function resolveRef(ref) {
    if (!ref) return null;
    var meta = refMap.get(ref);
    if (!meta) return null;

    var bySelector = queryEl(meta.selector);
    if (bySelector) {
      var elRole = getRole(bySelector);
      if (!meta.role || elRole === meta.role) return bySelector;
    }

    var spatial = _spatialResolve(meta);
    if (spatial) return spatial;

    if (bySelector) return bySelector;
    return null;
  }

  function _spatialResolve(meta) {
    if (!meta.box) return null;
    var targetRole = meta.role;
    var targetBox = meta.box;
    var best = null;
    var bestScore = SPATIAL_MATCH_THRESHOLD;

    var all = document.querySelectorAll("*");
    var limit = Math.min(all.length, 5000);
    for (var i = 0; i < limit; i++) {
      var el = all[i];
      var role = getRole(el);
      if (role !== targetRole) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      var score =
        Math.abs(rect.x - targetBox.x) +
        Math.abs(rect.y - targetBox.y) +
        Math.abs(rect.width - targetBox.w) +
        Math.abs(rect.height - targetBox.h);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  // ─── Action Executor ───────────────────────────────────────────────────

  function executePlan(plan) {
    var results = [];
    function run(i) {
      if (i >= plan.length) return Promise.resolve(results);
      return _executeAction(plan[i], i + 1).then(function (result) {
        results.push(result);
        if (!result.ok) return results;
        return run(i + 1);
      });
    }
    return run(0);
  }

  function _executeAction(action, step) {
    try {
      switch (action.action) {
        case "snapshot": return Promise.resolve(_actSnapshot(action, step));
        case "click": return Promise.resolve(_actClick(action, step));
        case "fill": return Promise.resolve(_actFill(action, step));
        case "press": return Promise.resolve(_actPress(action, step));
        case "hover": return Promise.resolve(_actHover(action, step));
        case "scroll": return Promise.resolve(_actScroll(action, step));
        case "scrollIntoView": return Promise.resolve(_actScrollIntoView(action, step));
        case "wait": return _actWait(action, step);
        case "select": return Promise.resolve(_actSelect(action, step));
        case "eval": return _actEval(action, step);
        case "read": return Promise.resolve(_actRead(action, step));
        case "focus": return Promise.resolve(_actFocus(action, step));
        case "screenshot": return Promise.resolve({ step: step, ok: true, deferred: true });
        default: return Promise.resolve({ step: step, ok: false, err: "unknown action: " + action.action });
      }
    } catch (e) {
      return Promise.resolve({ step: step, ok: false, err: e.message || String(e) });
    }
  }

  function _actSnapshot(action, step) {
    var maxDepth = action.maxDepth || DEFAULT_MAX_DEPTH;
    var snapshot = buildSnapshot(document.body, maxDepth);
    return { step: step, ok: true, snapshot: snapshot };
  }

  function _actClick(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    el.focus();
    var rect = el.getBoundingClientRect();
    var x = rect.x + rect.width / 2;
    var y = rect.y + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    el.click();
    return { step: step, ok: true };
  }

  function _actFill(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    if (action.value == null) return { step: step, ok: false, err: "value required" };
    el.focus();

    if (el.isContentEditable) {
      var sel = window.getSelection();
      sel.selectAllChildren(el);
      document.execCommand("insertText", false, String(action.value));
    } else if ("value" in el) {
      var proto = el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      var nativeSetter = Object.getOwnPropertyDescriptor(proto, "value");
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, String(action.value));
      } else {
        el.value = String(action.value);
      }
    } else {
      return { step: step, ok: false, err: "element does not support value" };
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { step: step, ok: true };
  }

  function _actPress(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    if (!action.key) return { step: step, ok: false, err: "key required" };
    el.focus();

    var key = action.key;
    var opts = { bubbles: true, cancelable: true, key: key };
    if (key.length === 1) {
      opts.code = "Key" + key.toUpperCase();
    } else {
      opts.code = key;
    }

    var keyCodes = {
      Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
      ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39,
      Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32,
    };
    if (keyCodes[key] != null) opts.keyCode = keyCodes[key];

    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { step: step, ok: true };
  }

  function _actHover(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    var rect = el.getBoundingClientRect();
    var x = rect.x + rect.width / 2;
    var y = rect.y + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    return { step: step, ok: true };
  }

  function _actScroll(action, step) {
    if (action.ref) {
      var el = resolveRef(action.ref);
      if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
      el.scrollBy(action.dx || 0, action.dy || 0);
    } else {
      window.scrollBy(action.dx || 0, action.dy || 0);
    }
    return { step: step, ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  function _actScrollIntoView(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return { step: step, ok: true };
  }

  function _actWait(action, step) {
    var timeoutMs = action.timeoutMs || 5000;
    var state = action.state || "visible";

    if (state === "visible") return _waitVisible(action.ref, timeoutMs, step);
    if (state === "hidden") return _waitHidden(action.ref, timeoutMs, step);
    if (state === "attached") return _waitAttached(action.ref, timeoutMs, step);
    if (state === "navigation") return _waitNavigation(timeoutMs, step);
    if (state === "text") return _waitText(action.ref, timeoutMs, step);

    return Promise.resolve({ step: step, ok: false, err: "unknown wait state: " + state });
  }

  function _waitVisible(ref, timeoutMs, step) {
    if (!ref) return Promise.resolve({ step: step, ok: false, err: "ref required for visible wait" });
    var startTime = Date.now();

    return new Promise(function (resolve) {
      function poll() {
        if (Date.now() - startTime >= timeoutMs) {
          resolve({ step: step, ok: false, err: "timeout" });
          return;
        }
        var el = resolveRef(ref);
        if (el) {
          if (isElementVisible(el)) {
            resolve({ step: step, ok: true });
            return;
          }
          var remaining = timeoutMs - (Date.now() - startTime);
          if (remaining <= 0) {
            resolve({ step: step, ok: false, err: "timeout" });
            return;
          }
          var observer = new IntersectionObserver(function (entries) {
            if (entries[0] && entries[0].isIntersecting) {
              observer.disconnect();
              resolve({ step: step, ok: true });
            }
          });
          observer.observe(el);
          setTimeout(function () {
            observer.disconnect();
            resolve({ step: step, ok: false, err: "timeout" });
          }, remaining);
          return;
        }
        setTimeout(poll, 100);
      }
      poll();
    });
  }

  function _waitHidden(ref, timeoutMs, step) {
    if (!ref) return Promise.resolve({ step: step, ok: false, err: "ref required for hidden wait" });
    var startTime = Date.now();
    return new Promise(function (resolve) {
      function poll() {
        if (Date.now() - startTime >= timeoutMs) {
          resolve({ step: step, ok: false, err: "timeout" });
          return;
        }
        var el = resolveRef(ref);
        if (!el || !isElementVisible(el)) {
          resolve({ step: step, ok: true });
          return;
        }
        setTimeout(poll, 100);
      }
      poll();
    });
  }

  function _waitAttached(ref, timeoutMs, step) {
    if (!ref) return Promise.resolve({ step: step, ok: false, err: "ref required for attached wait" });
    var startTime = Date.now();
    return new Promise(function (resolve) {
      function poll() {
        if (Date.now() - startTime >= timeoutMs) {
          resolve({ step: step, ok: false, err: "timeout" });
          return;
        }
        var el = resolveRef(ref);
        if (el) {
          resolve({ step: step, ok: true });
          return;
        }
        setTimeout(poll, 100);
      }
      poll();
    });
  }

  function _waitNavigation(timeoutMs, step) {
    var startUrl = location.href;

    return new Promise(function (resolve) {
      var resolved = false;
      var timer = null;
      var observer = null;

      function finish(result) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      }

      function cleanup() {
        if (timer) clearTimeout(timer);
        window.removeEventListener("beforeunload", onBeforeUnload);
        window.removeEventListener("popstate", onPopState);
        window.removeEventListener("hashchange", onPopState);
        if (observer) try { observer.disconnect(); } catch (e) { /* ignore */ }
      }

      function onBeforeUnload() { finish({ step: step, ok: true }); }
      function onPopState() {
        if (location.href !== startUrl) finish({ step: step, ok: true });
      }

      window.addEventListener("beforeunload", onBeforeUnload);
      window.addEventListener("popstate", onPopState);
      window.addEventListener("hashchange", onPopState);

      try {
        observer = new PerformanceObserver(function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].entryType === "navigation") {
              finish({ step: step, ok: true });
            }
          }
        });
        observer.observe({ type: "navigation", buffered: true });
      } catch (e) { /* PerformanceObserver not available */ }

      timer = setTimeout(function () {
        finish({ step: step, ok: false, err: "timeout" });
      }, timeoutMs);
    });
  }

  function _waitText(ref, timeoutMs, step) {
    if (!ref) return Promise.resolve({ step: step, ok: false, err: "ref required for text wait" });
    var startTime = Date.now();
    return new Promise(function (resolve) {
      function poll() {
        if (Date.now() - startTime >= timeoutMs) {
          resolve({ step: step, ok: false, err: "timeout" });
          return;
        }
        var el = resolveRef(ref);
        if (el && (el.textContent || "").trim()) {
          resolve({ step: step, ok: true });
          return;
        }
        setTimeout(poll, 100);
      }
      poll();
    });
  }

  function _actSelect(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    if (el.tagName !== "SELECT") return { step: step, ok: false, err: "element is not a <select>" };
    if (action.value == null) return { step: step, ok: false, err: "value required" };

    var val = String(action.value);
    var options = Array.from(el.options);
    var match = options.find(function (o) { return o.value === val || o.textContent.trim() === val; });
    if (!match) return { step: step, ok: false, err: "option not found: " + val };

    el.value = match.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { step: step, ok: true };
  }

  function _actEval(action, step) {
    if (!action.code) return Promise.resolve({ step: step, ok: false, err: "code required" });
    try {
      return Promise.resolve({ step: step, ok: true, value: runExpr(action.code) });
    } catch (e) {
      return Promise.resolve({ step: step, ok: false, err: e.message || String(e) });
    }
  }

  function _actRead(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    return { step: step, ok: true, text: (el.innerText || el.textContent || "").slice(0, 5000) };
  }

  function _actFocus(action, step) {
    if (!action.ref) return { step: step, ok: false, err: "ref required" };
    var el = resolveRef(action.ref);
    if (!el) return { step: step, ok: false, err: "element not found for ref " + action.ref + ". The element may have been removed from the page or the DOM has changed since the snapshot." };
    el.focus();
    return { step: step, ok: true };
  }

  // ─── Event System ──────────────────────────────────────────────────────

  function pushEvent(subscriptionId, type, detail) {
    try {
      chrome.runtime.sendMessage({
        type: "ba:event",
        params: { subscriptionId: subscriptionId, type: type, detail: detail },
      });
    } catch (e) { /* extension context invalidated */ }
  }

  // ─── MutationObserver Engine ───────────────────────────────────────────

  function handleWatch(params) {
    var id = params && params.id;
    var selector = params && params.selector;
    var events = (params && params.events) || ["added", "removed"];
    if (!id || !selector) return err("id and selector required");

    if (watchers.has(id)) {
      watchers.get(id).observer.disconnect();
    }

    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var mutation = mutations[m];
        if (mutation.type === "childList") {
          if (events.indexOf("added") !== -1) {
            for (var i = 0; i < mutation.addedNodes.length; i++) {
              var node = mutation.addedNodes[i];
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (node.matches(selector) || node.querySelector(selector)) {
                pushEvent(id, "dom.mutation", {
                  selector: selector,
                  event: "added",
                  node: { tag: node.tagName.toLowerCase(), text: (node.textContent || "").slice(0, 200) },
                });
              }
            }
          }
          if (events.indexOf("removed") !== -1) {
            for (var j = 0; j < mutation.removedNodes.length; j++) {
              var rnode = mutation.removedNodes[j];
              if (rnode.nodeType !== Node.ELEMENT_NODE) continue;
              if (rnode.matches(selector) || rnode.querySelector(selector)) {
                pushEvent(id, "dom.mutation", {
                  selector: selector,
                  event: "removed",
                  node: { tag: rnode.tagName.toLowerCase(), text: (rnode.textContent || "").slice(0, 200) },
                });
              }
            }
          }
        }
        if (mutation.type === "characterData" && events.indexOf("textChanged") !== -1) {
          var parentEl = mutation.target.parentElement;
          if (parentEl && (parentEl.matches(selector) || parentEl.querySelector(selector))) {
            pushEvent(id, "dom.mutation", {
              selector: selector,
              event: "textChanged",
              node: null,
            });
          }
        }
      }
    });

    var target = queryEl(selector) || document.body;
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: events.indexOf("textChanged") !== -1,
    });

    watchers.set(id, { selector: selector, events: events, observer: observer });
    return ok(true);
  }

  function handleUnwatch(params) {
    var id = params && params.id;
    if (!id) return err("id required");
    if (watchers.has(id)) {
      watchers.get(id).observer.disconnect();
      watchers.delete(id);
    }
    return ok(true);
  }

  function handleSubscribe(params) {
    var subscriptionId = params && params.subscriptionId;
    var events = params && params.events;
    if (!subscriptionId || !events || !events.length) {
      return err("subscriptionId and events required");
    }

    _cleanupSubscription(subscriptionId);

    var sub = { events: events, observers: [] };

    for (var i = 0; i < events.length; i++) {
      var event = events[i];

      if (event.type === "dom.mutation") {
        _subscribeDomMutation(subscriptionId, sub, event);
      } else if (event.type === "element.state" && event.state === "visible") {
        _subscribeElementState(subscriptionId, sub, event);
      } else if (event.type === "element.state" && event.state === "hidden") {
        _subscribeElementHidden(subscriptionId, sub, event);
      } else if (event.type === "page.loaded") {
        pushEvent(subscriptionId, "page.loaded", { url: location.href });
      } else if (event.type === "console.entry") {
        // New entries only — console.getLog returns the history.
        sub.consoleEntry = true;
      }
    }

    subscriptions.set(subscriptionId, sub);
    return ok(true);
  }

  function _subscribeDomMutation(subscriptionId, sub, event) {
    var target = event.selector
      ? queryEl(event.selector) || document.body
      : document.body;

    var wantAdded = event.events && event.events.indexOf("added") !== -1;
    var wantRemoved = event.events && event.events.indexOf("removed") !== -1;
    var wantText = event.events && event.events.indexOf("textChanged") !== -1;

    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var mutation = mutations[m];
        if (mutation.type === "childList") {
          if (wantAdded) {
            for (var i = 0; i < mutation.addedNodes.length; i++) {
              var node = mutation.addedNodes[i];
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (!event.selector || node.matches(event.selector) || node.querySelector(event.selector)) {
                pushEvent(subscriptionId, "dom.mutation", {
                  selector: event.selector,
                  event: "added",
                  node: { tag: node.tagName.toLowerCase(), text: (node.textContent || "").slice(0, 200) },
                });
              }
            }
          }
          if (wantRemoved) {
            for (var j = 0; j < mutation.removedNodes.length; j++) {
              var rnode = mutation.removedNodes[j];
              if (rnode.nodeType !== Node.ELEMENT_NODE) continue;
              if (!event.selector || rnode.matches(event.selector) || rnode.querySelector(event.selector)) {
                pushEvent(subscriptionId, "dom.mutation", {
                  selector: event.selector,
                  event: "removed",
                  node: { tag: rnode.tagName.toLowerCase(), text: (rnode.textContent || "").slice(0, 200) },
                });
              }
            }
          }
        }
        if (mutation.type === "characterData" && wantText) {
          var parentEl = mutation.target.parentElement;
          if (parentEl && (!event.selector || parentEl.matches(event.selector) || parentEl.querySelector(event.selector))) {
            pushEvent(subscriptionId, "dom.mutation", {
              selector: event.selector,
              event: "textChanged",
              node: null,
            });
          }
        }
      }
    });

    observer.observe(target, { childList: true, subtree: true, characterData: wantText });
    sub.observers.push(observer);
  }

  function _subscribeElementState(subscriptionId, sub, event) {
    var el = resolveRef(event.ref);
    if (!el) return;
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0]) {
        pushEvent(subscriptionId, "element.state", {
          ref: event.ref,
          state: entries[0].isIntersecting ? "visible" : "hidden",
        });
      }
    });
    observer.observe(el);
    sub.observers.push(observer);
  }

  function _subscribeElementHidden(subscriptionId, sub, event) {
    var el = resolveRef(event.ref);
    if (!el) return;
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0] && !entries[0].isIntersecting) {
        pushEvent(subscriptionId, "element.state", {
          ref: event.ref,
          state: "hidden",
        });
      }
    });
    observer.observe(el);
    sub.observers.push(observer);
  }

  function handleUnsubscribe(params) {
    var subscriptionId = params && params.subscriptionId;
    if (!subscriptionId) return err("subscriptionId required");
    _cleanupSubscription(subscriptionId);
    return ok(true);
  }

  function _cleanupSubscription(subscriptionId) {
    if (subscriptions.has(subscriptionId)) {
      var sub = subscriptions.get(subscriptionId);
      if (sub.observers) {
        for (var i = 0; i < sub.observers.length; i++) {
          try { sub.observers[i].disconnect(); } catch (e) { /* ignore */ }
        }
      }
      subscriptions.delete(subscriptionId);
    }
  }

  // ─── Legacy DOM Operations ─────────────────────────────────────────────

  var domOps = {
    eval: function (msg) {
      if (!msg || !msg.code) return Promise.resolve(err("code required"));
      try { return Promise.resolve(ok(runExpr(msg.code))); }
      catch (e) { return Promise.resolve(err(e.message || String(e))); }
    },

    getOuterHTML: function () { return ok(document.documentElement.outerHTML); },

    getText: function (msg) {
      try {
        var root = msg.selector ? document.querySelector(msg.selector) : document.body;
        return ok(root ? root.innerText : null);
      } catch (e) { return err(e.message); }
    },

    querySelector: function (msg) {
      var el = queryEl(msg.selector);
      return ok(el ? describeNode(el) : null);
    },

    querySelectorAll: function (msg) {
      var els;
      try { els = document.querySelectorAll(msg.selector); }
      catch (e) { return err("invalid selector: " + e.message); }
      var limit = msg.limit || 100;
      var out = [];
      for (var i = 0; i < els.length && out.length < limit; i++) {
        var el = els[i];
        var attrs = {};
        if (el.attributes) {
          for (var j = 0; j < el.attributes.length; j++) {
            attrs[el.attributes[j].name] = el.attributes[j].value;
          }
        }
        var item = {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          class: el.className || undefined,
          attrs: Object.keys(attrs).length ? attrs : undefined,
          text: (el.innerText || el.textContent || "").slice(0, 400),
        };
        if (msg.attrs && msg.attrs.length) {
          item.attrs = {};
          for (var k = 0; k < msg.attrs.length; k++) {
            item.attrs[msg.attrs[k]] = el.getAttribute(msg.attrs[k]);
          }
        }
        Object.keys(item).forEach(function (key) { if (item[key] === undefined) delete item[key]; });
        out.push(item);
      }
      return ok(out);
    },

    getValue: function (msg) {
      var el = queryEl(msg.selector);
      return ok(el && "value" in el ? el.value : null);
    },

    setValue: function (msg) {
      var el = queryEl(msg.selector);
      if (!el) return err("not found");
      if (el.isContentEditable) {
        el.focus();
        var sel = window.getSelection();
        sel.selectAllChildren(el);
        document.execCommand("insertText", false, msg.value);
      } else {
        el.value = msg.value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return ok(true);
    },

    pressKey: function (msg) {
      var target = msg.selector ? queryEl(msg.selector) : document.activeElement;
      if (!target) return err("no target");
      target.focus();
      var key = msg.key || "Enter";
      var code = msg.code || (key === "Enter" ? "Enter" : key);
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: key, code: code }));
      target.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: key, code: code }));
      target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: key, code: code }));
      return ok(true);
    },

    click: function (msg) {
      var el = queryEl(msg.selector);
      if (!el) return err("not found");
      el.focus();
      var rect = el.getBoundingClientRect();
      var x = rect.x + rect.width / 2;
      var y = rect.y + rect.height / 2;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      el.click();
      return ok(true);
    },

    clickByText: function (msg) {
      var selector = msg.selector || "*";
      var text = msg.text;
      if (!text) return err("text required");
      var els;
      try { els = document.querySelectorAll(selector); }
      catch (e) { return err("invalid selector: " + e.message); }
      var found = null;
      for (var i = 0; i < els.length; i++) {
        if ((els[i].textContent || "").trim().includes(text)) {
          found = els[i];
          break;
        }
      }
      if (!found) return err("no element containing text: " + text);
      found.focus();
      var rect = found.getBoundingClientRect();
      var x = rect.x + rect.width / 2;
      var y = rect.y + rect.height / 2;
      found.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      found.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      found.click();
      return ok(true);
    },

    hover: function (msg) {
      var el = queryEl(msg.selector);
      if (!el) return err("not found");
      var rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
      return ok(true);
    },

    focus: function (msg) {
      var el = queryEl(msg.selector);
      if (!el) return err("not found");
      el.focus();
      return ok(true);
    },

    type: function (msg) {
      var target = msg.selector ? queryEl(msg.selector) : document.activeElement;
      if (!target) return err("no target");
      target.focus();
      var text = String(msg.text || "");
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ch }));
        target.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: ch }));
      }
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return ok(true);
    },

    scroll: function (msg) {
      if (msg.selector) {
        var el = queryEl(msg.selector);
        if (!el) return err("not found");
        el.scrollBy(msg.dx || 0, msg.dy || 0);
      } else {
        window.scrollBy(msg.dx || 0, msg.dy || 0);
      }
      return ok({ scrollX: window.scrollX, scrollY: window.scrollY });
    },

    scrollIntoView: function (msg) {
      var el = queryEl(msg.selector);
      if (!el) return err("not found");
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return ok(true);
    },

    waitFor: function (msg) {
      var timeout = msg.timeoutMs || 5000;
      var selector = msg.selector;
      if (!selector) return err("selector required");
      var start = Date.now();
      return new Promise(function (resolve) {
        function poll() {
          if (Date.now() - start >= timeout) { resolve(ok(false)); return; }
          if (document.querySelector(selector)) { resolve(ok(true)); return; }
          setTimeout(poll, 50);
        }
        poll();
      });
    },

    screenshot: function () { return ok({ deferred: true }); },
    navigate: function (msg) { return ok({ navigated: true, url: msg.url }); },
    reload: function () { return ok({ reloaded: true }); },
    frames: function () {
      var frames = [];
      try {
        for (var i = 0; i < window.frames.length; i++) frames.push({ index: i });
      } catch (e) { /* cross-origin */ }
      return ok(frames);
    },
  };

  // ─── Storage Operations (localStorage / sessionStorage) ────────────────

  function handleStorage(msg) {
    var area = msg.area === "session" ? sessionStorage : localStorage;
    try {
      switch (msg.op) {
        case "get": return area.getItem(msg.key);
        case "set": area.setItem(msg.key, String(msg.value)); return true;
        case "remove": area.removeItem(msg.key); return true;
        case "clear": area.clear(); return true;
        case "keys": {
          var a = [];
          for (var i = 0; i < area.length; i++) a.push(area.key(i));
          return a;
        }
      }
      return null;
    } catch (e) { throw new Error(e.message); }
  }

  // ─── Cache API Operations ──────────────────────────────────────────────

  function handleCache(msg) {
    switch (msg.op) {
      case "keys": return caches.keys();
      case "list":
        return caches.open(msg.name).then(function (c) {
          return c.keys().then(function (reqs) {
            return reqs.map(function (r) { return { url: r.url, method: r.method }; });
          });
        });
      case "match":
        return caches.open(msg.name).then(function (c) {
          return c.match(msg.request).then(function (r) {
            if (!r) return null;
            return r.text().then(function (body) {
              return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: body };
            });
          });
        });
      case "put":
        return caches.open(msg.name).then(function (c) {
          var req = new Request(msg.request, { method: "GET" });
          var init = {
            status: (msg.response && msg.response.status != null) ? msg.response.status : 200,
            headers: (msg.response && msg.response.headers) || { "Content-Type": (msg.response && msg.response.contentType) || "application/json" },
          };
          if (msg.response && msg.response.headers && msg.response.contentType && !msg.response.headers["Content-Type"]) {
            init.headers["Content-Type"] = msg.response.contentType;
          }
          var res = new Response((msg.response && msg.response.body) || "", init);
          return c.put(req, res).then(function () { return true; });
        });
      case "delete":
        return caches.open(msg.name).then(function (c) { return c.delete(msg.request); });
      case "clear":
        return caches.open(msg.name).then(function (c) {
          return c.keys().then(function (reqs) {
            return Promise.all(reqs.map(function (r) { return c.delete(r); })).then(function () { return true; });
          });
        });
    }
  }

  // ─── IndexedDB Operations ──────────────────────────────────────────────

  function idbOpenDB(name, version, upgrade) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name, version);
      req.onupgradeneeded = function (e) { if (upgrade) upgrade(e.target.result); };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function idbTx(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var s = t.objectStore(store);
      var result;
      Promise.resolve(fn(s)).then(function (r) { result = r; }).catch(reject);
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  }

  function idbReqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function handleIdb(msg) {
    switch (msg.op) {
      case "databases":
        return indexedDB.databases ? indexedDB.databases() : Promise.resolve(null);
      case "stores":
        return idbOpenDB(msg.db).then(function (db) {
          var names = Array.from(db.objectStoreNames);
          db.close();
          return names;
        });
      case "get":
        return idbOpenDB(msg.db).then(function (db) {
          return idbTx(db, msg.store, "readonly", function (s) {
            return idbReqP(s.get(msg.key));
          }).finally(function () { db.close(); });
        });
      case "put":
        return idbOpenDB(msg.db).then(function (db) {
          return idbTx(db, msg.store, "readwrite", function (s) {
            return idbReqP(s.put(msg.value, msg.key));
          }).finally(function () { db.close(); });
        });
      case "del":
        return idbOpenDB(msg.db).then(function (db) {
          return idbTx(db, msg.store, "readwrite", function (s) {
            return idbReqP(s.delete(msg.key));
          }).finally(function () { db.close(); });
        });
      case "count":
        return idbOpenDB(msg.db).then(function (db) {
          return idbTx(db, msg.store, "readonly", function (s) {
            return idbReqP(s.count(msg.query));
          }).finally(function () { db.close(); });
        });
      case "keys":
        return idbOpenDB(msg.db).then(function (db) {
          return idbTx(db, msg.store, "readonly", function (s) {
            return idbReqP(s.getAllKeys(msg.query, msg.limit));
          }).finally(function () { db.close(); });
        });
      case "getAll":
        return idbOpenDB(msg.db).then(function (db) {
          return idbTx(db, msg.store, "readonly", function (s) {
            return idbReqP(s.getAll(msg.query, msg.limit));
          }).finally(function () { db.close(); });
        });
    }
  }

  // ─── Console Capture ───────────────────────────────────────────────────
  //
  // Entries are produced by console-capture.js in the page's MAIN world and
  // arrive over the "bab:console" DOM event — the only channel both worlds
  // share. Keeping a bounded per-frame buffer is what makes console.getLog
  // behave like the DevTools Console panel: history since page load, not
  // history since the agent asked.

  var CONSOLE_EVENT = "bab:console";
  var CONSOLE_FLUSH_EVENT = "bab:console-flush";
  var CONSOLE_MAX = 1000;
  var consoleBuf = [];
  var consoleLastSeq = 0;

  window.addEventListener(CONSOLE_EVENT, function (ev) {
    var entry = ev && ev.detail;
    if (!entry || typeof entry.seq !== "number") return;
    // seq dedupes the bootstrap replay against entries we already caught live.
    if (entry.seq <= consoleLastSeq) return;
    consoleLastSeq = entry.seq;
    consoleBuf.push(entry);
    if (consoleBuf.length > CONSOLE_MAX) consoleBuf.shift();
    subscriptions.forEach(function (sub, subscriptionId) {
      if (sub.consoleEntry) pushEvent(subscriptionId, "console.entry", entry);
    });
  });

  // Ask the MAIN-world hook to replay anything logged before we attached.
  // Guarded: if this threw, everything after it — including the message router —
  // would never register.
  try {
    window.dispatchEvent(new CustomEvent(CONSOLE_FLUSH_EVENT));
  } catch (e) { /* no capture hook on this page */ }

  function handleConsole(msg) {
    var op = msg.op;
    if (op === "clear") {
      consoleBuf.length = 0;
      // Keep consoleLastSeq — a replayed seq at or below it must stay rejected,
      // otherwise a re-flush would resurrect cleared entries.
      return true;
    }
    if (op === "getLog") {
      var f = msg.filter || {};
      var out = [];
      for (var i = 0; i < consoleBuf.length; i++) {
        var e = consoleBuf[i];
        if (f.level && e.level !== f.level) continue;
        if (f.levels && f.levels.indexOf(e.level) === -1) continue;
        if (f.text && (e.text || "").indexOf(f.text) === -1) continue;
        if (f.since && e.ts < f.since) continue;
        out.push(e);
      }
      var limit = typeof msg.limit === "number" ? msg.limit : 500;
      if (limit <= 0) return [];
      return out.length > limit ? out.slice(-limit) : out;
    }
    throw new Error("unknown console op: " + op);
  }

  // ─── Performance ───────────────────────────────────────────────────────
  //
  // Straight Performance API — no CDP, so it behaves the same on Chrome and
  // Firefox. Observers register lazily with buffered:true (so entries recorded
  // before the first call are still returned) and then stay registered, which
  // is what stops CLS/INP from being counted twice on later calls. Every
  // metric is feature-detected: Firefox simply reports supported:false.

  var perfInited = false;
  var perfSupported = { lcp: false, cls: false, inp: false, longTask: false };
  var perfLatest = { lcp: null, cls: 0, inp: null, eventMax: null, longTaskTotal: 0 };
  var perfInpSamples = [];
  var INP_SAMPLE_MAX = 500;

  function _canObserve(type) {
    return typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes &&
      PerformanceObserver.supportedEntryTypes.indexOf(type) !== -1;
  }

  function _observe(type, onEntries) {
    if (!_canObserve(type)) return false;
    try {
      new PerformanceObserver(function (list) { onEntries(list.getEntries()); })
        .observe({ type: type, buffered: true });
      return true;
    } catch (e) { return false; }
  }

  function _perfInit() {
    if (perfInited) return;
    perfInited = true;

    perfSupported.lcp = _observe("largest-contentful-paint", function (es) {
      if (es.length) perfLatest.lcp = es[es.length - 1].startTime;
    });

    perfSupported.cls = _observe("layout-shift", function (es) {
      for (var i = 0; i < es.length; i++) {
        if (!es[i].hadRecentInput) perfLatest.cls += es[i].value;
      }
    });

    perfSupported.inp = _observe("event", function (es) {
      for (var i = 0; i < es.length; i++) {
        var d = es[i].duration;
        if (d > (perfLatest.eventMax || 0)) perfLatest.eventMax = d;
        perfInpSamples.push(d);
        if (perfInpSamples.length > INP_SAMPLE_MAX) perfInpSamples.shift();
      }
      if (perfInpSamples.length) {
        var sorted = perfInpSamples.slice().sort(function (a, b) { return b - a; });
        // shortcut: drops only the single worst interaction instead of the
        // web-vitals 1% tail — fine for comparing runs, not for scoring.
        if (sorted.length >= 50) sorted.shift();
        perfLatest.inp = sorted[0];
      }
    });

    perfSupported.longTask = _observe("longtask", function (es) {
      for (var i = 0; i < es.length; i++) perfLatest.longTaskTotal += es[i].duration;
    });
  }

  function handlePerf(msg) {
    _perfInit();
    var op = msg.op;
    var i;

    if (op === "metrics") {
      var nav = performance.getEntriesByType("navigation")[0] || null;
      var fcp = null;
      var paints = performance.getEntriesByType("paint");
      for (i = 0; i < paints.length; i++) {
        if (paints[i].name === "first-contentful-paint") fcp = paints[i].startTime;
      }
      // 0 means "not measured yet" (loadEventEnd before the load event).
      function ms(v) { return v > 0 ? Math.round(v * 10) / 10 : null; }
      return {
        url: location.href,
        ttfb: nav ? ms(nav.responseStart) : null,
        dns: nav ? ms(nav.domainLookupEnd - nav.domainLookupStart) : null,
        connect: nav ? ms(nav.connectEnd - nav.connectStart) : null,
        tls: nav && nav.secureConnectionStart ? ms(nav.connectEnd - nav.secureConnectionStart) : null,
        waiting: nav ? ms(nav.responseStart - nav.requestStart) : null,
        download: nav ? ms(nav.responseEnd - nav.responseStart) : null,
        domInteractive: nav ? ms(nav.domInteractive) : null,
        domContentLoaded: nav ? ms(nav.domContentLoadedEventEnd) : null,
        load: nav ? ms(nav.loadEventEnd) : null,
        fcp: ms(fcp),
        lcp: ms(perfLatest.lcp),
        cls: Math.round(perfLatest.cls * 1000) / 1000,
        inp: perfLatest.inp != null ? Math.round(perfLatest.inp) : null,
        eventMax: ms(perfLatest.eventMax),
        longTaskTotal: ms(perfLatest.longTaskTotal),
        supported: perfSupported,
      };
    }

    if (op === "resources") {
      var all = performance.getEntriesByType("resource");
      var f = msg.filter || {};
      var limit = typeof msg.limit === "number" ? msg.limit : 200;
      if (limit <= 0) return { total: all.length, shown: 0, entries: [] };
      var out = [];
      for (i = 0; i < all.length; i++) {
        var r = all[i];
        if (f.url && r.name.indexOf(f.url) === -1) continue;
        if (f.type && r.initiatorType !== f.type) continue;
        out.push({
          url: r.name,
          type: r.initiatorType,
          start: Math.round(r.startTime * 10) / 10,
          duration: Math.round(r.duration * 10) / 10,
          waiting: Math.round((r.responseStart - r.requestStart) * 10) / 10,
          download: Math.round((r.responseEnd - r.responseStart) * 10) / 10,
          size: r.decodedBodySize || 0,
          // 0 for cross-origin without Timing-Allow-Origin.
          transferSize: r.transferSize || 0,
          protocol: r.nextHopProtocol || null,
        });
        if (out.length >= limit) break;
      }
      return { total: all.length, shown: out.length, entries: out };
    }

    throw new Error("unknown perf op: " + op);
  }

  // ─── Message Router ────────────────────────────────────────────────────

  function handle(msg) {
    if (!msg || typeof msg.type !== "string") return Promise.resolve(null);

    var type = msg.type;
    var params = msg.params || msg;

    // Background prefixes every low-level method with "ba:" (see protocol.js
    // MSG). The low-level handlers below are keyed without the prefix, so
    // normalise: "ba:getText" -> "getText".
    if (type.indexOf("ba:") === 0 && domOps[type.slice(3)]) {
      type = type.slice(3);
    }

    // ── New protocol (ba: prefix) ────────────────────────────────────────
    if (type === "ba:snapshot") {
      var maxDepth = params && params.maxDepth;
      return Promise.resolve(ok(buildSnapshot(document.body, maxDepth)));
    }
    if (type === "ba:act") {
      if (!params || !params.plan || !Array.isArray(params.plan)) {
        return Promise.resolve(err("plan array required in params"));
      }
      return executePlan(params.plan).then(function (results) { return ok(results); });
    }
    if (type === "ba:watch") return Promise.resolve(handleWatch(params));
    if (type === "ba:unwatch") return Promise.resolve(handleUnwatch(params));
    if (type === "ba:subscribe") return Promise.resolve(handleSubscribe(params));
    if (type === "ba:unsubscribe") return Promise.resolve(handleUnsubscribe(params));

    // ── Low-level DOM operations via ba: prefix ──────────────────────────
    if (type === "ba:eval") {
      if (!params || !params.code) return Promise.resolve(err("code required"));
      try { return Promise.resolve(ok(runExpr(params.code))); }
      catch (e) { return Promise.resolve(err(e.message || String(e))); }
    }
    if (type === "ba:click") {
      if (!params || !params.selector) return Promise.resolve(err("selector required"));
      var clickEl = queryEl(params.selector);
      if (!clickEl) return Promise.resolve(err("element not found for selector: " + params.selector));
      clickEl.focus();
      var rect = clickEl.getBoundingClientRect();
      var x = rect.x + rect.width / 2;
      var y = rect.y + rect.height / 2;
      clickEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      clickEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      clickEl.click();
      return Promise.resolve(ok(true));
    }

    // ── Storage / Cache / IndexedDB ──────────────────────────────────────
    if (type === "ba:storage") {
      try { return Promise.resolve(ok(handleStorage(params))); }
      catch (e) { return Promise.resolve(err(e.message)); }
    }
    if (type === "ba:cache") {
      try {
        return handleCache(params).then(function (r) { return ok(r); });
      } catch (e) { return Promise.resolve(err(e.message)); }
    }
    if (type === "ba:indexedDB") {
      try {
        return handleIdb(params).then(function (r) { return ok(r); });
      } catch (e) { return Promise.resolve(err(e.message)); }
    }
    if (type === "ba:console") {
      try { return Promise.resolve(ok(handleConsole(params))); }
      catch (e) { return Promise.resolve(err(e.message)); }
    }
    if (type === "ba:perf") {
      try { return Promise.resolve(ok(handlePerf(params))); }
      catch (e) { return Promise.resolve(err(e.message)); }
    }

    // ── Legacy protocol (no prefix) ─────────────────────────────────────
    if (type === "storage") {
      try { return Promise.resolve(ok(handleStorage(msg))); }
      catch (e) { return Promise.resolve(err(e.message)); }
    }
    if (type === "cache") {
      try {
        return handleCache(msg).then(function (r) { return ok(r); });
      } catch (e) { return Promise.resolve(err(e.message)); }
    }
    if (type === "indexedDB") {
      try {
        return handleIdb(msg).then(function (r) { return ok(r); });
      } catch (e) { return Promise.resolve(err(e.message)); }
    }

    var op = domOps[type];
    if (op) {
      // Refs come from snapshots; low-level ops address by selector. Resolve
      // ref → selector here so page.click("eN") works as the SDK advertises.
      // Unknown refs fall through to the op's own "not found" error.
      if (msg.ref && !msg.selector) {
        var refMeta = refMap.get(msg.ref);
        if (refMeta) msg = Object.assign({}, msg, { selector: refMeta.selector });
      }
      var result = op(msg);
      if (result && typeof result.then === "function") return result;
      return Promise.resolve(result);
    }

    return Promise.resolve(err("unknown type: " + type));
  }

  // ─── Listener ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== "string") return false;
    handle(msg).then(sendResponse, function (e) { sendResponse(err(e.message)); });
    return true;
  });

  // ─── Initialize ────────────────────────────────────────────────────────

  console.log("[browsepal] content script loaded on", location.hostname);

  // Register the Web Vitals observers now rather than on first perf.metrics
  // call: observer callbacks (including buffered:true replay) are queued tasks,
  // so a call made in the same turn as registration reads zeroed values.
  _perfInit();

  // Fire page.loaded for any early subscriptions
  if (document.readyState === "complete" || document.readyState === "interactive") {
    _firePageLoaded();
  } else {
    document.addEventListener("DOMContentLoaded", _firePageLoaded);
  }

  function _firePageLoaded() {
    subscriptions.forEach(function (sub, subscriptionId) {
      if (sub.events) {
        for (var i = 0; i < sub.events.length; i++) {
          if (sub.events[i].type === "page.loaded") {
            pushEvent(subscriptionId, "page.loaded", { url: location.href });
          }
        }
      }
    });
  }

})();
