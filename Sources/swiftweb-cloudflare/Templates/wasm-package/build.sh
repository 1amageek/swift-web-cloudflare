#!/bin/sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
SWIFTWEB_DO=1 swiftly run +6.3.1 swift build \
  --swift-sdk swift-6.3.1-RELEASE_wasm -c release \
  -Xswiftc -Osize -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
npx --yes wasm-opt \
  .build/wasm32-unknown-wasip1/release/AppDurableObjectLauncher.wasm \
  -Oz --strip-debug -o "$HERE/../cloudflare/src/app.wasm"
echo "wrote ../cloudflare/src/app.wasm"
