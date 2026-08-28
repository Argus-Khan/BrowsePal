import { activeTabId } from "./browser.js";

export function createNetApi(cdp) {
  const logs = new Map();      // tabId -> Map(requestIdNormalized -> entry)
  const interceptors = new Map(); // tabId -> [{id, match:RegExp, status, headers, body, contentType, block}]

  function norm(id) { return typeof id === "object" ? id.id || id.networkId || JSON.stringify(id) : String(id); }
  function logFor(tabId) {
    if (!logs.has(tabId)) logs.set(tabId, new Map());
    return logs.get(tabId);
  }
  async function exec(tabId, method, params) {
    await cdp.attach(tabId);
    return cdp.send(tabId, method, params);
  }

  async function enable(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    await exec(tabId, "Network.enable");
    await exec(tabId, "Page.enable");
    return { tabId, attached: true };
  }

  async function disable(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    try { await exec(tabId, "Network.disable"); } catch (e) {}
    try { await exec(tabId, "Page.disable"); } catch (e) {}
    return { tabId, attached: false };
  }

  async function getLog(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    const filter = params.filter || {};
    const list = [];
    for (const entry of logFor(tabId).values()) {
      if (filter.url && !(entry.url && entry.url.includes(filter.url))) continue;
      if (filter.method && entry.method !== filter.method) continue;
      if (filter.type && entry.type && entry.type !== filter.type) continue;
      list.push(entry);
    }
    return list;
  }

  async function getRequest(params) {
    const tabId = params.tabId;
    const rid = norm(params.requestId);
    const entry = logFor(tabId).get(rid);
    if (!entry) return null;
    const out = { ...entry };
    if (entry.hasRequestData === false && entry.requestIdRaw) {
      try {
        const r = await exec(tabId, "Network.getRequestPostData", { requestId: entry.requestIdRaw });
        out.requestPostData = r.postData;
      } catch (e) {}
    }
    if (entry.responseReceived) {
      try {
        const r = await exec(tabId, "Network.getResponseBody", { requestId: entry.requestIdRaw });
        out.body = r.body;
        out.base64Encoded = r.base64Encoded;
      } catch (e) {}
    }
    return out;
  }

  function clear(params) {
    const tabId = params.tabId != null ? params.tabId : null;
    if (tabId == null) { for (const m of logs.values()) m.clear(); }
    else { const m = logs.get(tabId); if (m) m.clear(); }
    return { cleared: true };
  }

  async function throttle(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    await exec(tabId, "Network.emulateNetworkConditions", {
      offline: !!params.offline,
      downloadThroughput: (params.downloadKbps != null ? params.downloadKbps : -1) * 1000,
      uploadThroughput: (params.uploadKbps != null ? params.uploadKbps : -1) * 1000,
      latency: params.latencyMs || 0,
    });
    return { throttled: true };
  }

  async function setBlocked(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    const regs = (params.patterns || []).map((p) => ({ reg: (p && typeof p === "object" && p.match) ? new RegExp(p.match) : new RegExp(String(p)), block: true }));
    let list = interceptors.get(tabId) || [];
    list = list.filter((i) => !i.__blockAll);
    for (const r of regs) list.push({ id: `block-${Math.random().toString(36).slice(2)}`, match: r.reg, block: true, __blockAll: true });
    interceptors.set(tabId, list);
    await enableFetch(tabId);
    return { blocked: regs.length };
  }

  async function addInterceptor(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    const list = interceptors.get(tabId) || [];
    const items = (params.patterns || []).map((p) => ({
      id: `int-${Math.random().toString(36).slice(2)}`,
      match: new RegExp(p.match),
      status: p.status != null ? p.status : 200,
      headers: p.headers || { "Content-Type": p.contentType || "application/json" },
      body: typeof p.body === "string" ? p.body : JSON.stringify(p.body != null ? p.body : ""),
    }));
    interceptors.set(tabId, list.concat(items));
    await enableFetch(tabId);
    return { interceptors: items.map((i) => ({ id: i.id })) };
  }

  async function removeInterceptor(params) {
    const tabId = params.tabId != null ? params.tabId : await activeTabId();
    let list = interceptors.get(tabId) || [];
    list = list.filter((i) => i.id !== params.id);
    interceptors.set(tabId, list);
    if (!list.length) try { await exec(tabId, "Fetch.disable"); } catch (e) {}
    return { removed: true };
  }

  async function enableFetch(tabId) {
    await exec(tabId, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }],
      handleAuthRequests: false,
    });
  }

  async function handlePaused(ev) {
    const { tabId, params } = ev;
    const list = interceptors.get(tabId) || [];
    let hit = null;
    for (const i of list) { if (i.match.test(params.request.url)) { hit = i; break; } }
    try {
      if (hit) {
        if (hit.block) {
          await exec(tabId, "Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" });
          return { blocked: true };
        }
        await exec(tabId, "Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: hit.status,
          responseHeaders: Object.entries(hit.headers).map(([n, v]) => ({ name: n, value: String(v) })),
          body: btoa(unescape(encodeURIComponent(hit.body || ""))),
        });
        return { fulfilled: true };
      }
      await exec(tabId, "Fetch.continueRequest", { requestId: params.requestId });
      return { continued: true };
    } catch (e) {
      try { await exec(tabId, "Fetch.continueRequest", { requestId: params.requestId }); } catch (_) {}
      return { error: e.message };
    }
  }

  function _onCDPEvent(ev, ctx) {
    const { tabId, method, params } = ev;
    if (method === "Fetch.requestPaused") {
      handlePaused(ev).catch(() => {});
      if (ctx) ctx.notify("net.requestPaused", { tabId, requestId: norm(params.requestId), url: params.request.url });
      return;
    }
    if (!params || params.requestId == null) return;
    const rid = norm(params.requestId);
    const store = logFor(tabId);
    let entry = store.get(rid) || { requestId: rid, requestIdRaw: params.requestId, url: null, method: null, type: null, status: null, headers: {}, body: null, startedAt: Date.now(), hasRequestData: false, responseReceived: false };
    entry = { ...entry };
    if (method === "Network.requestWillBeSent") {
      entry.url = params.request.url;
      entry.method = params.request.method;
      entry.type = params.type;
      entry.headers = params.request.headers || {};
      entry.hasRequestData = params.request.hasPostData || false;
      entry.startedAt = (params.timestamp ? params.timestamp * 1000 : Date.now());
    } else if (method === "Network.responseReceived") {
      entry.responseReceived = true;
      entry.status = params.response && params.response.status;
      entry.statusText = params.response && params.response.statusText;
      entry.responseHeaders = params.response && params.response.headers;
      entry.mimeType = params.response && params.response.mimeType;
      entry.remoteIP = params.response && params.response.remoteIPAddress;
    } else if (method === "Network.loadingFinished") {
      entry.finishedAt = (params.timestamp ? params.timestamp * 1000 : Date.now());
      entry.encodedDataLength = params.encodedDataLength;
    } else if (method === "Network.loadingFailed") {
      entry.failedAt = (params.timestamp ? params.timestamp * 1000 : Date.now());
      entry.error = params.errorText;
      entry.failed = true;
    }
    store.set(rid, entry);
    if (ctx) ctx.notify("net." + method.split(".")[1], { tabId, requestId: rid, url: entry.url, method: entry.method, status: entry.status });
  }

  return {
    enable, disable, getLog, getRequest, clear, throttle, setBlocked, addInterceptor, removeInterceptor,
    _onCDPEvent,
  };
}