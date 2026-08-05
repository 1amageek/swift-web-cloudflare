#!/bin/sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
SWIFT_SDK="swift-6.4.x-DEVELOPMENT-SNAPSHOT-2026-07-23-a_wasm"
BIN_PATH="$(
  SWIFTWEB_DO=1 xcrun --toolchain org.swift.64202607231a swift build \
    --show-bin-path \
    --swift-sdk "$SWIFT_SDK" \
    -c release
)"
SWIFTWEB_DO=1 xcrun --toolchain org.swift.64202607231a swift build \
  --swift-sdk "$SWIFT_SDK" \
  -c release \
  -Xswiftc -Osize -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor \
  -Xswiftc -Xfrontend -Xswiftc -reflection-metadata-for-debugger-only
INPUT_WASM="$BIN_PATH/AppDurableObjectLauncher.wasm"
OUTPUT_WASM="$HERE/../cloudflare/src/app.wasm"
test -s "$INPUT_WASM"
npx --yes wasm-opt \
  "$INPUT_WASM" \
  -Oz --strip-debug -o "$OUTPUT_WASM"
test -s "$OUTPUT_WASM"
echo "wrote $OUTPUT_WASM"
