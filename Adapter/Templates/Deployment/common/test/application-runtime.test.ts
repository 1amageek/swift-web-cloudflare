import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { swiftWebActorFrameLimits } from "../src/actor-frame-limits.ts";
import {
  ApplicationRuntime,
  ApplicationRuntimeRegistry,
  createPageRuntimeCoordinator,
} from "../src/application-runtime.ts";

const bridge = globalThis as Record<string, any>;
const context = { peerID: "caller", hostedActorIdentity: "expected" };
const request = {
  method: "GET", path: "/", search: "", scheme: "https", host: "page.test",
  encodedHeaders: "", encodedBody: "",
};

test("separately loaded common modules share one isolate registry", async () => {
  const copy = await import("../src/application-runtime.ts?independent-module");
  const make = (Runtime: typeof ApplicationRuntime) => new Runtime({ exports: {
    renderApplication() {
      const id = bridge.__swiftWebRuntimeID;
      queueMicrotask(() => bridge.swiftWebDidRender(id, id));
    },
    invokeActorFrame() {
      const id = bridge.__swiftWebRuntimeID;
      const call = bridge.__swiftWebActorFrameCallID;
      queueMicrotask(() => bridge.swiftWebDidInvokeActorFrame(id, call, "AQ=="));
    },
    shutdownActorService() {
      bridge.swiftWebActorServiceShutdownCompleted(bridge.__swiftWebRuntimeID, bridge.__swiftWebShutdownCallID);
    },
  } });
  const a = make(ApplicationRuntime);
  const b = make(copy.ApplicationRuntime);
  assert.notEqual(a.id, b.id);
  await Promise.all([a.render(), b.render()]);
  await a.shutdown();
  assert.deepEqual(await b.invokeActorFrame(new Uint8Array(), context), new Uint8Array([1]));
  await b.shutdown();
});

test("Actor bridge bounds bytes before encoding and validates responses before decoding", async (t) => {
  const maximum = swiftWebActorFrameLimits.maximumFrameByteCount;
  let calls = 0;
  let reply = "";
  const runtime = new ApplicationRuntime({ exports: {
    invokeActorFrame() {
      calls++;
      bridge.swiftWebDidInvokeActorFrame(bridge.__swiftWebRuntimeID, bridge.__swiftWebActorFrameCallID, reply);
    },
    shutdownActorService() {
      bridge.swiftWebActorServiceShutdownCompleted(bridge.__swiftWebRuntimeID, bridge.__swiftWebShutdownCallID);
    },
  } });
  assert.throws(() => runtime.invokeActorFrame(new Uint8Array(maximum + 1), context), /exceeds/);
  assert.equal(calls, 0);
  const boundary = new Uint8Array(maximum);
  reply = Buffer.from(boundary).toString("base64");
  assert.deepEqual(await runtime.invokeActorFrame(boundary, context), boundary);
  let decodes = 0;
  const decode = globalThis.atob;
  t.mock.method(globalThis, "atob", (value) => { decodes++; return decode(value); });
  for (reply of [
    "A".repeat(4 * Math.ceil(maximum / 3) + 4),
    "A".repeat(4 * Math.ceil(maximum / 3)), "AB==", "AA==\n", "A",
  ]) {
    await assert.rejects(runtime.invokeActorFrame(new Uint8Array(), context), /limit|canonical/);
  }
  assert.equal(decodes, 0);
  await runtime.shutdown();
});

test("actor shutdown retains routes until matching Core completion and stops admission", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => errors.push(values));
  let startup: number[] = [];
  let invocation: [number, string] = [0, ""];
  let terminal: [number, string] = [0, ""];
  let stopCount = 0;
  const runtime = new ApplicationRuntime({ exports: {
    renderApplication() { startup = [bridge.__swiftWebRuntimeID, bridge.__swiftWebRenderingID]; },
    invokeActorFrame() { invocation = [bridge.__swiftWebRuntimeID, bridge.__swiftWebActorFrameCallID]; },
    shutdownActorService() {
      stopCount++;
      terminal = [bridge.__swiftWebRuntimeID, bridge.__swiftWebShutdownCallID];
    },
  } });
  const ready = runtime.render();
  bridge.swiftWebDidRender(...startup);
  await ready;
  assert.throws(() => runtime.render(), /already been requested/);
  const reply = runtime.invokeActorFrame(new Uint8Array([1]), context);
  const stopped = runtime.shutdown();
  assert.strictEqual(runtime.shutdown(), stopped);
  assert.equal(stopCount, 1);
  assert.throws(() => runtime.invokeActorFrame(new Uint8Array(), context), /stopping/);
  assert.throws(() => runtime.render(), /stopping/);
  bridge.swiftWebActorServiceShutdownCompleted(terminal[0], "another-call");
  assert.equal(errors.length, 1);
  // In-flight callbacks remain owned while the terminal call is pending.
  bridge.swiftWebDidInvokeActorFrame(...invocation, "Ag==");
  assert.deepEqual(await reply, new Uint8Array([2]));
  bridge.swiftWebActorServiceShutdownCompleted(...terminal);
  await stopped;
  bridge.swiftWebActorServiceShutdownCompleted(...terminal);
  bridge.swiftWebDidInvokeActorFrame(...invocation, "Ag==");
  assert.equal(errors.length, 3, "Released callbacks must not be delivered");
});

test("terminal failure rejects pending startup and actor calls and releases routing", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => errors.push(values));
  let terminal: [number, string] = [0, ""];
  const runtime = new ApplicationRuntime({ exports: {
    renderApplication() {}, invokeActorFrame() {},
    shutdownActorService() { terminal = [bridge.__swiftWebRuntimeID, bridge.__swiftWebShutdownCallID]; },
  } });
  const ready = assert.rejects(runtime.render(), /Core stopped with failure/);
  const reply = assert.rejects(runtime.invokeActorFrame(new Uint8Array(), context), /Core stopped with failure/);
  const stopped = assert.rejects(runtime.shutdown(), /Core stopped with failure/);
  bridge.swiftWebActorServiceShutdownFailed(...terminal, "Core stopped with failure");
  await Promise.all([ready, reply, stopped]);
  assert.throws(() => runtime.invokeActorFrame(new Uint8Array(), context), /terminal/);
  bridge.swiftWebActorServiceShutdownFailed(...terminal, "duplicate");
  assert.equal(errors.length, 1);
});

test("a missing shutdown export is terminal failure, not successful Core completion", async () => {
  const runtime = new ApplicationRuntime({ exports: {} });
  await assert.rejects(runtime.shutdown(), /shutdownActorService.*missing/);
  assert.throws(() => runtime.render(), /terminal/);
});

test("two Page coordinators share one routing table without crossing local generation IDs", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => errors.push(values));
  const starts: [number, number][] = [];
  const renders: [number, string][] = [];
  const memories: WebAssembly.Memory[] = [];
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  t.mock.method(WebAssembly, "instantiate", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    memories.push(memory);
    return { exports: {
      memory,
      swjs_library_version() { return 709; },
      renderApplication() { starts.push([bridge.__swiftWebRuntimeID, bridge.__swiftWebRenderingID]); },
      respondToRequest() { renders.push([bridge.__swiftWebRuntimeID, bridge.__swiftWebRequestCallID]); },
    } };
  });
  const first = createPageRuntimeCoordinator(module, { retirementThresholdBytes: 131072 });
  const second = createPageRuntimeCoordinator(module, { retirementThresholdBytes: 131072 });
  const a = first.render(undefined, request);
  const b = second.render(undefined, request);
  await until(() => starts.length === 2);
  assert.notEqual(starts[0][0], starts[1][0]);
  bridge.swiftWebDidRender(starts[1][0], starts[0][1]);
  assert.equal(first.pendingStartCount, 1);
  assert.equal(second.pendingStartCount, 1);
  for (const start of starts) bridge.swiftWebDidRender(...start);
  await until(() => renders.length === 2);
  assert.match(renders[0][1], /:g1-r1$/);
  assert.match(renders[1][1], /:g1-r1$/);
  assert.notEqual(renders[0][1], renders[1][1]);
  bridge.swiftWebDidRespond(renders[0][0], renders[1][1], 200, "", "WA==");
  assert.equal(first.pendingRenderCount, 1);
  assert.equal(second.pendingRenderCount, 1);
  bridge.swiftWebDidRespond(...renders[1], 202, "", "Qg==");
  bridge.swiftWebDidRespond(...renders[0], 201, "", "QQ==");
  assert.equal((await a).body[0], 65);
  assert.equal((await b).body[0], 66);

  memories[0].grow(1);
  const replacement = first.render(undefined, request);
  await until(() => starts.length === 3);
  bridge.swiftWebDidRespond(...renders[0], 200, "", "WA==");
  assert.equal(errors.length, 3, "Crossed and retired callbacks must be rejected");
  bridge.swiftWebDidRender(...starts[2]);
  await until(() => renders.length === 3);
  bridge.swiftWebDidRespond(...renders[2], 200, "", "Qw==");
  assert.equal((await replacement).body[0], 67);
});

test("routing does not retain a discarded runtime or its storage owner", async () => {
  assert.equal(typeof globalThis.gc, "function", "Run this check with --expose-gc");
  const registry = new ApplicationRuntimeRegistry();
  const { id, weakOwner, weakStorage, weakRuntime } = discardOwner(registry);
  for (let attempt = 0; attempt < 4; attempt++) {
    await setImmediate();
    globalThis.gc!();
  }
  assert.equal(weakOwner.deref(), undefined);
  assert.equal(weakStorage.deref(), undefined);
  assert.equal(weakRuntime.deref(), undefined, "Callback closures must not keep the runtime alive");
  assert.equal(registry.runtime(id), undefined);
  assert.equal(registry.durableStorage(id), undefined);
  assert.throws(() => registry.dispatch(id, "rendered", id), /Unknown/);
});

function discardOwner(registry: ApplicationRuntimeRegistry) {
  // No SQL operation is performed: this sentinel tests retention, not storage behavior.
  const storage = {} as DurableObjectStorage;
  const owner = registry.register({}, storage);
  const runtime = new ApplicationRuntime({ exports: {} });
  return {
    id: owner.id, weakOwner: new WeakRef(owner), weakStorage: new WeakRef(storage),
    weakRuntime: new WeakRef(runtime),
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await setImmediate();
  }
  assert.fail("Expected runtime transition did not occur");
}
