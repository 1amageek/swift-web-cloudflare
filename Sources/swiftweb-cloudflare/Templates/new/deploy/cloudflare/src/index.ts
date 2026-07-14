// SwiftWeb Cloudflare worker: routes actor invocations to per-identity
// Durable Objects hosting the app's Swift/WASM actor runtime.
//
// JS here is a no-interpretation trampoline: envelopes are opaque strings,
// dispatched by the Swift side (SwiftWebCloudflareHost).
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
// @ts-ignore
import { SwiftRuntime } from "./runtime.mjs";
// @ts-ignore
import wasmModule from "./app.wasm";
import { authConfigFromEnv, verifyIdToken } from "./auth";

export interface Env {
  SWIFTWEB_ACTOR: DurableObjectNamespace;
  SWIFTWEB_AUTH_PROJECT_ID?: string;
  SWIFTWEB_AUTH_EMULATOR_HOST?: string;
  SWIFTWEB_AUTH_JWKS_URL?: string;
}

const INVOKE_PATH = "/_swiftweb/actors/invoke";

const WS_PATH = "/_swiftweb/actors/ws";

// The Worker sets this to the token-verified uid on the trusted Worker → DO
// hop. Any client-supplied value is stripped first, so the DO can trust it.
const PRINCIPAL_HEADER = "X-SwiftWeb-Principal";

let nextSocketID = 1;
const sockets = new Map<number, WebSocket>();

// Each Durable Object registers its own SQLite storage under a token; @ActorStorage
// load/save carry the token so the right DO's storage is used across an isolate.
let nextStorageToken = 1;
const storageByToken = new Map<number, DurableObjectStorage>();

// The app's security.actors policy rejected this invocation. The Worker maps
// it to HTTP 403, matching the native host-neutral actor endpoint.
class ActorInvocationDenied extends Error {}

// Protocol globals are installed once per isolate, not once per start: several
// Durable Objects can share an isolate, and a per-start resolver global would
// be overwritten by the next start before the first resolved. Readiness is
// correlated by start ID, invocation results by callID.
let nextStartID = 1;
const startPending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
const pending = new Map<string, { resolve: (json: string) => void; reject: (error: Error) => void }>();

(globalThis as any).swiftwebSocketSend = (id: number, text: string) => {
  sockets.get(id)?.send(text);
};
(globalThis as any).swiftwebReady = (startID: number) => {
  startPending.get(startID)?.resolve();
  startPending.delete(startID);
};
(globalThis as any).swiftwebFailed = (startID: number, message: string) => {
  startPending.get(startID)?.reject(new Error(message));
  startPending.delete(startID);
};
(globalThis as any).swiftwebComplete = (callID: string, json: string) => {
  pending.get(callID)?.resolve(json);
  pending.delete(callID);
};
(globalThis as any).swiftwebInvokeDenied = (callID: string, reason: string) => {
  pending.get(callID)?.reject(new ActorInvocationDenied(reason));
  pending.delete(callID);
};
(globalThis as any).swiftwebInvokeFailed = (callID: string, message: string) => {
  pending.get(callID)?.reject(new Error(message));
  pending.delete(callID);
};
// Page serving: responses are correlated by callID; headers cross the wasm
// boundary as a flat name/value list joined by the ASCII unit separator,
// which cannot appear in HTTP field names or values.
interface PageResult {
  status: number;
  headersWire: string;
  bodyBase64: string;
}

const WIRE_SEPARATOR = "\u001f";

let nextPageCallID = 1;
const pagePending = new Map<string, { resolve: (page: PageResult) => void; reject: (error: Error) => void }>();

(globalThis as any).swiftwebPageComplete = (
  callID: string,
  status: number,
  headersWire: string,
  bodyBase64: string,
) => {
  pagePending.get(callID)?.resolve({ status, headersWire, bodyBase64 });
  pagePending.delete(callID);
};
(globalThis as any).swiftwebPageFailed = (callID: string, message: string) => {
  pagePending.get(callID)?.reject(new Error(message));
  pagePending.delete(callID);
};

// @ActorStorage grain-state persistence, backed by this DO's SQLite. Synchronous
// (DO SQLite is synchronous); Swift sets the token, actor ID, and blob globals.
(globalThis as any).swiftwebStorageLoad = () => {
  const storage = storageByToken.get((globalThis as any).__swiftwebStorageToken);
  const id = (globalThis as any).__swiftwebStorageActorID as string;
  const rows = storage!.sql
    .exec("SELECT blob FROM swiftweb_actor_state WHERE id = ?", id)
    .toArray();
  (globalThis as any).__swiftwebStorageResult = rows.length ? (rows[0].blob as string) : "";
};
(globalThis as any).swiftwebStorageSave = () => {
  const storage = storageByToken.get((globalThis as any).__swiftwebStorageToken);
  storage!.sql.exec(
    "INSERT OR REPLACE INTO swiftweb_actor_state (id, blob) VALUES (?, ?)",
    (globalThis as any).__swiftwebStorageActorID as string,
    (globalThis as any).__swiftwebStorageBlob as string
  );
};

function errorResponse(reason: string, status: number): Response {
  return new Response(JSON.stringify({ error: true, reason }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function instantiate(): Promise<any> {
  const fds = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((m: string) => console.log("[wasm]", m)),
    ConsoleStdout.lineBuffered((m: string) => console.log("[wasm:err]", m)),
  ];
  const wasi = new WASI([], [], fds);
  const swift = new SwiftRuntime();
  // BridgeJS import stubs: required to instantiate, never called.
  const bjs: Record<string, Function> = {};
  for (const imp of WebAssembly.Module.imports(wasmModule as any)) {
    if (imp.module === "bjs") {
      bjs[imp.name] = () => {
        throw new Error(`Unexpected call to BridgeJS function: ${imp.name}`);
      };
    }
  }
  const instance: any = await WebAssembly.instantiate(wasmModule as any, {
    wasi_snapshot_preview1: wasi.wasiImport,
    javascript_kit: swift.wasmImports,
    bjs,
  });
  swift.setInstance(instance);
  wasi.initialize(instance); // reactor: runs _initialize
  return instance;
}

function start(instance: any): Promise<void> {
  const startID = nextStartID++;
  return new Promise<void>((resolve, reject) => {
    startPending.set(startID, { resolve, reject });
    (globalThis as any).__swiftwebStartID = startID;
    instance.exports.swiftwebStart();
  });
}

function invoke(instance: any, envelopeJSON: string, principal: string): Promise<string> {
  const callID = JSON.parse(envelopeJSON).callID as string;
  return new Promise((resolve, reject) => {
    pending.set(callID, { resolve, reject });
    (globalThis as any).__swiftwebEnvelope = envelopeJSON;
    // Always set the principal (even to "") so a prior request's value never
    // leaks: the global persists across invocations in the isolate.
    (globalThis as any).__swiftwebPrincipal = principal;
    instance.exports.swiftwebInvoke();
  });
}

// Pages are stateless, so they render on a Worker-scope instance instead of
// hopping through a Durable Object; actors keep their per-identity DOs.
let pageInstanceReady: Promise<any> | undefined;

function ensurePageInstance(): Promise<any> {
  if (!pageInstanceReady) {
    pageInstanceReady = (async () => {
      const instance = await instantiate();
      await start(instance);
      return instance;
    })().catch((error) => {
      // A failed start must not poison the isolate: the next request retries.
      pageInstanceReady = undefined;
      throw error;
    });
  }
  return pageInstanceReady;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function renderPage(request: Request): Promise<Response> {
  const instance = await ensurePageInstance();
  const url = new URL(request.url);

  const headerParts: string[] = [];
  request.headers.forEach((value, name) => {
    headerParts.push(name, value);
  });

  let bodyBase64 = "";
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    bodyBase64 = bytesToBase64(new Uint8Array(await request.arrayBuffer()));
  }

  const callID = `p${nextPageCallID++}`;
  const page = await new Promise<PageResult>((resolve, reject) => {
    pagePending.set(callID, { resolve, reject });
    // Set every request global (empty string = no value) so a prior
    // request's value never leaks, then invoke synchronously: Swift reads
    // the globals before its serving task suspends.
    const g = globalThis as any;
    g.__swiftwebRequestCallID = callID;
    g.__swiftwebRequestMethod = request.method;
    g.__swiftwebRequestPath = url.pathname;
    g.__swiftwebRequestSearch = url.search.startsWith("?") ? url.search.slice(1) : url.search;
    g.__swiftwebRequestScheme = url.protocol.replace(":", "");
    g.__swiftwebRequestHost = url.host;
    g.__swiftwebRequestHeaders = headerParts.join(WIRE_SEPARATOR);
    g.__swiftwebRequestBodyBase64 = bodyBase64;
    instance.exports.swiftwebHandleRequest();
  });

  const headers: [string, string][] = [];
  if (page.headersWire.length > 0) {
    const parts = page.headersWire.split(WIRE_SEPARATOR);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      headers.push([parts[i], parts[i + 1]]);
    }
  }
  const body = base64ToBytes(page.bodyBase64);
  return new Response(body.length > 0 ? body : null, {
    status: page.status,
    headers,
  });
}

// Authenticate an inbound request and return the verified uid, or a Response
// to short-circuit with. When auth is not configured the uid is null and the
// DO's actor policy remains the only gate.
async function authenticate(
  request: Request,
  url: URL,
  env: Env
): Promise<{ uid: string | null } | Response> {
  const config = authConfigFromEnv(env);
  if (!config) {
    return { uid: null };
  }
  const token = extractToken(request, url);
  if (!token) {
    return errorResponse("missing bearer token", 401);
  }
  try {
    const { uid } = await verifyIdToken(token, config);
    return { uid };
  } catch (error) {
    return errorResponse(
      `token verification failed: ${error instanceof Error ? error.message : String(error)}`,
      401
    );
  }
}

function extractToken(request: Request, url: URL): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  // Browsers cannot set headers on a WebSocket handshake; accept the token as
  // a query parameter over the (encrypted) wss connection.
  return url.searchParams.get("access_token");
}

// Rebuild a request for the trusted Worker → DO hop with the verified
// principal, dropping any client-supplied principal header.
function withPrincipal(request: Request, uid: string | null): Request {
  const headers = new Headers(request.headers);
  headers.delete(PRINCIPAL_HEADER);
  headers.set(PRINCIPAL_HEADER, uid ?? "");
  return new Request(request, { headers });
}

/// One Durable Object per actor identity: the Worker routes each
/// recipientID ("<contract>:<name>") to its own DO via idFromName, so the
/// activated actor's state lives in exactly one place.
export class SwiftWebActorDO {
  private ready: Promise<void> | undefined;
  private instance: any;
  private ctx: DurableObjectState;
  private storageToken: number | undefined;
  // Sockets this (possibly hibernation-woken) instance has opened in Swift.
  private openedSockets = new Map<WebSocket, number>();

  constructor(state: DurableObjectState) {
    this.ctx = state;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        this.instance = await instantiate();
        this.storageToken = nextStorageToken++;
        storageByToken.set(this.storageToken, this.ctx.storage);
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS swiftweb_actor_state (id TEXT PRIMARY KEY, blob TEXT)"
        );
        // Captured synchronously by CloudflareActorHost.start before it suspends.
        (globalThis as any).__swiftwebStorageToken = this.storageToken;
        await start(this.instance);
      })();
    }
    return this.ready;
  }

  // Opens a socket in Swift, assigning it an id for this instance. Called on
  // upgrade and again after hibernation wake (when Swift's socket map was lost),
  // reading the principal the Worker stored in the socket attachment.
  private async openSocket(ws: WebSocket): Promise<number> {
    await this.ensureStarted();
    const id = nextSocketID++;
    sockets.set(id, ws);
    this.openedSockets.set(ws, id);
    const attachment = (ws.deserializeAttachment() ?? {}) as { principal?: string };
    (globalThis as any).__swiftwebSocketID = id;
    (globalThis as any).__swiftwebSocketPrincipal = attachment.principal ?? "";
    this.instance.exports.swiftwebSocketOpened();
    return id;
  }

  // Hibernation handlers: the DO may be evicted while sockets stay open, so
  // these run on a fresh instance. Frames are Envelopes dispatched by Swift;
  // server → client pushes are one-way, and durable state is in @ActorStorage,
  // so nothing that must outlive a wake lives in socket memory.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const id = this.openedSockets.get(ws) ?? (await this.openSocket(ws));
    (globalThis as any).__swiftwebSocketID = id;
    (globalThis as any).__swiftwebSocketFrame =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    this.instance.exports.swiftwebSocketMessage();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const id = this.openedSockets.get(ws);
    if (id === undefined) {
      return;
    }
    await this.ensureStarted();
    (globalThis as any).__swiftwebSocketID = id;
    this.instance.exports.swiftwebSocketClosed();
    sockets.delete(id);
    this.openedSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket session: hibernatable, so the DO can be evicted while it stays
    // open. The verified principal rides in the attachment to survive wake.
    if (request.headers.get("Upgrade") === "websocket") {
      await this.ensureStarted();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.serializeAttachment({ principal: request.headers.get(PRINCIPAL_HEADER) ?? "" });
      this.ctx.acceptWebSocket(server);
      await this.openSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      await this.ensureStarted();
      const envelopeJSON = await request.text();
      const principal = request.headers.get(PRINCIPAL_HEADER) ?? "";
      const responseJSON = await invoke(this.instance, envelopeJSON, principal);
      return new Response(responseJSON, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      if (error instanceof ActorInvocationDenied) {
        return errorResponse(error.message, 403);
      }
      return errorResponse(String(error), 500);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__swiftweb/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === WS_PATH) {
      const actor = url.searchParams.get("actor");
      if (request.headers.get("Upgrade") !== "websocket" || !actor) {
        return errorResponse("expected a WebSocket upgrade with ?actor=<recipientID>", 400);
      }
      const auth = await authenticate(request, url, env);
      if (auth instanceof Response) {
        return auth;
      }
      const id = env.SWIFTWEB_ACTOR.idFromName(actor);
      return env.SWIFTWEB_ACTOR.get(id).fetch(withPrincipal(request, auth.uid));
    }

    if (url.pathname === INVOKE_PATH && request.method === "POST") {
      const auth = await authenticate(request, url, env);
      if (auth instanceof Response) {
        return auth;
      }
      const envelopeJSON = await request.text();
      let recipientID: string;
      try {
        recipientID = JSON.parse(envelopeJSON).recipientID;
        if (typeof recipientID !== "string" || recipientID.length === 0) {
          throw new Error("recipientID missing");
        }
      } catch (error) {
        return errorResponse(`invalid invocation envelope: ${String(error)}`, 400);
      }
      const id = env.SWIFTWEB_ACTOR.idFromName(recipientID);
      return env.SWIFTWEB_ACTOR.get(id).fetch(
        new Request(request.url, {
          method: "POST",
          body: envelopeJSON,
          headers: { [PRINCIPAL_HEADER]: auth.uid ?? "" },
        })
      );
    }

    try {
      return await renderPage(request);
    } catch (error) {
      return errorResponse(String(error), 500);
    }
  },
};
