import { pageApplicationRuntime } from "./application-runtime";
import {
  RequestBodyTooLargeError,
  errorResponse,
  logError,
} from "./http";

export default {
  async fetch(request: Request): Promise<Response> {
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
