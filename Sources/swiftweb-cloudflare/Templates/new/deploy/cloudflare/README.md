# Cloudflare

This directory is the Cloudflare Worker boundary for the SwiftWeb app: a
stateless Worker routes `POST /_swiftweb/actors/invoke` by the envelope's
`recipientID` to a per-identity `SwiftWebActorDO`, which hosts the app's
Swift/WASM actor runtime (`SwiftWebCloudflareHost`).

Reference: [SwiftWeb](https://github.com/1amageek/swift-web)

```bash
# 1. Build the app's Durable Object wasm (writes src/app.wasm):
../wasm/build.sh

# 2. Run locally / deploy:
npm install
npm run dev
npm run deploy
```

## Durable actor state (`@ActorStorage`)

An actor's own state lives in wasm memory and is lost when the Durable Object is
evicted or hibernated. Mark a stored property `@ActorStorage` to make it durable —
the actor system loads it from this DO's SQLite when the actor activates and saves
it after each invocation:

```swift
distributed actor Counter {
    @ActorStorage("count") var count = 0        // survives eviction
    distributed func increment() { count += 1 } // written like a normal property
}
```

- State is one row per actor ID in the DO's own SQLite (`new_sqlite_classes` in
  `wrangler.toml` already makes this DO SQLite-backed), so it is colocated with the
  actor — no network hop.
- Use `@ActorStorage` for the actor's **own small state** (counters, settings,
  cursors). For queryable domain data (searched, related, unbounded), use a database
  instead; `@ActorStorage` is the lightweight grain-state layer, not a query engine.

## Securing actor RPC

Edge invocations are **external**, so they run under the app's
`security.actors` policy. The default (`.trustedOnly`) denies external actor
RPC — a `POST /_swiftweb/actors/invoke` or WebSocket call returns **403** until
the app opts in. Choose the policy in the app's `security`:

```swift
struct MyApp: App {
    var security: SecurityConfiguration {
        var configuration = SecurityConfiguration.defaults
        // Only the authenticated principal may address its own actor:
        configuration.actors.authorization = .authenticatedPrincipalMatchesActorName()
        return configuration
    }
    var body: some Scene { ... }
}
```

- `.authenticatedPrincipalMatchesActorName()` requires a principal on the
  invocation context; edge auth (verifying the caller's token in the Worker and
  passing the principal through) is the follow-on step and is not wired yet.
- `.allowAll` disables the gate — acceptable only for a trusted/private
  deployment or local `wrangler dev`, never for a public origin.
- `security.actors.activation` bounds virtual-actor population (max count and
  idle timeout); keep it set so a caller cannot activate unbounded actors.

### Edge authentication

The Worker verifies the caller's ID token with WebCrypto before touching the
Durable Object (WASM has no crypto), then forwards the verified `uid` to the DO
as the authorization principal. Enable it by setting the Firebase project ID in
`wrangler.toml`:

```toml
[vars]
SWIFTWEB_AUTH_PROJECT_ID = "your-firebase-project-id"
```

- The client presents the token as `Authorization: Bearer <idToken>` on the
  HTTP invoke, or `?access_token=<idToken>` on the WebSocket upgrade (browsers
  cannot set handshake headers). A missing or invalid token returns **401**.
- The verified `uid` becomes `principalID` on the invocation context, so
  `.authenticatedPrincipalMatchesActorName()` lets each user reach only their
  own actor.
- With `SWIFTWEB_AUTH_PROJECT_ID` unset, edge verification is off and the
  `security.actors` policy is the only gate — keep it stricter than `.allowAll`
  for any non-local deployment.
- Set `SWIFTWEB_AUTH_EMULATOR_HOST` to accept the Firebase Auth emulator's
  unsigned tokens during local development; claim checks still run.
