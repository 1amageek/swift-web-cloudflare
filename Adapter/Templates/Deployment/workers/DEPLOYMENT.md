# Actor-enabled Cloudflare deployment

This Deployment adds one `SwiftWebActorObject` Durable Object per actor
identity, hibernatable WebSockets, edge authentication, and regular Swift/WASM
hosting to the common Cloudflare runtime.

Set `SWIFTWEB_AUTH_PROJECT_ID` to a Firebase project identifier to require ID
token verification before actor traffic reaches a Durable Object. For local
Firebase Auth emulator use, set `SWIFTWEB_AUTH_EMULATOR_HOST`. Leave the project
identifier empty to rely on the app's actor authorization policy alone.

The browser sends `Authorization: Bearer <token>` for HTTP actor invocations.
WebSocket clients use `?access_token=<token>` because browser WebSocket APIs
cannot set handshake headers.

The current actor-enabled graph does not satisfy a 3 MiB compressed deployment
budget. Treat the `sweb build` Wrangler dry-run result as a required release
gate until the actor runtime supports Embedded WASM.
