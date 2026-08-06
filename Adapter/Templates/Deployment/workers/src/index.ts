import { authConfigFromEnv, verifyIdToken } from "./auth";
import { pageApplicationRuntime } from "./application-runtime";
import { SwiftWebActorObject } from "./actor-object";
import {
  RequestBodyTooLargeError,
  errorResponse,
  logError,
  readBoundedText,
} from "./http";

export { SwiftWebActorObject };

const ACTOR_INVOKE_PATH = "/_swiftweb/actors/invoke";
const ACTOR_SOCKET_PATH = "/_swiftweb/actors/ws";
const PRINCIPAL_HEADER = "X-SwiftWeb-Principal";
const ACTOR_ENVELOPE_LIMIT = 1024 * 1024;

interface AuthenticationResult {
  uid: string | null;
}

export default {
  async fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_swiftweb/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === ACTOR_SOCKET_PATH) {
      const actor = url.searchParams.get("actor");
      if (request.headers.get("Upgrade") !== "websocket" || !actor) {
        return errorResponse(
          "Expected a WebSocket upgrade with ?actor=<recipientID>",
          400
        );
      }
      const authentication = await authenticate(request, url, env);
      if (authentication instanceof Response) {
        return authentication;
      }
      const id = env.SWIFTWEB_ACTOR.idFromName(actor);
      return env.SWIFTWEB_ACTOR.get(id).fetch(
        withPrincipal(request, authentication.uid)
      );
    }

    if (url.pathname === ACTOR_INVOKE_PATH && request.method === "POST") {
      const authentication = await authenticate(request, url, env);
      if (authentication instanceof Response) {
        return authentication;
      }
      try {
        const envelopeJSON = await readBoundedText(request, ACTOR_ENVELOPE_LIMIT);
        const recipientID = invocationRecipientID(envelopeJSON);
        const id = env.SWIFTWEB_ACTOR.idFromName(recipientID);
        return env.SWIFTWEB_ACTOR.get(id).fetch(
          new Request(request.url, {
            method: "POST",
            body: envelopeJSON,
            headers: { [PRINCIPAL_HEADER]: authentication.uid ?? "" },
          })
        );
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return errorResponse("Actor invocation envelope is too large", 413);
        }
        return errorResponse(
          error instanceof Error ? error.message : "Invalid actor invocation envelope",
          400
        );
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

function withPrincipal(request: Request, uid: string | null): Request {
  const headers = new Headers(request.headers);
  headers.delete(PRINCIPAL_HEADER);
  headers.set(PRINCIPAL_HEADER, uid ?? "");
  return new Request(request, { headers });
}

function invocationRecipientID(envelopeJSON: string): string {
  const parsed: unknown = JSON.parse(envelopeJSON);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("recipientID" in parsed) ||
    typeof parsed.recipientID !== "string" ||
    parsed.recipientID.length === 0
  ) {
    throw new Error("Actor invocation envelope is missing recipientID");
  }
  return parsed.recipientID;
}
