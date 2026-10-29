// 拡張 content.js をNodeで読み込み、window.__osfhArticleGuard を取り出す最小の台
const fs = require("fs"), vm = require("vm");
function load(path) {
  const noop = () => {};
  const elem = () => ({ addEventListener: noop, removeEventListener: noop, appendChild: noop, setAttribute: noop, style: {}, classList: { add: noop, remove: noop, contains: () => false }, querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, textContent: "", innerText: "", children: [] });
  const store = {};
  const ctx = {
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 5)), clearTimeout, setInterval: () => 0, clearInterval: noop,
    location: { href: "https://chatgpt.com/c/6ae251cf-test", pathname: "/c/6ae251cf-test", hostname: "chatgpt.com", origin: "https://chatgpt.com" },
    document: Object.assign(elem(), { readyState: "complete", hidden: false, body: elem(), documentElement: elem(), head: elem(), createElement: elem, getElementById: () => null, addEventListener: noop }),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    chrome: { runtime: { sendMessage: noop, onMessage: { addListener: noop }, getURL: x => x, id: "x" }, storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() }, onChanged: { addListener: noop } } },
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { userAgent: "node" }, fetch: async () => ({ ok: false, json: async () => ({}) }),
    URL, TextEncoder, TextDecoder, crypto: require("crypto").webcrypto, performance: { now: () => 0 },
    Node: {}, HTMLElement: class {}, Event: class {}, KeyboardEvent: class {}, InputEvent: class {}, CustomEvent: class {},
    requestAnimationFrame: noop, getComputedStyle: () => ({}),
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.addEventListener = noop; ctx.removeEventListener = noop;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path, "utf8"), ctx, { filename: path });
  const g = ctx.window.__osfhArticleGuard;
  if (g) g.__ctx = ctx;   // 試験から localStorage・画面を触るため
  return g;
}
module.exports = { load };
