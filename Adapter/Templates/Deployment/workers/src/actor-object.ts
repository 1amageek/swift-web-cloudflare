import { DurableObject } from "cloudflare:workers";
import {
  type ActorFrameInvocationContext,
  type ApplicationRuntime,
  createApplicationRuntime,
} from "./application-runtime";
import { swiftWebActorFrameLimits } from "./actor-frame-limits";
import { errorResponse, logError, readBoundedBytes } from "./http";

const ACTOR_FRAME_MEDIA_TYPE = "application/vnd.swift-actor-frame";
const ACTOR_PEER_HEADER = "X-SwiftWeb-Actor-Peer-ID";
const PRINCIPAL_HEADER = "X-SwiftWeb-Principal";

/// One Durable Object per actor identity. Swift owns actor decoding,
/// authorization, activation, dispatch, and result encoding. This class owns
/// only the Cloudflare object/WASM lifetime and bounded byte transfer.
export class SwiftWebActorObject extends DurableObject<Env> {
  private ready?: Promise<ApplicationRuntime>;

  private applicationRuntime(): Promise<ApplicationRuntime> {
    if (!this.ready) {
      this.ready = createApplicationRuntime(this.ctx.storage)
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

  async invokeActorFrame(
    frame: Uint8Array,
    context: ActorFrameInvocationContext
  ): Promise<Uint8Array | null> {
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError("Actor frame must be Uint8Array");
    }
    if (frame.byteLength > swiftWebActorFrameLimits.maximumFrameByteCount) {
      throw new RangeError("Actor frame exceeds the Cloudflare transport limit");
    }
    const response = await (await this.applicationRuntime()).invokeActorFrame(
      frame,
      context
    );
    if (response !== null
        && response.byteLength > swiftWebActorFrameLimits.maximumFrameByteCount) {
      throw new RangeError("Actor result frame exceeds the Cloudflare transport limit");
    }
    return response;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse("Actor frame endpoint requires POST", 405);
    }
    const peerID = request.headers.get(ACTOR_PEER_HEADER);
    if (!peerID) {
      return errorResponse("Actor peer identity is missing", 400);
    }
    try {
      const frame = await readBoundedBytes(
        request,
        swiftWebActorFrameLimits.maximumFrameByteCount,
      );
      const response = await this.invokeActorFrame(frame, {
        principalID: request.headers.get(PRINCIPAL_HEADER) ?? undefined,
        peerID,
      });
      return new Response(response, {
        status: response === null ? 204 : 200,
        headers: response === null ? undefined : { "content-type": ACTOR_FRAME_MEDIA_TYPE },
      });
    } catch (error) {
      logError("Actor frame invocation failed", error);
      return errorResponse("Actor frame invocation failed", 500);
    }
  }
}
