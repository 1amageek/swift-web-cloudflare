export interface Env {
  SWIFTWEB_PLATFORM: "cloudflare";
  SWIFTWEB_TEMPLATE: "chat";
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__swiftweb/health") {
      return textResponse("ok", 200);
    }

    return textResponse(
      "SwiftWeb Cloudflare chat scaffold is installed. The Swift/WASM dispatch host has not been materialized yet.",
      501
    );
  }
};

