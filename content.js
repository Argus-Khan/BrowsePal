(() => {
  if (window.__browserAgentBridge) return;
  window.__browserAgentBridge = true;

  function ok(v) { return { ok: v }; }
  function err(m) { return { err: m }; }

  function serialize(value) {
    if (value === undefined) return null;
    if (value && typeof value === "object" && value.nodeType) return describeNode(value);
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    try {
      JSON.stringify(value);
      return value;
    } catch (e) {
      return String(value);
    }
  }

  function describeNode(el, depth = 3) {
    if (!el || !el.tagName) return null;
    const attrs = {};
    if (el.attributes) for (const a of el.attributes) attrs[a.name] = a.value;
    const out = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: el.className || undefined,
      attrs: Object.keys(attrs).length ? attrs : undefined,
      text: (el.innerText || el.textContent || "").slice(0, 2000),
      value: "value" in el ? el.value : undefined,
      outerHTML: depth > 0 ? el.outerHTML.slice(0, 20000) : undefined,
    };
    Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
    return out;
  }

  async function handle(msg) {
    switch (msg.type) {
      case "eval": {
        try {
          const result = await (new Function(`return (async () => { return (${msg.code}); })();`))();
          return ok(serialize(result));
        } catch (e) {
          try {
            const result2 = (new Function(`${msg.code}`))();
            return ok(serialize(result2));
          } catch (e2) {
            return err(`${e2.name || e.name || "Error"}: ${e2.message || e.message}`);
          }
        }
      }
      case "getOuterHTML":
        return ok(document.documentElement.outerHTML);
      case "getText":
        try {
          const root = msg.selector ? document.querySelector(msg.selector) : document.body;
          return ok(root ? root.innerText : null);
        } catch (e) { return err(e.message); }
      case "querySelector": {
        const el = document.querySelector(msg.selector);
        if (!el) return ok(null);
        return ok(describeNode(el));
      }
      case "querySelectorAll": {
        const els = document.querySelectorAll(msg.selector);
        const limit = msg.limit || 100;
        const out = [];
        for (let i = 0; i < els.length && out.length < limit; i++) {
          const el = els[i];
          const attrs = {};
          for (const a of el.attributes || []) attrs[a.name] = a.value;
          const item = {
            tag: el.tagName.toLowerCase(), id: el.id || undefined, class: el.className || undefined,
            attrs: Object.keys(attrs).length ? attrs : undefined, text: (el.innerText || el.textContent || "").slice(0, 400),
          };
          if (msg.attrs && msg.attrs.length) {
            item.attrs = {};
            for (const n of msg.attrs) item.attrs[n] = el.getAttribute(n);
          }
          Object.keys(item).forEach((k) => item[k] === undefined && delete item[k]);
          out.push(item);
        }
        return ok(out);
      }
      case "getValue": {
        const el = document.querySelector(msg.selector);
        if (!el) return ok(null);
        return ok("value" in el ? el.value : null);
      }
      case "setValue": {
        const el = document.querySelector(msg.selector);
        if (!el) return err("not found");
        if (el.isContentEditable) {
          el.focus();
          const sel = window.getSelection();
          sel.selectAllChildren(el);
          document.execCommand("insertText", false, msg.value);
        } else {
          el.value = msg.value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return ok(true);
      }
      case "pressKey": {
        const target = msg.selector ? document.querySelector(msg.selector) : document.activeElement;
        if (!target) return err("no target");
        target.focus();
        const key = msg.key || "Enter";
        const code = msg.code || (key === "Enter" ? "Enter" : key);
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, code }));
        target.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key, code }));
        target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key, code }));
        return ok(true);
      }
      case "click": {
        const el = document.querySelector(msg.selector);
        if (!el) return err("not found");
        el.focus();
        const rect = el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
        el.click();
        return ok(true);
      }
      case "clickByText": {
        const selector = msg.selector || "*";
        const text = msg.text;
        if (!text) return err("text required");
        const els = document.querySelectorAll(selector);
        const el = Array.from(els).find((e) => (e.textContent || "").trim().includes(text));
        if (!el) return err(`no element containing text: ${text}`);
        el.focus();
        const rect = el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
        el.click();
        return ok(true);
      }
      case "hover": {
        const el = document.querySelector(msg.selector);
        if (!el) return err("not found");
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
        return ok(true);
      }
      case "focus": {
        const el = document.querySelector(msg.selector);
        if (!el) return err("not found");
        el.focus();
        return ok(true);
      }
      case "type": {
        const target = msg.selector ? document.querySelector(msg.selector) : document.activeElement;
        if (!target) return err("no target");
        target.focus();
        for (const ch of String(msg.text || "")) {
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ch }));
          const ev = new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" });
          target.dispatchEvent(ev);
          target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: ch }));
        }
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return ok(true);
      }
      case "scroll": {
        if (msg.selector) {
          const el = document.querySelector(msg.selector);
          if (el) el.scrollBy(msg.dx || 0, msg.dy || 0); else return err("not found");
        } else {
          window.scrollBy(msg.dx || 0, msg.dy || 0);
        }
        return ok({ scrollX: window.scrollX, scrollY: window.scrollY });
      }
      case "scrollIntoView": {
        const el = document.querySelector(msg.selector);
        if (!el) return err("not found");
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return ok(true);
      }
      case "waitFor": {
        const timeout = msg.timeoutMs || 5000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (document.querySelector(msg.selector)) return ok(true);
          await new Promise((r) => setTimeout(r, 50));
        }
        return ok(false);
      }
      case "storage":
        return ok(handleStorage(msg));
      case "cache":
        return await handleCache(msg);
      case "indexedDB":
        return await handleIdb(msg);
    }
    return err(`unknown type: ${msg.type}`);
  }

  function handleStorage(msg) {
    const area = msg.area === "session" ? sessionStorage : localStorage;
    try {
      switch (msg.op) {
        case "get": return area.getItem(msg.key);
        case "set": area.setItem(msg.key, String(msg.value)); return true;
        case "remove": area.removeItem(msg.key); return true;
        case "clear": area.clear(); return true;
        case "keys": { const a = []; for (let i = 0; i < area.length; i++) a.push(area.key(i)); return a; }
      }
      return null;
    } catch (e) { throw new Error(e.message); }
  }

  async function handleCache(msg) {
    switch (msg.op) {
      case "keys": return await caches.keys();
      case "list": {
        const c = await caches.open(msg.name);
        const reqs = await c.keys();
        return reqs.map((r) => ({ url: r.url, method: r.method }));
      }
      case "match": {
        const c = await caches.open(msg.name);
        const r = await c.match(msg.request);
        if (!r) return null;
        const body = await r.text();
        return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body };
      }
      case "put": {
        const c = await caches.open(msg.name);
        const req = new Request(msg.request, { method: "GET" });
        const init = {
          status: msg.response?.status ?? 200,
          headers: msg.response?.headers ?? { "Content-Type": msg.response?.contentType || "application/json" },
        };
        if (msg.response?.headers && msg.response?.contentType && !msg.response.headers["Content-Type"]) {
          init.headers["Content-Type"] = msg.response.contentType;
        }
        const res = new Response(msg.response?.body ?? "", init);
        await c.put(req, res);
        return true;
      }
      case "delete": {
        const c = await caches.open(msg.name);
        return await c.delete(msg.request);
      }
      case "clear": {
        const c = await caches.open(msg.name);
        const reqs = await c.keys();
        await Promise.all(reqs.map((r) => c.delete(r)));
        return true;
      }
    }
  }

  async function handleIdb(msg) {
    const openDB = (name, version, upgrade) => new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = (e) => { if (upgrade) upgrade(e.target.result); };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });

    switch (msg.op) {
      case "databases":
        return indexedDB.databases ? await indexedDB.databases() : null;
      case "stores": {
        const db = await openDB(msg.db);
        const names = Array.from(db.objectStoreNames);
        db.close();
        return names;
      }
      case "get": {
        const db = await openDB(msg.db);
        return await tx(db, msg.store, "readonly", (s) => reqP(s.get(msg.key))).finally(() => db.close());
      }
      case "put": {
        const db = await openDB(msg.db);
        return await tx(db, msg.store, "readwrite", (s) => reqP(s.put(msg.value, msg.key))).finally(() => db.close());
      }
      case "del": {
        const db = await openDB(msg.db);
        return await tx(db, msg.store, "readwrite", (s) => reqP(s.delete(msg.key))).finally(() => db.close());
      }
      case "count": {
        const db = await openDB(msg.db);
        return await tx(db, msg.store, "readonly", (s) => reqP(s.count(msg.query))).finally(() => db.close());
      }
      case "keys": {
        const db = await openDB(msg.db);
        return await tx(db, msg.store, "readonly", (s) => reqP(s.getAllKeys(msg.query, msg.limit))).finally(() => db.close());
      }
      case "getAll": {
        const db = await openDB(msg.db);
        return await tx(db, msg.store, "readonly", (s) => reqP(s.getAll(msg.query, msg.limit))).finally(() => db.close());
      }
    }
  }

  function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  function reqP(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;
    handle(msg).then(sendResponse, (e) => sendResponse(err(e.message)));
    return true;
  });
})();