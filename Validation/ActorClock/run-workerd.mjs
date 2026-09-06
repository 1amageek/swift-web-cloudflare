import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const bundled = await build({
  entryPoints: ["worker.mjs"], bundle: true, format: "esm", platform: "browser",
  external: ["./app.wasm"], write: false,
});
const runtime = new Miniflare({
  compatibilityDate: "2026-08-01",
  modulesRoot: process.cwd(),
  modules: [
    { type: "ESModule", path: resolve("clock.mjs"), contents: bundled.outputFiles[0].text },
    { type: "CompiledWasm", path: resolve("app.wasm"), contents: await readFile("app.wasm") },
  ],
});
try {
  const response = await runtime.dispatchFetch("http://clock.test/");
  assert.equal(response.status, 200);
  const report = await response.json();
  console.log(JSON.stringify(report));
  assert.equal(report.result, "passed");
  assert.equal(report.atCompletion.active, 0);
  assert.equal(report.atCompletion.firedLong, 0);
  assert.equal(report.atCompletion.cancelledLong, 4);
  assert.deepEqual(report.afterGrace, report.atCompletion);
  const unavailableResponse = await runtime.dispatchFetch("http://clock.test/unavailable");
  assert.equal(unavailableResponse.status, 200);
  const unavailable = await unavailableResponse.json();
  console.log(JSON.stringify({ unavailable }));
  assert.equal(unavailable.result, "passed");
  assert.deepEqual(unavailable.atCompletion, {
    active: 0, fired: 0, aborted: 0, cancelledLong: 0, firedLong: 0,
  });
  assert.deepEqual(unavailable.afterGrace, unavailable.atCompletion);
} finally {
  await runtime.dispose();
}
