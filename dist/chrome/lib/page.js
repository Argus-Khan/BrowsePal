import { chrome, cb, withTab } from "./browser.js";

function sendToTab(tabId, frameId, message) {
  const opts = frameId != null ? { frameId } : undefined;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      message,
      opts,
      (result) => {
        const e = chrome.runtime.lastError;
        resolve(e ? { __error: e.message } : result);
      }
    );
  });
}

export function createPageApi() {
  async function forward(tabId, frameId, type, data = {}) {
    tabId = await withTab(tabId);
    const res = await sendToTab(tabId, frameId, { type, ...data });
    if (!res) throw Object.assign(new Error(`No content script in tab ${tabId} (try reloading the page)`), { code: -32002 });
    if (res.__error) throw Object.assign(new Error(res.__error), { code: -32003 });
    if (res.err) throw Object.assign(new Error(res.err), { code: -32004 });
    return res.ok;
  }

  async function evalJs(params) {
    const tabId = await withTab(params.tabId);
    if (params.frameId != null) {
      return forward(tabId, params.frameId, "eval", { code: params.code });
    }
    return forward(tabId, null, "eval", { code: params.code });
  }

  async function frames(params) {
    const tabId = await withTab(params.tabId);
    const all = await cb(chrome.webNavigation.getAllFrames, { tabId });
    return (all || []).map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url }));
  }

  async function screenshot(params) {
    const tabId = await withTab(params.tabId);
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const quality = typeof params.quality === "number" ? params.quality : 90;
    const dataUrl = await cb(chrome.tabs.captureVisibleTab, undefined, { format, quality });
    return { format, dataUrl };
  }

  async function navigate(params) {
    const tabId = await withTab(params.tabId);
    await cb(chrome.tabs.update, tabId, { url: params.url });
    return { navigated: true, tabId, url: params.url };
  }

  async function reload(params) {
    const tabId = await withTab(params.tabId);
    await cb(chrome.tabs.reload, tabId, { bypassCache: !!params.bypassCache });
    return { reloaded: true, tabId };
  }

  const wrapSimple = (type) => (params) => forward(params.tabId, params.frameId, type, params);

  return {
    eval: evalJs,
    getOuterHTML: wrapSimple("getOuterHTML"),
    getText: wrapSimple("getText"),
    querySelector: wrapSimple("querySelector"),
    querySelectorAll: wrapSimple("querySelectorAll"),
    getValue: wrapSimple("getValue"),
    setValue: wrapSimple("setValue"),
    click: wrapSimple("click"),
    hover: wrapSimple("hover"),
    focus: wrapSimple("focus"),
    type: wrapSimple("type"),
    pressKey: wrapSimple("pressKey"),
    scroll: wrapSimple("scroll"),
    scrollIntoView: wrapSimple("scrollIntoView"),
    waitFor: wrapSimple("waitFor"),
    screenshot,
    navigate,
    reload,
    frames,
  };
}