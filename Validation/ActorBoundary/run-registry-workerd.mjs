import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
assert.ok(process.env.SWIFT_WEB_NODE_MODULES);
const modules = resolve(process.env.SWIFT_WEB_NODE_MODULES);
const require = createRequire(resolve(modules, "../package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const bundle = await build({
  entryPoints: [resolve(root, "registry-worker.mjs")], nodePaths: [modules],
  bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], write: false,
});
const runtime = new Miniflare({
  name: "runtime-registry", compatibilityDate: "2026-08-05", inspectorPort: 0,
  modules: true, script: bundle.outputFiles[0].text,
  durableObjects: { OWNERS: { className: "RuntimeOwner", useSQLite: true } },
});
let debuggerSocket;
try {
  const get = async (path) => {
    const response = await runtime.dispatchFetch("http://registry.test" + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const [a, b] = await Promise.all([get("/inspect?name=a"), get("/inspect?name=b")]);
  assert.notEqual(a.id, b.id, "Separate DO owners must share one unique identity allocator");
  assert.equal((await get(`/dispatch?id=${a.id}&rendering=${b.id}`)).delivered, false);
  for (const id of [b.id, a.id]) assert.equal((await get(`/dispatch?id=${id}&rendering=${id}`)).delivered, true);
  assert.equal((await get("/inspect?name=a")).delivered, 1);
  assert.equal((await get("/inspect?name=b")).delivered, 1);
  assert.equal((await get("/release?name=a")).released, true);
  assert.equal((await get(`/dispatch?id=${a.id}&rendering=${a.id}`)).delivered, false);

  // Eviction is a platform action, not the adapter's explicit shutdown handshake.
  await runtime.unsafeEvictDurableObject("runtime-registry", "RuntimeOwner", { name: "b" });
  const inspector = await runtime.getInspectorURL();
  inspector.protocol = "http:";
  const targets = await (await fetch(new URL("/json/list", inspector))).json();
  const target = targets.find((entry) => entry.id.includes("runtime-registry"));
  assert.ok(target, JSON.stringify(targets));
  debuggerSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    debuggerSocket.addEventListener("open", resolve, { once: true });
    debuggerSocket.addEventListener("error", reject, { once: true });
  });
  let commandID = 0;
  let contextID;
  debuggerSocket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Runtime.executionContextCreated") contextID = event.params.context.id;
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandID;
    const timer = setTimeout(() => reject(new Error(method + " timed out")), 5000);
    const complete = ({ data }) => {
      const result = JSON.parse(data);
      if (result.id !== id) return;
      debuggerSocket.removeEventListener("message", complete);
      clearTimeout(timer);
      if (result.error) reject(new Error(JSON.stringify(result.error)));
      else resolve();
    };
    debuggerSocket.addEventListener("message", complete);
    debuggerSocket.send(JSON.stringify({ id, method, params }));
  });
  await command("Runtime.enable");
  await command("Runtime.evaluate", { expression: "1 + 1", contextId: contextID });
  await command("HeapProfiler.enable");
  const collection = command("HeapProfiler.collectGarbage");
  await get(`/dispatch?id=${a.id}&rendering=${a.id}`);
  await collection;
  const collected = await get(`/collected?id=${b.id}`);
  assert.ok(Object.values(collected).every(Boolean), JSON.stringify(collected));
  assert.equal((await get(`/dispatch?id=${b.id}&rendering=${b.id}`)).delivered, false);
  const replacement = await get("/inspect?name=b");
  assert.notEqual(replacement.id, b.id);
  assert.equal(replacement.delivered, 0);
  console.log(JSON.stringify({ distinctOwners: [a.id, b.id], collected, replacement }));
} finally {
  debuggerSocket?.close();
  await runtime.dispose();
}
