import { pageApplicationRuntime } from "./application-runtime";
import { installSwiftWebActorServices } from "./actor-services";
import {
  RequestBodyTooLargeError,
  errorResponse,
  logError,
} from "./http";

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    installSwiftWebActorServices(environment);
    const url = new URL(request.url);
    if (url.pathname === "/_swiftweb/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    try {
      return await (await pageApplicationRuntime()).respond(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return errorResponse("Request body is too large", 413);
      }
      logError("Page request failed", error);
      return errorResponse("Page request failed", 500);
    }
  },
} satisfies ExportedHandler<Env>;
