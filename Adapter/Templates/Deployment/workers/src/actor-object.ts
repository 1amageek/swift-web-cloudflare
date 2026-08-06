import { DurableObject } from "cloudflare:workers";
import {
  ApplicationRuntime,
  createApplicationRuntime,
  isActorInvocationDenied,
} from "./application-runtime";
import { errorResponse, logError, readBoundedText } from "./http";

const PRINCIPAL_HEADER = "X-SwiftWeb-Principal";
const ACTOR_ENVELOPE_LIMIT = 1024 * 1024;

/// One Durable Object per actor identity. Swift owns actor dispatch and state
/// semantics; this class owns Cloudflare storage, hibernatable sockets, and the
/// Worker/WASM lifetime.
export class SwiftWebActorObject extends DurableObject<Env> {
  private ready?: Promise<void>;
  private runtime?: ApplicationRuntime;
  private readonly openedSockets = new Map<WebSocket, number>();

  private async applicationRuntime(): Promise<ApplicationRuntime> {
    if (!this.ready) {
      this.ready = (async () => {
        const runtime = await createApplicationRuntime(this.ctx.storage);
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS swiftweb_actor_state (id TEXT PRIMARY KEY, blob TEXT)"
        );
        await runtime.render();
        this.runtime = runtime;
      })().catch((error) => {
        this.ready = undefined;
        this.runtime = undefined;
        throw error;
      });
    }
    await this.ready;
    if (!this.runtime) {
      throw new Error("Swift/WASM actor runtime did not initialize");
    }
    return this.runtime;
  }

  private async openSocket(socket: WebSocket): Promise<number> {
    const runtime = await this.applicationRuntime();
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    const socketID = runtime.openSocket(socket, attachment.principal);
    this.openedSockets.set(socket, socketID);
    return socketID;
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const runtime = await this.applicationRuntime();
    const socketID = this.openedSockets.get(socket) ?? (await this.openSocket(socket));
    const frame = typeof message === "string" ? message : new TextDecoder().decode(message);
    runtime.receiveSocketMessage(socketID, frame);
  }

  override async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const socketID = this.openedSockets.get(socket);
    if (socketID === undefined) {
      return;
    }
    const runtime = await this.applicationRuntime();
    runtime.closeSocket(socketID);
    this.openedSockets.delete(socket);
  }

  override async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(socket, 1011, "socket error", false);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.serializeAttachment({
        principal: request.headers.get(PRINCIPAL_HEADER) ?? "",
      });
      this.ctx.acceptWebSocket(server);
      await this.openSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      const runtime = await this.applicationRuntime();
      const envelopeJSON = await readBoundedText(request, ACTOR_ENVELOPE_LIMIT);
      const principal = request.headers.get(PRINCIPAL_HEADER) ?? "";
      const responseJSON = await runtime.invokeActor(envelopeJSON, principal);
      return new Response(responseJSON, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      if (isActorInvocationDenied(error)) {
        return errorResponse(error instanceof Error ? error.message : "Actor invocation denied", 403);
      }
      logError("Actor invocation failed", error);
      return errorResponse("Actor invocation failed", 500);
    }
  }
}

function parseSocketAttachment(value: unknown): { principal: string } {
  if (
    typeof value === "object" &&
    value !== null &&
    "principal" in value &&
    typeof value.principal === "string"
  ) {
    return { principal: value.principal };
  }
  return { principal: "" };
}
