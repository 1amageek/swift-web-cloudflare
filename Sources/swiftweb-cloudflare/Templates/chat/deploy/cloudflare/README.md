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
