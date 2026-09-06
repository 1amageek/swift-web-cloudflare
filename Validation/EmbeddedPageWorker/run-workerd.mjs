import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [directory, nativeOrigin] = process.argv.slice(2);
assert.ok(directory && nativeOrigin, "Usage: run-workerd.mjs <cloudflare-directory> <native-origin>");
const root = resolve(directory);
const nativeURL = new URL(nativeOrigin);
assert.equal(nativeURL.protocol, "http:");
assert.equal(nativeURL.hostname, "127.0.0.1", "The fixture only connects to its local Native peer");
const modules = process.env.SWIFT_WEB_NODE_MODULES ?? resolve(root, "node_modules");
const require = createRequire(resolve(modules, "../package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const services = JSON.parse(await readFile(resolve(root, "swiftweb-actor-services.json"), "utf8"));
assert.equal(services.length, 1, "This fixture owns one Actor service");
const { bindingName, className, scriptName } = services[0].configuration;
assert.match(className, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
assert.ok(bindingName && scriptName);
assert.notEqual(scriptName, "embedded-page");

// This is a real workerd Durable Object. Only owned binary frames and their
// invocation context cross to the Native host; the proxy cannot produce results.
const proxySource = `
import { DurableObject } from "cloudflare:workers";
class NativeActorProxy extends DurableObject {
  async invokeActorFrame(frame, context) {
    if (!(frame instanceof Uint8Array) || frame.byteLength === 0 || frame.byteLength > 16 * 1024 * 1024) {
      throw new TypeError("Invalid Actor frame");
    }
    if (!context || typeof context.peerID !== "string" || !context.peerID
        || typeof context.hostedActorIdentity !== "string" || !context.hostedActorIdentity) {
      throw new TypeError("Missing Actor invocation context");
    }
    const response = await fetch(${JSON.stringify(new URL("/frame", nativeURL).href)}, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.swift-actor-frame",
        "X-SwiftWeb-Actor-Peer-ID": context.peerID,
        "X-SwiftWeb-Hosted-Actor-Identity": context.hostedActorIdentity,
      },
      body: frame,
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 204) return null;
    if (response.status !== 200 || response.headers.get("content-type") !== "application/vnd.swift-actor-frame") {
      throw new Error("Native Actor frame rejected: " + response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) {
      throw new TypeError("Invalid Native Actor response frame");
    }
    return bytes;
  }
}
export { NativeActorProxy as ${className} };
export default { fetch() { return new Response("Not found", { status: 404 }); } };
`;

const bundled = await build({
  stdin: {
    resolveDir: root,
    sourcefile: "validation-entry.ts",
    loader: "ts",
    contents: `
import application from "./src/index.ts";
const clock = { active: 0, fired: 0, aborted: 0, firedDeadline: 0 };
const nativeWait = scheduler.wait.bind(scheduler);
// Observe the production clock while delegating every wait to workerd.
scheduler.wait = async (delay, options) => {
  clock.active++;
  try {
    await nativeWait(delay, options);
    clock.fired++;
    // Match the fixture's 750 ms call budget, excluding its 2.1 s grace waits.
    if (delay >= 500 && delay <= 750) clock.firedDeadline++;
  } catch (error) {
    clock.aborted++;
    throw error;
  } finally {
    clock.active--;
  }
};
export default {
  fetch(request, environment, context) {
    if (new URL(request.url).pathname === "/__validation/clock") return Response.json(clock);
    return application.fetch(request, environment, context);
  }
};
`,
  },
  nodePaths: [modules],
  bundle: true,
  format: "esm",
  platform: "browser",
  external: ["./app.wasm"],
  write: false,
});
const runtime = new Miniflare({
  workers: [
    {
      name: "embedded-page",
      compatibilityDate: "2026-08-05",
      modulesRoot: root,
      modules: [
        { type: "ESModule", path: resolve(root, "page.mjs"), contents: bundled.outputFiles[0].text },
        { type: "CompiledWasm", path: resolve(root, "app.wasm"), contents: await readFile(resolve(root, "src/app.wasm")) },
      ],
      durableObjects: { [bindingName]: { className, scriptName } },
    },
    {
      name: scriptName,
      compatibilityDate: "2026-08-05",
      modulesRoot: root,
      modules: [{ type: "ESModule", path: resolve(root, "proxy.mjs"), contents: proxySource }],
      durableObjects: { LOCAL_PROXY: { className } },
    },
  ],
});
try {
  await bounded((async () => {
    const response = await runtime.dispatchFetch("http://embedded-page.test/");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    for (const outcome of [
      "actor-result:42",
      "typed-failure:rejected(-42)",
      "cancel:cancelled/active:0/completed:0",
      "deadline:timeout",
      "core:stopped/system-failure:shuttingDown",
    ]) {
      assert.ok(body.includes(outcome), `Missing ${outcome}: ${body}`);
    }
    const clockResponse = await runtime.dispatchFetch("http://embedded-page.test/__validation/clock");
    assert.equal(clockResponse.status, 200);
    const clock = await clockResponse.json();
    assert.ok(clock.firedDeadline >= 1, "The caller's 750 ms Cloudflare deadline must fire, not only the Native deadline");
    assert.equal(clock.active, 0, "Core shutdown must leave no active Cloudflare clock waits");
    console.log(`cloudflare-clock=${JSON.stringify(clock)}`);
  })(), 20000, "Generated page and Actor outcomes");
  console.log("generated-page=200 actor-outcomes=passed transport=workerd-durable-object-rpc-native");
} finally {
  await bounded(runtime.dispose(), 10000, "workerd disposal");
  console.log("workerd-disposal=terminal");
}
