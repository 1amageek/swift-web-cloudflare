# Page-only Cloudflare deployment

This Deployment serves pages and endpoints from the Embedded Swift/WASM Host.
It contains no distributed-actor Durable Object, actor socket, or edge token
verification implementation.

`sweb build` validates the generated Worker with a Wrangler dry run. The
reported compressed upload size is the deployment-size acceptance result.
