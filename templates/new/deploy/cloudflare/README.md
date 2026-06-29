# Cloudflare

This directory is the Cloudflare Worker boundary for the SwiftWeb app.

SwiftWeb should not run Vapor inside Cloudflare Workers. The real Cloudflare
adapter will materialize a Worker module and Swift/WASM dispatch host here.

```bash
npm install
npm run dev
```

