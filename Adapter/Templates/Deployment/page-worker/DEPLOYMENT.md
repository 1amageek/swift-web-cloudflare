# Cloudflare page deployment

This Deployment serves pages and endpoints from the Embedded Swift/WASM Host.
It does not host application actor state. Concrete actors declared by selected
Service applications are resolved through generated external Durable Object
bindings; the logical identity still comes from Swift
`.actor(Type.self, identity:)`.

`sweb build` validates the generated Worker with a Wrangler dry run. The
reported compressed upload size is the deployment-size acceptance result.
