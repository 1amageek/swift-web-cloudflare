# SwiftWeb Cloudflare

Cloudflare platform templates for SwiftWeb.

This repository is referenced by `sweb --platform cloudflare` and by explicit
GitHub references such as `sweb --platform 1amageek/swift-web-cloudflare/chat`.

```mermaid
flowchart LR
  A["sweb --platform cloudflare/chat"] --> B["sweb.json"]
  B --> C["templates/chat"]
  C --> D["deploy/cloudflare"]
```

| Path | Purpose |
|---|---|
| `sweb.json` | Adapter template manifest consumed by `sweb`. |
| `templates/new` | Default Cloudflare Worker scaffold. |
| `templates/chat` | Cloudflare Worker scaffold for chat-oriented apps. |

The template directories are copied relative to the SwiftWeb app package root.
