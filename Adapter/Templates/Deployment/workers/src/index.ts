import { authConfigFromEnv, verifyIdToken } from "./auth";
import { swiftWebActorFrameLimits } from "./actor-frame-limits";
import { pageApplicationRuntime } from "./application-runtime";
import { installSwiftWebActorServices } from "./actor-services";
import { SwiftWebActorObject } from "./actor-object";
import {
  RequestBodyTooLargeError,
  errorResponse,
  logError,
  readBoundedBytes,
} from "./http";

export { SwiftWebActorObject };

const ACTOR_FRAME_PATH = "/_swiftweb/actors/frame";
const ACTOR_FRAME_MEDIA_TYPE = "application/vnd.swift-actor-frame";
const ACTOR_PEER_HEADER = "X-SwiftWeb-Actor-Peer-ID";

interface AuthenticationResult {
  uid: string | null;
}

export default {
  async fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    installSwiftWebActorServices(env);
    const url = new URL(request.url);

    if (url.pathname === "/_swiftweb/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === ACTOR_FRAME_PATH && request.method === "POST") {
      const actorIdentity = url.searchParams.get("actor");
      const peerID = request.headers.get(ACTOR_PEER_HEADER);
      if (!actorIdentity || !peerID) {
        return errorResponse("Actor identity or peer identity is missing", 400);
      }
      if (!hasActorFrameMediaType(request.headers.get("content-type"))) {
        return errorResponse("Binary actor frame content type is required", 415);
      }
      const authentication = await authenticate(request, url, env);
      if (authentication instanceof Response) {
        return authentication;
      }
      try {
        const frame = await readBoundedBytes(
          request,
          swiftWebActorFrameLimits.maximumFrameByteCount,
        );
        const result = await env.SWIFTWEB_ACTOR
          .getByName(actorIdentity)
          .invokeActorFrame(frame, {
            principalID: authentication.uid ?? undefined,
            peerID,
          });
        return new Response(result, {
          status: result === null ? 204 : 200,
          headers: result === null ? undefined : { "content-type": ACTOR_FRAME_MEDIA_TYPE },
        });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return errorResponse("Actor frame is too large", 413);
        }
        logError("Actor frame invocation failed", error);
        return errorResponse("Actor frame invocation failed", 500);
      }
    }

    try {
      const runtime = await pageApplicationRuntime();
      return await runtime.respond(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return errorResponse("Request body is too large", 413);
      }
      logError("Page request failed", error);
      return errorResponse("Page request failed", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function authenticate(
  request: Request,
  url: URL,
  env: Env
): Promise<AuthenticationResult | Response> {
  const config = authConfigFromEnv(env);
  if (!config) {
    return { uid: null };
  }
  const token = extractToken(request, url);
  if (!token) {
    return errorResponse("Missing bearer token", 401);
  }
  try {
    const { uid } = await verifyIdToken(token, config);
    return { uid };
  } catch (error) {
    logError("Token verification failed", error);
    return errorResponse("Invalid bearer token", 401);
  }
}

function extractToken(request: Request, url: URL): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return url.searchParams.get("access_token");
}

function hasActorFrameMediaType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === ACTOR_FRAME_MEDIA_TYPE;
}
