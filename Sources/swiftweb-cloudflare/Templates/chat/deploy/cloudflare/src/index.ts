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

export interface Env {
  SWIFTWEB_ACTOR: DurableObjectNamespace;
}

const INVOKE_PATH = "/_swiftweb/actors/invoke";

const WS_PATH = "/_swiftweb/actors/ws";

let nextSocketID = 1;
const sockets = new Map<number, WebSocket>();
(globalThis as any).swiftwebSocketSend = (id: number, text: string) => {
  sockets.get(id)?.send(text);
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

const pending = new Map<string, { resolve: (json: string) => void; reject: (error: Error) => void }>();

function installProtocolGlobals(readyResolve: () => void, readyReject: (error: Error) => void) {
  (globalThis as any).swiftwebReady = () => readyResolve();
  (globalThis as any).swiftwebFailed = (message: string) => readyReject(new Error(message));
  (globalThis as any).swiftwebComplete = (callID: string, json: string) => {
    pending.get(callID)?.resolve(json);
    pending.delete(callID);
  };
  (globalThis as any).swiftwebInvokeFailed = (callID: string, message: string) => {
    pending.get(callID)?.reject(new Error(message));
    pending.delete(callID);
  };
}

function invoke(instance: any, envelopeJSON: string): Promise<string> {
  const callID = JSON.parse(envelopeJSON).callID as string;
  return new Promise((resolve, reject) => {
    pending.set(callID, { resolve, reject });
    (globalThis as any).__swiftwebEnvelope = envelopeJSON;
    instance.exports.swiftwebInvoke();
  });
}

/// One Durable Object per actor identity: the Worker routes each
/// recipientID ("<contract>:<name>") to its own DO via idFromName, so the
/// activated actor's state lives in exactly one place.
export class SwiftWebActorDO {
  private ready: Promise<void> | undefined;
  private instance: any;

  constructor(_state: DurableObjectState) {}

  private async ensureStarted(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        this.instance = await instantiate();
        await new Promise<void>((resolve, reject) => {
          installProtocolGlobals(resolve, reject);
          this.instance.exports.swiftwebStart();
        });
      })();
    }
    return this.ready;
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket session: frames are Envelopes, dispatched by the Swift side.
    if (request.headers.get("Upgrade") === "websocket") {
      await this.ensureStarted();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      const id = nextSocketID++;
      sockets.set(id, server);
      (globalThis as any).__swiftwebSocketID = id;
      this.instance.exports.swiftwebSocketOpened();
      server.addEventListener("message", (event: MessageEvent) => {
        (globalThis as any).__swiftwebSocketID = id;
        (globalThis as any).__swiftwebSocketFrame = String(event.data);
        this.instance.exports.swiftwebSocketMessage();
      });
      server.addEventListener("close", () => {
        (globalThis as any).__swiftwebSocketID = id;
        this.instance.exports.swiftwebSocketClosed();
        sockets.delete(id);
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      await this.ensureStarted();
      const envelopeJSON = await request.text();
      const responseJSON = await invoke(this.instance, envelopeJSON);
      return new Response(responseJSON, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (error) {
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
      const id = env.SWIFTWEB_ACTOR.idFromName(actor);
      return env.SWIFTWEB_ACTOR.get(id).fetch(request);
    }

    if (url.pathname === INVOKE_PATH && request.method === "POST") {
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
        new Request(request.url, { method: "POST", body: envelopeJSON })
      );
    }

    return errorResponse("Not Found", 404);
  },
};
