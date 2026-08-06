import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
import { SwiftRuntime } from "./runtime.mjs";
import wasmModule from "./app.wasm";
import { readBoundedBytes } from "./http";

const HEADER_SEPARATOR = "\u001f";
const PAGE_BODY_LIMIT = 16 * 1024 * 1024;

interface Pending<Value> {
  resolve(value: Value): void;
  reject(error: Error): void;
}

interface PageResult {
  status: number;
  headersWire: string;
  bodyBase64: string;
}

interface BridgeGlobals {
  __swiftWebRuntimeID?: number;
  __swiftWebRenderingID?: number;
  __swiftWebStorageToken?: number;
  __swiftWebStorageActorID?: string;
  __swiftWebStorageBlob?: string;
  __swiftWebStorageResult?: string;
  __swiftWebActorEnvelope?: string;
  __swiftWebPrincipal?: string;
  __swiftWebRequestCallID?: string;
  __swiftWebRequestMethod?: string;
  __swiftWebRequestPath?: string;
  __swiftWebRequestSearch?: string;
  __swiftWebRequestScheme?: string;
  __swiftWebRequestHost?: string;
  __swiftWebRequestHeaders?: string;
  __swiftWebRequestBodyBase64?: string;
  __swiftWebSocketID?: number;
  __swiftWebSocketPrincipal?: string;
  __swiftWebSocketFrame?: string;
  swiftWebDidRender(runtimeID: number, renderingID: number): void;
  swiftWebRenderingFailed(runtimeID: number, renderingID: number, message: string): void;
  swiftWebDidRespond(
    runtimeID: number,
    callID: string,
    status: number,
    headersWire: string,
    bodyBase64: string
  ): void;
  swiftWebResponseFailed(runtimeID: number, callID: string, message: string): void;
  swiftWebDidInvokeActor(runtimeID: number, callID: string, responseJSON: string): void;
  swiftWebActorInvocationDenied(runtimeID: number, callID: string, reason: string): void;
  swiftWebActorInvocationFailed(runtimeID: number, callID: string, message: string): void;
  swiftWebSendSocketFrame(runtimeID: number, socketID: number, frame: string): void;
  swiftWebLoadActorState(): void;
  swiftWebSaveActorState(): void;
}

const bridge = globalThis as typeof globalThis & BridgeGlobals;

class ActorInvocationDeniedError extends Error {}

export class ApplicationRuntime {
  private nextRenderingID = 1;
  private nextRequestID = 1;
  private nextSocketID = 1;
  private readonly rendering = new Map<number, Pending<void>>();
  private readonly requests = new Map<string, Pending<PageResult>>();
  private readonly invocations = new Map<string, Pending<string>>();
  private readonly sockets = new Map<number, WebSocket>();

  constructor(
    readonly id: number,
    private readonly instance: WebAssembly.Instance,
    private readonly storageToken?: number
  ) {}

  render(): Promise<void> {
    const renderingID = this.nextRenderingID++;
    return new Promise<void>((resolve, reject) => {
      this.rendering.set(renderingID, { resolve, reject });
      this.prepareBridge();
      bridge.__swiftWebRenderingID = renderingID;
      try {
        this.callExport("renderApplication");
      } catch (error) {
        this.rendering.delete(renderingID);
        reject(asError(error));
      }
    });
  }

  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headerParts: string[] = [];
    request.headers.forEach((value, name) => {
      headerParts.push(name, value);
    });

    let bodyBase64 = "";
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      bodyBase64 = bytesToBase64(await readBoundedBytes(request, PAGE_BODY_LIMIT));
    }

    const callID = `request-${this.nextRequestID++}`;
    const page = await new Promise<PageResult>((resolve, reject) => {
      this.requests.set(callID, { resolve, reject });
      this.prepareBridge();
      bridge.__swiftWebRequestCallID = callID;
      bridge.__swiftWebRequestMethod = request.method;
      bridge.__swiftWebRequestPath = url.pathname;
      bridge.__swiftWebRequestSearch = url.search.startsWith("?")
        ? url.search.slice(1)
        : url.search;
      bridge.__swiftWebRequestScheme = url.protocol.replace(":", "");
      bridge.__swiftWebRequestHost = url.host;
      bridge.__swiftWebRequestHeaders = headerParts.join(HEADER_SEPARATOR);
      bridge.__swiftWebRequestBodyBase64 = bodyBase64;
      try {
        this.callExport("respondToRequest");
      } catch (error) {
        this.requests.delete(callID);
        reject(asError(error));
      }
    });

    const headers: [string, string][] = [];
    if (page.headersWire.length > 0) {
      const parts = page.headersWire.split(HEADER_SEPARATOR);
      for (let index = 0; index + 1 < parts.length; index += 2) {
        const name = parts[index];
        const value = parts[index + 1];
        if (name === undefined || value === undefined) {
          break;
        }
        headers.push([name, value]);
      }
    }
    const body = base64ToBytes(page.bodyBase64);
    return new Response(body.byteLength > 0 ? body : null, {
      status: page.status,
      headers,
    });
  }

  invokeActor(envelopeJSON: string, principal: string): Promise<string> {
    const callID = invocationCallID(envelopeJSON);
    return new Promise<string>((resolve, reject) => {
      this.invocations.set(callID, { resolve, reject });
      this.prepareBridge();
      bridge.__swiftWebActorEnvelope = envelopeJSON;
      bridge.__swiftWebPrincipal = principal;
      try {
        this.callExport("invokeActor");
      } catch (error) {
        this.invocations.delete(callID);
        reject(asError(error));
      }
    });
  }

  openSocket(socket: WebSocket, principal: string): number {
    const socketID = this.nextSocketID++;
    this.sockets.set(socketID, socket);
    this.prepareBridge();
    bridge.__swiftWebSocketID = socketID;
    bridge.__swiftWebSocketPrincipal = principal;
    this.callExport("openActorSocket");
    return socketID;
  }

  receiveSocketMessage(socketID: number, frame: string): void {
    this.prepareBridge();
    bridge.__swiftWebSocketID = socketID;
    bridge.__swiftWebSocketFrame = frame;
    this.callExport("receiveActorSocketMessage");
  }

  closeSocket(socketID: number): void {
    this.prepareBridge();
    bridge.__swiftWebSocketID = socketID;
    this.callExport("closeActorSocket");
    this.sockets.delete(socketID);
  }

  renderingCompleted(renderingID: number): void {
    this.rendering.get(renderingID)?.resolve();
    this.rendering.delete(renderingID);
  }

  renderingFailed(renderingID: number, message: string): void {
    this.rendering.get(renderingID)?.reject(new Error(message));
    this.rendering.delete(renderingID);
  }

  responseCompleted(callID: string, page: PageResult): void {
    this.requests.get(callID)?.resolve(page);
    this.requests.delete(callID);
  }

  responseFailed(callID: string, message: string): void {
    this.requests.get(callID)?.reject(new Error(message));
    this.requests.delete(callID);
  }

  actorInvocationCompleted(callID: string, responseJSON: string): void {
    this.invocations.get(callID)?.resolve(responseJSON);
    this.invocations.delete(callID);
  }

  actorInvocationDenied(callID: string, reason: string): void {
    this.invocations.get(callID)?.reject(new ActorInvocationDeniedError(reason));
    this.invocations.delete(callID);
  }

  actorInvocationFailed(callID: string, message: string): void {
    this.invocations.get(callID)?.reject(new Error(message));
    this.invocations.delete(callID);
  }

  sendSocketFrame(socketID: number, frame: string): void {
    this.sockets.get(socketID)?.send(frame);
  }

  private prepareBridge(): void {
    bridge.__swiftWebRuntimeID = this.id;
    bridge.__swiftWebStorageToken = this.storageToken ?? 0;
  }

  private callExport(name: string): void {
    const exported = this.instance.exports[name];
    if (typeof exported !== "function") {
      throw new Error(`Swift/WASM export '${name}' is missing`);
    }
    exported();
  }
}

class ApplicationRuntimeRegistry {
  private nextRuntimeID = 1;
  private nextStorageToken = 1;
  private readonly runtimes = new Map<number, ApplicationRuntime>();
  private readonly storage = new Map<number, DurableObjectStorage>();

  register(instance: WebAssembly.Instance, durableStorage?: DurableObjectStorage): ApplicationRuntime {
    const runtimeID = this.nextRuntimeID++;
    let storageToken: number | undefined;
    if (durableStorage) {
      storageToken = this.nextStorageToken++;
      this.storage.set(storageToken, durableStorage);
    }
    const runtime = new ApplicationRuntime(runtimeID, instance, storageToken);
    this.runtimes.set(runtimeID, runtime);
    return runtime;
  }

  runtime(runtimeID: number): ApplicationRuntime | undefined {
    return this.runtimes.get(runtimeID);
  }

  durableStorage(storageToken: number): DurableObjectStorage | undefined {
    return this.storage.get(storageToken);
  }
}

const registry = new ApplicationRuntimeRegistry();

bridge.swiftWebDidRender = (runtimeID, renderingID) => {
  registry.runtime(runtimeID)?.renderingCompleted(renderingID);
};
bridge.swiftWebRenderingFailed = (runtimeID, renderingID, message) => {
  registry.runtime(runtimeID)?.renderingFailed(renderingID, message);
};
bridge.swiftWebDidRespond = (runtimeID, callID, status, headersWire, bodyBase64) => {
  registry.runtime(runtimeID)?.responseCompleted(callID, {
    status,
    headersWire,
    bodyBase64,
  });
};
bridge.swiftWebResponseFailed = (runtimeID, callID, message) => {
  registry.runtime(runtimeID)?.responseFailed(callID, message);
};
bridge.swiftWebDidInvokeActor = (runtimeID, callID, responseJSON) => {
  registry.runtime(runtimeID)?.actorInvocationCompleted(callID, responseJSON);
};
bridge.swiftWebActorInvocationDenied = (runtimeID, callID, reason) => {
  registry.runtime(runtimeID)?.actorInvocationDenied(callID, reason);
};
bridge.swiftWebActorInvocationFailed = (runtimeID, callID, message) => {
  registry.runtime(runtimeID)?.actorInvocationFailed(callID, message);
};
bridge.swiftWebSendSocketFrame = (runtimeID, socketID, frame) => {
  registry.runtime(runtimeID)?.sendSocketFrame(socketID, frame);
};
bridge.swiftWebLoadActorState = () => {
  const storageToken = bridge.__swiftWebStorageToken;
  const actorID = bridge.__swiftWebStorageActorID;
  const storage = storageToken ? registry.durableStorage(storageToken) : undefined;
  if (!storage || !actorID) {
    throw new Error("Actor storage bridge is missing its storage token or actor ID");
  }
  const rows = storage.sql
    .exec("SELECT blob FROM swiftweb_actor_state WHERE id = ?", actorID)
    .toArray();
  const blob = rows[0]?.blob;
  bridge.__swiftWebStorageResult = typeof blob === "string" ? blob : "";
};
bridge.swiftWebSaveActorState = () => {
  const storageToken = bridge.__swiftWebStorageToken;
  const actorID = bridge.__swiftWebStorageActorID;
  const blob = bridge.__swiftWebStorageBlob;
  const storage = storageToken ? registry.durableStorage(storageToken) : undefined;
  if (!storage || !actorID || blob === undefined) {
    throw new Error("Actor storage bridge is missing its storage token, actor ID, or value");
  }
  storage.sql.exec(
    "INSERT OR REPLACE INTO swiftweb_actor_state (id, blob) VALUES (?, ?)",
    actorID,
    blob
  );
};

class PageRuntimeProvider {
  private ready?: Promise<ApplicationRuntime>;

  application(): Promise<ApplicationRuntime> {
    if (!this.ready) {
      this.ready = createApplicationRuntime()
        .then(async (runtime) => {
          await runtime.render();
          return runtime;
        })
        .catch((error) => {
          this.ready = undefined;
          throw error;
        });
    }
    return this.ready;
  }
}

const pageRuntimeProvider = new PageRuntimeProvider();

export function pageApplicationRuntime(): Promise<ApplicationRuntime> {
  return pageRuntimeProvider.application();
}

export async function createApplicationRuntime(
  durableStorage?: DurableObjectStorage
): Promise<ApplicationRuntime> {
  const descriptors = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((message: string) =>
      console.log(JSON.stringify({ source: "swift-wasm", message }))
    ),
    ConsoleStdout.lineBuffered((message: string) =>
      console.error(JSON.stringify({ source: "swift-wasm", message }))
    ),
  ];
  const wasi = new WASI([], [], descriptors);
  const swift = new SwiftRuntime();
  const bridgeImports: WebAssembly.ModuleImports = {};
  for (const imported of WebAssembly.Module.imports(wasmModule)) {
    if (imported.module === "bjs") {
      bridgeImports[imported.name] = () => {
        throw new Error(`Unexpected BridgeJS call '${imported.name}'`);
      };
    }
  }
  const instance = await WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
    javascript_kit: swift.wasmImports,
    bjs: bridgeImports,
  });
  swift.setInstance(instance);
  wasi.initialize(wasiInstance(instance));
  return registry.register(instance, durableStorage);
}

export function isActorInvocationDenied(error: unknown): boolean {
  return error instanceof ActorInvocationDeniedError;
}

function invocationCallID(envelopeJSON: string): string {
  const parsed: unknown = JSON.parse(envelopeJSON);
  if (!isRecord(parsed) || typeof parsed.callID !== "string" || parsed.callID.length === 0) {
    throw new Error("Actor invocation envelope is missing callID");
  }
  return parsed.callID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function wasiInstance(instance: WebAssembly.Instance): {
  exports: {
    memory: WebAssembly.Memory;
    _initialize?: () => unknown;
  };
} {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Swift/WASM instance does not export memory");
  }
  const initialize = instance.exports._initialize;
  return {
    exports: {
      memory,
      _initialize:
        typeof initialize === "function" ? () => initialize() : undefined,
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
