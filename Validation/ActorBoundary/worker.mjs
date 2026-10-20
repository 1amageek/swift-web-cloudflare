import { ConsoleStdout, File, OpenFile, WASI } from "@bjorn3/browser_wasi_shim";
import { SwiftRuntime } from "../../Adapter/Templates/Deployment/common/src/runtime.mjs";
import "../../Adapter/Templates/Deployment/common/src/application-runtime.ts";
import { createPageRuntimeCoordinator } from "../../Adapter/Templates/Deployment/common/src/application-runtime.ts";
import { DurableObject } from "cloudflare:workers";
import program from "./app.wasm";

export default {
  async fetch(request, environment) {
    if (new URL(request.url).pathname.startsWith("/pages/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice(6);
      return environment.PAGE.getByName("page-isolation").fetch(new Request(url, request));
    }
    const wasi = new WASI([], [], [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered(console.log),
      ConsoleStdout.lineBuffered(console.error),
    ]);
    const swift = new SwiftRuntime();
    const unavailableImports = {};
    for (const imported of WebAssembly.Module.imports(program)) {
      if (imported.module === "bjs") {
        unavailableImports[imported.name] = () => {
          throw new Error(`Unavailable platform import: ${imported.name}`);
        };
      }
    }
    const instance = await WebAssembly.instantiate(program, {
      wasi_snapshot_preview1: wasi.wasiImport,
      javascript_kit: swift.wasmImports,
      bjs: unavailableImports,
    });
    swift.setInstance(instance);
    wasi.initialize(instance);
    instance.exports.start_actor_validation();
    const mode = new URL(request.url).pathname.slice(1);
    if (mode !== "requests") {
      let deadline;
      try {
        return Response.json(await Promise.race([
          validateHost(instance, mode),
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error(`Host ${mode} timed out`)), 5000);
          }),
        ]));
      } finally {
        clearTimeout(deadline);
      }
    }

    const calls = {};
    const diagnostics = [];
    const errors = {};
    const reportFailure = globalThis.swiftWebActorRequestFailed;
    globalThis.swiftWebActorRequestFailed = (runtimeID, callID, requestID, phase, reason) => {
      diagnostics.push({ runtimeID, callID, requestID, phase });
      reportFailure(runtimeID, callID, requestID, phase, reason);
    };
    globalThis.actorBoundaryErrorDiagnostic = (scenario, text) => { errors[scenario] = text; };
    let aborted = 0;
    globalThis.__swiftWebActorRequest = async (endpoint, frame, signal, peerID) => {
      if (!(frame instanceof Uint8Array) || !peerID || !(signal instanceof AbortSignal)) {
        throw new TypeError("Invalid request boundary values");
      }
      const scenario = Number(endpoint.replace("validation-", ""));
      calls[scenario] = (calls[scenario] ?? 0) + 1;
      if (scenario === 0) {
        const response = await environment.ECHO.getByName("binary-owner").echo(frame);
        return new Response(response);
      }
      if (scenario === 1 || scenario === 2 || scenario === 9) {
        // Inject documented platform categories without exhausting real quotas.
        throw Object.assign(new Error("private platform diagnostic"), {
          overloaded: scenario !== 2,
          retryable: scenario !== 1,
        });
      }
      if (scenario === 3) throw new Error("private unknown diagnostic");
      if (scenario === 4 || scenario === 5) {
        return new Promise((_resolve, reject) => {
          const cancel = () => {
            aborted++;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", cancel, { once: true });
        });
      }
      if (scenario === 7) return new Response(null, { status: 204 });
      if (scenario === 8) return new Response(null, { status: 429 });
      throw new Error("A pre-cancelled request crossed the platform boundary");
    };

    const outcomes = {};
    for (let scenario = 0; scenario < 10; scenario++) {
      outcomes[scenario] = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`Scenario ${scenario} timed out`)), 5000);
        globalThis.actorBoundaryCompleted = (completed, outcome) => {
          clearTimeout(deadline);
          if (completed !== scenario) reject(new Error("Crossed completion identity"));
          else resolve(outcome);
        };
        instance.exports.validate_actor_request(scenario);
      });
    }
    delete globalThis.actorBoundaryCompleted;
    delete globalThis.__swiftWebActorRequest;
    delete globalThis.actorBoundaryErrorDiagnostic;
    globalThis.swiftWebActorRequestFailed = reportFailure;
    return Response.json({ outcomes, calls, aborted, diagnostics, errors });
  },
};

export class PageIsolationProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.held = [];
    this.diagnostics = [];
    this.violations = [];
    this.coordinator = createPageRuntimeCoordinator(program, {
      retirementThresholdBytes: 80 * 1024 * 1024,
      reportProtocolViolation: error => this.violations.push(error.message),
    });
    globalThis.failureProbeHold = () => new Promise(resolve => {
      this.held.push(resolve);
      if (this.held.length === 2) this.cancelFirst?.();
    });
    const report = globalThis.swiftWebActorRequestFailed;
    globalThis.swiftWebActorRequestFailed = (...args) => { this.diagnostics.push(args.slice(0, 4)); report(...args); };
    globalThis.__swiftWebActorRequest = async () => { throw new TypeError("private failure message"); };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/release") { this.held.splice(0).forEach(resolve => resolve()); return new Response("released"); }
    if (path === "/state") return Response.json({ pending: this.coordinator.pendingRenderCount,
      diagnostics: this.diagnostics, violations: this.violations });
    const signal = new AbortController();
    if (path === "/cancelled") this.cancelFirst = () => signal.abort();
    try {
      const response = await this.coordinator.render(undefined, {
        method: "GET", path: path === "/cancelled" ? "/hold" : path,
        search: "", scheme: "https", host: "probe.test", encodedHeaders: "", encodedBody: "",
      }, signal.signal);
      return Response.json({ status: response.status, body: new TextDecoder().decode(response.body) }, { status: response.status });
    } catch (error) {
      if (error.name !== "PageRequestCancellationError") throw error;
      return Response.json({ name: error.name, retained: this.coordinator.pendingRenderCount }, { status: 499 });
    } finally {
      if (path === "/cancelled") this.cancelFirst = undefined;
    }
  }
}

async function validateHost(instance, mode) {
  const events = [];
  const pending = new Map();
  const shutdownCalls = new Map();
  let cancellationFrame;
  let invocationFrame;
  let maximumFrameBytes;
  let sequence = 0;
  let prepare;
  let rejectPrepare;
  let didBootstrap;
  let didStart;
  const bootstrap = new Promise(resolve => { didBootstrap = resolve; });
  const startup = new Promise(resolve => { didStart = resolve; });
  globalThis.actorBoundaryFrames = (cancellation, invocation, maximum) => {
    cancellationFrame = encode(cancellation);
    invocationFrame = encode(invocation);
    maximumFrameBytes = maximum;
  };
  globalThis.actorBoundaryPrepare = () => new Promise((resolve, reject) => {
    prepare = resolve;
    rejectPrepare = reject;
  });
  globalThis.actorBoundaryBootstrapping = (runtime, rendering) => {
    events.push(["bootstrap", runtime, rendering]);
    didBootstrap();
  };
  globalThis.swiftWebDidRender = (runtime, rendering) => {
    events.push(["ready", runtime, rendering]);
    didStart("ready");
  };
  globalThis.swiftWebRenderingFailed = (runtime, rendering, message) => {
    events.push(["startup-failed", runtime, rendering, message]);
    didStart("failed");
  };
  const settle = (runtime, callID, outcome, value) => {
    const resolve = pending.get(callID);
    events.push([outcome, runtime, callID, value]);
    if (!resolve) throw new Error(`Repeated or unknown completion: ${callID}`);
    pending.delete(callID);
    resolve(outcome);
  };
  globalThis.swiftWebDidInvokeActorFrame = (runtime, callID, value) => settle(runtime, callID, "completed", value);
  globalThis.swiftWebActorFrameInvocationFailed = (runtime, callID, value) => settle(runtime, callID, "failed", value);
  const settleShutdown = (runtime, callID, outcome, message) => {
    const call = shutdownCalls.get(callID);
    if (!call || call.runtimeID !== runtime) {
      throw new Error(`Repeated or crossed shutdown completion: ${runtime}/${callID}`);
    }
    shutdownCalls.delete(callID);
    events.push(["shutdown", runtime, callID, outcome, message]);
    call.resolve(outcome);
  };
  globalThis.swiftWebActorServiceShutdownCompleted = (runtime, callID) => settleShutdown(runtime, callID, "stopped");
  globalThis.swiftWebActorServiceShutdownFailed = (runtime, callID, message) => settleShutdown(runtime, callID, "failed", message);
  instance.exports.prepare_actor_host();
  const invoke = (frame, identity = "expected", runtimeID = 42) => {
    const callID = `boundary-${++sequence}`;
    const result = new Promise(resolve => { pending.set(callID, resolve); });
    Object.assign(globalThis, {
      __swiftWebRuntimeID: runtimeID,
      __swiftWebActorFrameCallID: callID,
      __swiftWebActorFrameBase64: frame,
      __swiftWebActorPrincipalID: "validation-principal",
      __swiftWebActorSessionID: "validation-session",
      __swiftWebActorTenantID: "",
      __swiftWebActorRemoteAddress: "local-workerd",
      __swiftWebActorPeerID: "validation-peer",
      __swiftWebHostedActorIdentity: identity,
    });
    instance.exports.invoke_actor_host();
    return result;
  };
  const stop = (runtimeID = 42) => {
    const callID = `shutdown-${++sequence}`;
    const stopped = new Promise(resolve => { shutdownCalls.set(callID, { runtimeID, resolve }); });
    Object.assign(globalThis, {
      __swiftWebRuntimeID: runtimeID,
      __swiftWebShutdownCallID: callID,
    });
    instance.exports.shutdownActorService();
    // Another runtime may prepare a bridge call while Core shutdown is awaiting.
    Object.assign(globalThis, {
      __swiftWebRuntimeID: 999,
      __swiftWebShutdownCallID: "unrelated-runtime-call",
    });
    return stopped;
  };
  Object.assign(globalThis, { __swiftWebRuntimeID: 42, __swiftWebRenderingID: 19 });
  instance.exports.start_actor_host();
  await bootstrap;
  const early = await invoke(cancellationFrame);
  let ready;
  let successful;
  let mismatch;
  let wrongRuntime;
  let oversize;
  let shutdown;
  const wrongShutdownRuntime = await stop(43);
  if (mode === "startup-failure") {
    rejectPrepare(new Error("Application dependency preparation failed"));
    ready = await startup;
  } else if (mode === "startup-shutdown") {
    shutdown = await stop();
    ready = await startup;
    prepare();
    await scheduler.wait(10);
  } else {
    prepare();
    ready = await startup;
    successful = await Promise.all([invoke(cancellationFrame), invoke(cancellationFrame)]);
    mismatch = await invoke(invocationFrame, "different");
    wrongRuntime = await invoke(cancellationFrame, "expected", 43);
    oversize = await invoke("A".repeat(Math.ceil(maximumFrameBytes / 3) * 4 + 4));
  }
  shutdown ??= await stop();
  const repeatedShutdown = await stop();
  const stopped = await invoke(cancellationFrame);
  if (pending.size !== 0 || shutdownCalls.size !== 0) throw new Error("Host retained unfinished callbacks");
  return { early, ready, successful, mismatch, wrongRuntime, oversize, wrongShutdownRuntime, shutdown, repeatedShutdown, stopped, events };
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
