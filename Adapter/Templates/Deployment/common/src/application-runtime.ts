import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
import { SwiftRuntime } from "./runtime.mjs";
import {
  type ActorFrameInvocationBridge,
  type ActorFrameInvocationContext,
  writeActorFrameInvocationContext,
} from "./actor-frame-invocation.ts";
import { readBoundedBytes } from "./http.ts";
import { swiftWebActorFrameLimits } from "./actor-frame-limits.ts";
import {
  PageRuntimeCoordinator,
  type PageRuntimeCoordinatorOptions,
} from "./PageRuntimeCoordinator.ts";
import type { PageRequestEnvelope } from "./PageWire.ts";

export type { ActorFrameInvocationContext } from "./actor-frame-invocation.ts";

const HEADER_SEPARATOR = "\u001f";
const PAGE_BODY_LIMIT = 16 * 1024 * 1024;
const maximumRuntimeID = 0x7fff_ffff;

interface Pending<Value> {
  resolve(value: Value): void;
  reject(error: Error): void;
}

interface PageResult {
  status: number;
  headersWire: string;
  bodyBase64: string;
}

interface RuntimeCallbacks {
  rendered?(renderingID: number): void;
  renderingFailed?(renderingID: number, message: string): void;
  responded?(callID: string, status: number, headers: string, body: string): void;
  responseFailed?(callID: string, message: string): void;
  actorFrameCompleted?(callID: string, response: string): void;
  actorFrameFailed?(callID: string, message: string): void;
  shutdownCompleted?(callID: string): void;
  shutdownFailed?(callID: string, message: string): void;
}

interface RuntimeRegistration {
  readonly id: number;
  readonly callbacks: RuntimeCallbacks;
  readonly storage: DurableObjectStorage | undefined;
}

/** Routing is weak; a DO composition or Page generation owns the registration. */
export class ApplicationRuntimeRegistry {
  private nextID = 1;
  private readonly registrations = new Map<number, WeakRef<RuntimeRegistration>>();
  private readonly finalized = new FinalizationRegistry<number>((id) => {
    this.registrations.delete(id);
  });

  register(callbacks: RuntimeCallbacks, storage?: DurableObjectStorage): RuntimeRegistration {
    if (this.nextID > maximumRuntimeID) {
      throw new RangeError("Application runtime identity space is exhausted");
    }
    const registration = { id: this.nextID++, callbacks, storage };
    this.registrations.set(registration.id, new WeakRef(registration));
    this.finalized.register(registration, registration.id, registration);
    return registration;
  }

  runtime(id: number): RuntimeRegistration | undefined {
    return this.registrations.get(id)?.deref();
  }

  durableStorage(token: number): DurableObjectStorage | undefined {
    return this.runtime(token)?.storage;
  }

  release(registration: RuntimeRegistration): void {
    if (this.runtime(registration.id) !== registration) {
      throw new Error("Application runtime is already released");
    }
    this.registrations.delete(registration.id);
    this.finalized.unregister(registration);
  }

  dispatch<Key extends keyof RuntimeCallbacks>(
    id: number, name: Key, ...arguments_: Parameters<NonNullable<RuntimeCallbacks[Key]>>
  ): void {
    const registration = this.runtime(id);
    const callback = registration?.callbacks[name];
    if (callback === undefined) {
      throw new Error("Unknown application runtime callback " + id + "/" + name);
    }
    // Key and arguments are correlated at every caller; callbacks capture their owner.
    (callback as (...values: Parameters<NonNullable<RuntimeCallbacks[Key]>>) => void)(...arguments_);
  }
}

// Generated Page and Service modules can coexist in one verification realm.
const registryKey = Symbol.for("swiftweb.application-runtime.registry");
const runtimeScope = globalThis as typeof globalThis & {
  [registryKey]?: ApplicationRuntimeRegistry;
};
const registry = runtimeScope[registryKey] ??= new ApplicationRuntimeRegistry();
const bridge = globalThis as typeof globalThis & ActorFrameInvocationBridge & Record<string, unknown>;

function dispatch<Key extends keyof RuntimeCallbacks>(
  runtimeID: number, name: Key, ...arguments_: Parameters<NonNullable<RuntimeCallbacks[Key]>>
): void {
  try {
    registry.dispatch(runtimeID, name, ...arguments_);
  } catch (error) {
    console.error("Application runtime callback rejected", error);
  }
}

// Every module copy dispatches through the same isolate-wide, non-owning index.
bridge.swiftWebDidRender = (id: number, rendering: number) => dispatch(id, "rendered", rendering);
bridge.swiftWebRenderingFailed = (id: number, rendering: number, message: string) =>
  dispatch(id, "renderingFailed", rendering, message);
bridge.swiftWebDidRespond = (id: number, call: string, status: number, headers: string, body: string) =>
  dispatch(id, "responded", call, status, headers, body);
bridge.swiftWebResponseFailed = (id: number, call: string, message: string) =>
  dispatch(id, "responseFailed", call, message);
bridge.swiftWebDidInvokeActorFrame = (id: number, call: string, response: string) =>
  dispatch(id, "actorFrameCompleted", call, response);
bridge.swiftWebActorFrameInvocationFailed = (id: number, call: string, message: string) =>
  dispatch(id, "actorFrameFailed", call, message);
bridge.swiftWebActorServiceShutdownCompleted = (id: number, call: string) =>
  dispatch(id, "shutdownCompleted", call);
bridge.swiftWebActorServiceShutdownFailed = (id: number, call: string, message: string) =>
  dispatch(id, "shutdownFailed", call, message);

export class ApplicationRuntime {
  private readonly registration: RuntimeRegistration;
  private nextCall = 1;
  private startupRequested = false;
  private readonly rendering = new Map<number, Pending<void>>();
  private readonly requests = new Map<string, Pending<PageResult>>();
  private readonly actorFrames = new Map<string, Pending<Uint8Array | null>>();
  private terminalCall: { id: string; pending: Pending<void> } | undefined;
  private shutdownOperation?: Promise<void>;
  private state: "active" | "stopping" | "terminal" = "active";

  constructor(private readonly instance: WebAssembly.Instance, storage?: DurableObjectStorage) {
    this.registration = registry.register({
      rendered: (id) => take(this.rendering, id).resolve(),
      renderingFailed: (id, message) => take(this.rendering, id).reject(new Error(message)),
      responded: (id, status, headersWire, bodyBase64) =>
        take(this.requests, id).resolve({ status, headersWire, bodyBase64 }),
      responseFailed: (id, message) => take(this.requests, id).reject(new Error(message)),
      actorFrameCompleted: (id, response) => {
        const pending = take(this.actorFrames, id);
        try {
          const bytes = base64ToBytes(response, swiftWebActorFrameLimits.maximumFrameByteCount);
          pending.resolve(bytes.byteLength > 0 ? bytes : null);
        } catch (error) {
          pending.reject(asError(error));
        }
      },
      actorFrameFailed: (id, message) => take(this.actorFrames, id).reject(new Error(message)),
      shutdownCompleted: (id) => this.finishShutdown(id),
      shutdownFailed: (id, message) => this.finishShutdown(id, new Error(message)),
    }, storage);
  }

  get id(): number { return this.registration.id; }
  get storageToken(): number | undefined { return this.registration.storage ? this.id : undefined; }

  render(): Promise<void> {
    this.requireAdmission();
    if (this.startupRequested) throw new Error("Application startup has already been requested");
    this.startupRequested = true;
    const renderingID = this.id;
    return new Promise<void>((resolve, reject) => {
      this.rendering.set(renderingID, { resolve, reject });
      this.prepareBridge();
      bridge.__swiftWebRenderingID = renderingID;
      try {
        perform(this.instance, "renderApplication");
      } catch (error) {
        take(this.rendering, renderingID).reject(asError(error));
      }
    });
  }

  async respond(request: Request): Promise<Response> {
    this.requireAdmission();
    const url = new URL(request.url);
    const headerParts: string[] = [];
    request.headers.forEach((value, name) => headerParts.push(name, value));
    let bodyBase64 = "";
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      bodyBase64 = bytesToBase64(await readBoundedBytes(request, PAGE_BODY_LIMIT));
    }
    this.requireAdmission();
    const callID = this.reserveCallID();
    const page = await new Promise<PageResult>((resolve, reject) => {
      this.requests.set(callID, { resolve, reject });
      this.prepareBridge();
      writePageRequest(callID, {
        method: request.method, path: url.pathname,
        search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
        scheme: url.protocol.replace(":", ""), host: url.host,
        encodedHeaders: headerParts.join(HEADER_SEPARATOR), encodedBody: bodyBase64,
      });
      try {
        perform(this.instance, "respondToRequest");
      } catch (error) {
        take(this.requests, callID).reject(asError(error));
      }
    });
    const headers: [string, string][] = [];
    const parts = page.headersWire.length > 0 ? page.headersWire.split(HEADER_SEPARATOR) : [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      headers.push([parts[index]!, parts[index + 1]!]);
    }
    const body = base64ToBytes(page.bodyBase64);
    return new Response(body.byteLength > 0 ? body : null, { status: page.status, headers });
  }

  invokeActorFrame(frame: Uint8Array, context: ActorFrameInvocationContext): Promise<Uint8Array | null> {
    this.requireAdmission();
    if (!(frame instanceof Uint8Array)) throw new TypeError("Actor frame must be Uint8Array");
    if (frame.byteLength > swiftWebActorFrameLimits.maximumFrameByteCount) {
      throw new RangeError("Actor frame exceeds the Cloudflare transport limit");
    }
    // Validate and encode before reserving a pending call.
    const encoded = bytesToBase64(frame);
    writeActorFrameInvocationContext(bridge, context);
    const callID = this.reserveCallID();
    return new Promise((resolve, reject) => {
      this.actorFrames.set(callID, { resolve, reject });
      this.prepareBridge();
      bridge.__swiftWebActorFrameCallID = callID;
      bridge.__swiftWebActorFrameBase64 = encoded;
      try {
        perform(this.instance, "invokeActorFrame");
      } catch (error) {
        take(this.actorFrames, callID).reject(asError(error));
      }
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.requireAdmission();
    this.state = "stopping";
    // A runtime stops once; termination must not depend on unused invocation IDs.
    const id = "runtime-" + this.id + "-shutdown";
    this.shutdownOperation = new Promise<void>((resolve, reject) => {
      this.terminalCall = { id, pending: { resolve, reject } };
    });
    this.prepareBridge();
    bridge.__swiftWebShutdownCallID = id;
    try {
      perform(this.instance, "shutdownActorService");
    } catch (error) {
      // A trapped/missing export is terminal failure, never successful Core shutdown.
      this.finishShutdown(id, asError(error));
    }
    return this.shutdownOperation;
  }

  private finishShutdown(id: string, failure?: Error): void {
    const call = this.terminalCall;
    if (this.state !== "stopping" || call?.id !== id) {
      throw new Error("Unknown actor service terminal call " + id);
    }
    this.terminalCall = undefined;
    this.state = "terminal";
    const closed = failure ?? new Error("Swift/WASM actor service stopped");
    rejectAll(this.rendering, closed);
    rejectAll(this.requests, closed);
    rejectAll(this.actorFrames, closed);
    registry.release(this.registration);
    if (failure) call.pending.reject(failure);
    else call.pending.resolve();
  }

  private requireAdmission(): void {
    if (this.state !== "active") throw new Error("Application runtime is stopping or terminal");
  }

  private reserveCallID(): string {
    if (this.nextCall > Number.MAX_SAFE_INTEGER) throw new RangeError("Application call identity space is exhausted");
    return "runtime-" + this.id + "-call-" + this.nextCall++;
  }

  private prepareBridge(): void {
    bridge.__swiftWebRuntimeID = this.id;
    bridge.__swiftWebStorageToken = this.storageToken ?? 0;
  }
}

/** Bounded Page lifecycle; this owner is retained by its coordinator generation. */
class PageApplicationRuntime {
  private readonly registration: RuntimeRegistration;
  private startID?: number;
  private released = false;

  constructor(
    private readonly instance: WebAssembly.Instance,
    private readonly coordinator: PageRuntimeCoordinator<PageApplicationRuntime, undefined>,
  ) {
    this.registration = registry.register({
      rendered: (id) => this.coordinator.didStart(this.requireStartID(id)),
      renderingFailed: (id, message) => this.coordinator.didFailToStart(this.requireStartID(id), message),
      responded: (id, status, headers, body) =>
        this.coordinator.didRenderPage(this.localCallID(id), status, headers, body),
      responseFailed: (id, message) =>
        this.coordinator.didFailToRenderPage(this.localCallID(id), message),
    });
  }

  start(startID: number): void {
    this.startID = startID;
    this.prepareBridge();
    bridge.__swiftWebRenderingID = this.registration.id;
    perform(this.instance, "renderApplication");
  }

  render(callID: string, request: PageRequestEnvelope): void {
    this.prepareBridge();
    writePageRequest(this.registration.id + ":" + callID, request);
    perform(this.instance, "respondToRequest");
  }

  get memoryByteCount(): number { return wasmMemory(this.instance).buffer.byteLength; }

  release(): void {
    if (this.released) throw new Error("Page runtime is already released");
    this.released = true;
    registry.release(this.registration);
  }

  private prepareBridge(): void {
    if (this.released) throw new Error("Page runtime is released");
    bridge.__swiftWebRuntimeID = this.registration.id;
    bridge.__swiftWebStorageToken = 0;
  }

  private requireStartID(id: number): number {
    if (id !== this.registration.id || this.startID === undefined) {
      throw new Error("Page startup callback belongs to another runtime");
    }
    return this.startID;
  }

  private localCallID(id: string): string {
    const prefix = this.registration.id + ":";
    if (typeof id !== "string" || !id.startsWith(prefix)) {
      throw new Error("Page response callback belongs to another runtime");
    }
    return id.slice(prefix.length);
  }
}

export function createPageRuntimeCoordinator(
  module: WebAssembly.Module,
  options: PageRuntimeCoordinatorOptions = {},
): PageRuntimeCoordinator<PageApplicationRuntime, undefined> {
  const coordinator: PageRuntimeCoordinator<PageApplicationRuntime, undefined> = new PageRuntimeCoordinator({
    instantiate: async () => new PageApplicationRuntime(await instantiateApplication(module), coordinator),
    start: (runtime, id) => runtime.start(id),
    render: (runtime, id, request) => runtime.render(id, request),
    memoryByteCount: (runtime) => runtime.memoryByteCount,
    release: (runtime) => runtime.release(),
  }, options);
  return coordinator;
}

bridge.swiftWebLoadActorState = () => {
  const token = bridge.__swiftWebStorageToken;
  const actorID = bridge.__swiftWebStorageActorID;
  const storage = typeof token === "number" ? registry.durableStorage(token) : undefined;
  if (!storage || typeof actorID !== "string" || actorID.length === 0) {
    throw new Error("Actor storage bridge is missing its storage token or actor ID");
  }
  const rows = storage.sql.exec("SELECT blob FROM swiftweb_actor_state WHERE id = ?", actorID).toArray();
  bridge.__swiftWebStorageResult = typeof rows[0]?.blob === "string" ? rows[0].blob : "";
};
bridge.swiftWebSaveActorState = () => {
  const token = bridge.__swiftWebStorageToken;
  const actorID = bridge.__swiftWebStorageActorID;
  const blob = bridge.__swiftWebStorageBlob;
  const storage = typeof token === "number" ? registry.durableStorage(token) : undefined;
  if (!storage || typeof actorID !== "string" || actorID.length === 0 || typeof blob !== "string") {
    throw new Error("Actor storage bridge is missing its storage token, actor ID, or value");
  }
  storage.sql.exec("INSERT OR REPLACE INTO swiftweb_actor_state (id, blob) VALUES (?, ?)", actorID, blob);
};

class PageRuntimeProvider {
  private ready: Promise<ApplicationRuntime> | undefined;

  application(module: WebAssembly.Module): Promise<ApplicationRuntime> {
    if (!this.ready) {
      this.ready = createApplicationRuntime(module).then(async (runtime) => {
        await runtime.render();
        return runtime;
      }).catch((error) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }
}

const pageRuntimeProvider = new PageRuntimeProvider();
export function pageApplicationRuntime(module: WebAssembly.Module): Promise<ApplicationRuntime> {
  return pageRuntimeProvider.application(module);
}

export async function createApplicationRuntime(
  module: WebAssembly.Module, storage?: DurableObjectStorage,
): Promise<ApplicationRuntime> {
  return new ApplicationRuntime(await instantiateApplication(module), storage);
}

async function instantiateApplication(module: WebAssembly.Module): Promise<WebAssembly.Instance> {
  const wasi = new WASI([], [], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((message: string) => console.log(JSON.stringify({ source: "swift-wasm", message }))),
    ConsoleStdout.lineBuffered((message: string) => console.error(JSON.stringify({ source: "swift-wasm", message }))),
  ]);
  const swift = new SwiftRuntime();
  const imports: WebAssembly.ModuleImports = {};
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module === "bjs") {
      imports[imported.name] = () => { throw new Error("Unexpected BridgeJS call " + imported.name); };
    }
  }
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport, javascript_kit: swift.wasmImports, bjs: imports,
  });
  swift.setInstance(instance);
  const initialize = instance.exports._initialize;
  wasi.initialize({
    exports: {
      memory: wasmMemory(instance),
      ...(typeof initialize === "function" ? { _initialize: () => initialize() } : {}),
    },
  });
  return instance;
}

function wasmMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Swift/WASM instance does not export memory");
  return memory;
}

function perform(instance: WebAssembly.Instance, name: string): void {
  const exported = instance.exports[name];
  if (typeof exported !== "function") throw new Error("Swift/WASM export '" + name + "' is missing");
  exported();
}

function writePageRequest(id: string, request: PageRequestEnvelope): void {
  bridge.__swiftWebRequestCallID = id;
  bridge.__swiftWebRequestMethod = request.method;
  bridge.__swiftWebRequestPath = request.path;
  bridge.__swiftWebRequestSearch = request.search;
  bridge.__swiftWebRequestScheme = request.scheme;
  bridge.__swiftWebRequestHost = request.host;
  bridge.__swiftWebRequestHeaders = request.encodedHeaders;
  bridge.__swiftWebRequestBodyBase64 = request.encodedBody;
}

function take<Key, Value>(pending: Map<Key, Pending<Value>>, id: Key): Pending<Value> {
  const call = pending.get(id);
  if (!call) throw new Error("Unknown application call " + String(id));
  pending.delete(id);
  return call;
}

function rejectAll<Key, Value>(pending: Map<Key, Pending<Value>>, error: Error): void {
  const calls = [...pending.values()];
  pending.clear();
  for (const call of calls) call.reject(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string, maximumBytes = PAGE_BODY_LIMIT): Uint8Array<ArrayBuffer> {
  if (typeof base64 !== "string") throw new TypeError("Application response must be base64 text");
  if (base64.length > 4 * Math.ceil(maximumBytes / 3)) {
    throw new RangeError("Application response exceeds the transport limit");
  }
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new TypeError("Application response is not canonical base64");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const count = base64.length / 4 * 3 - padding;
  if (count > maximumBytes) throw new RangeError("Application response exceeds the transport limit");
  if (padding > 0) {
    const finalValue = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      .indexOf(base64[base64.length - padding - 1]!);
    if ((finalValue & (padding === 2 ? 15 : 3)) !== 0) {
      throw new TypeError("Application response is not canonical base64");
    }
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
