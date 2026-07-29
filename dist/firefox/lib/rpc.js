export class Rpc {
  constructor() {
    this.methods = new Map();
  }
  register(method, fn) { this.methods.set(method, fn); }
  registerAll(map) { for (const k in map) this.methods.set(k, map[k]); }

  async handle(msg, transport) {
    if (msg == null || typeof msg !== "object") return;
    if (Array.isArray(msg)) {
      const out = [];
      for (const m of msg) {
        const r = await this._one(m, transport);
        if (r) out.push(r);
      }
      if (out.length) transport.sendObj(out);
      return;
    }
    const r = await this._one(msg, transport);
    if (r) transport.sendObj(r);
  }

  async _one(msg, transport) {
    const { id, method, params = {} } = msg;
    const fn = this.methods.get(method);
    if (!fn) {
      if (id === undefined) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    const ctx = {
      transport,
      notify: (m, p) => transport.sendObj({ jsonrpc: "2.0", method: m, params: p }),
    };
    try {
      const result = await fn(params || {}, ctx);
      if (id === undefined) return null;
      return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
    } catch (e) {
      if (id === undefined) return null;
      return {
        jsonrpc: "2.0", id,
        error: { code: e.code || -32000, message: e.message || String(e), data: e.data },
      };
    }
  }
}