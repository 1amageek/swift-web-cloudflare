import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
assert.ok(process.env.SWIFT_WEB_NODE_MODULES, "Set SWIFT_WEB_NODE_MODULES to the existing verification dependencies");
const modules = resolve(process.env.SWIFT_WEB_NODE_MODULES);
const require = createRequire(resolve(modules, "../package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const bundled = await build({
  entryPoints: [resolve(root, "worker.mjs")],
  nodePaths: [modules],
  bundle: true,
  format: "esm",
  platform: "browser",
  external: ["./app.wasm", "cloudflare:workers"],
  write: false,
});
const runtime = new Miniflare({
  workers: [
    {
      name: "actor-boundary",
      compatibilityDate: "2026-08-05",
      modulesRoot: root,
      modules: [
        { type: "ESModule", path: resolve(root, "probe.mjs"), contents: bundled.outputFiles[0].text },
        { type: "CompiledWasm", path: resolve(root, "app.wasm"), contents: await readFile(process.env.SWIFT_WEB_ACTOR_PROGRAM ?? resolve(root, "app.wasm")) },
      ],
      durableObjects: { ECHO: { className: "Echo", scriptName: "actor-peer" }, PAGE: { className: "PageIsolationProbe" } },
    },
    {
      name: "actor-peer",
      compatibilityDate: "2026-08-05",
      modules: true,
      script: `
        import { DurableObject } from "cloudflare:workers";
        export class Echo extends DurableObject {
          echo(frame) {
            if (!(frame instanceof Uint8Array)) throw new TypeError("Expected an owned frame");
            return frame;
          }
        }
        export default { fetch() { return new Response(null, { status: 404 }); } };
      `,
      durableObjects: { ECHO: { className: "Echo" } },
    },
  ],
});
try {
  const response = await runtime.dispatchFetch("http://actor-boundary.test/requests");
  const report = await response.json();
  console.log(JSON.stringify(report));
  assert.equal(response.status, 200);
  assert.deepEqual(report.outcomes, {
    0: "bytes", 1: "overloaded", 2: "unavailable", 3: "closed", 4: "cancelled",
    5: "cancelled", 6: "cancelled", 7: "empty", 8: "overloaded", 9: "overloaded",
  });
  assert.equal(report.calls[6], undefined, "A pre-cancelled request must not dispatch");
  assert.equal(Object.keys(report.calls).length, 9);
  assert.ok(Object.values(report.calls).every(count => count === 1), "The adapter must not retry");
  assert.equal(report.aborted, 2, "Cancellation and shutdown must both abort the platform request");
  assert.equal(report.diagnostics.length, 6);
  for (const diagnostic of report.diagnostics) {
    assert.equal(diagnostic.runtimeID, 7);
    assert.match(diagnostic.callID, /^7:g1-r[1-9][0-9]*$/);
    assert.equal(diagnostic.requestID, "1");
    assert.equal(diagnostic.phase, "dispatch");
  }
  assert.equal(report.errors[3], "runtime=7 call=7:g1-r4 actor-system:14");
  assert.equal(report.errors[4], "runtime=7 call=7:g1-r5 actor-system:16");
  const interrupted = runtime.dispatchFetch("http://actor-boundary.test/pages/cancelled");
  const peer = runtime.dispatchFetch("http://actor-boundary.test/pages/hold");
  const cancelledResponse = await interrupted;
  const cancelled = await cancelledResponse.json();
  assert.equal(cancelledResponse.status, 499);
  assert.equal(cancelled.name, "PageRequestCancellationError");
  assert.equal(cancelled.retained, 2);
  await runtime.dispatchFetch("http://actor-boundary.test/pages/release");
  assert.equal((await peer).status, 200);
  assert.equal((await runtime.dispatchFetch("http://actor-boundary.test/pages/health")).status, 200);
  const failed = await runtime.dispatchFetch("http://actor-boundary.test/pages/transport");
  const failure = await failed.json();
  assert.equal(failed.status, 500);
  assert.match(failure.body, /Something went wrong/);
  assert.doesNotMatch(failure.body, /private|actor-system|g1-r/);
  const pages = await (await runtime.dispatchFetch("http://actor-boundary.test/pages/state")).json();
  assert.equal(pages.pending, 0);
  assert.deepEqual(pages.violations, []);
  assert.equal(pages.diagnostics.length, 1);
  assert.match(pages.diagnostics[0][1], /^[0-9]+:g1-r4$/);
  console.log(JSON.stringify({ pageIsolation: pages, cancelled }));
  const hostModes = process.argv.includes("--requests-only") ? [] : ["host", "startup-failure", "startup-shutdown"];
  for (const mode of hostModes) {
    const response = await runtime.dispatchFetch(`http://actor-boundary.test/${mode}`);
    const report = await response.json();
    console.log(JSON.stringify({ mode, ...report }));
    assert.equal(response.status, 200);
    assert.equal(report.early, "failed", "Bootstrap must finish before admission");
    assert.equal(report.stopped, "failed", "Shutdown must stop admission");
    assert.equal(report.wrongShutdownRuntime, "failed", "Another runtime must not stop this host");
    assert.equal(report.shutdown, "stopped", "The production terminal bridge must join Core shutdown");
    assert.equal(report.repeatedShutdown, "failed", "A stopped bridge must reject another terminal request");
    assert.equal(report.events.filter(event => event[0] === "shutdown" && event[3] === "stopped").length, 1);
    assert.deepEqual(report.events.find(event => event[0] === "bootstrap"), ["bootstrap", 42, 19]);
    assert.equal(report.events.filter(event => event[0] === "ready" || event[0] === "startup-failed").length, 1);
    if (mode === "host") {
      assert.equal(report.ready, "ready");
      assert.deepEqual(report.successful, ["completed", "completed"]);
      assert.equal(report.mismatch, "failed");
      assert.equal(report.wrongRuntime, "failed");
      assert.equal(report.oversize, "failed");
      assert.ok(report.events.some(event => event[0] === "failed" && /unauthorized/.test(event[3])));
    } else {
      assert.equal(report.ready, "failed");
    }
  }
} finally {
  await runtime.dispose();
}
