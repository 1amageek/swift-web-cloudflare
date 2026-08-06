#!/bin/sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH_PATH="$HERE/.build/worker"
SWIFT_SDK="{{cloudflare.swiftSDK}}"
SWIFT_TOOLCHAIN="{{cloudflare.swiftToolchain}}"
export ARCHS="$(uname -m)"
export ONLY_ACTIVE_ARCH=YES
export SWIFT_COMPILATION_MODE=singlefile
cd "$HERE"
TOOLCHAINS="$SWIFT_TOOLCHAIN" /usr/bin/swift build \
  --scratch-path "$SCRATCH_PATH" \
  --swift-sdk "$SWIFT_SDK" \
  --product AppWorkerLauncher \
  -c release \
  --disable-index-store \
  -Xswiftc -Osize \
  -Xbuild-tools-swiftc -Onone \
  -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
INPUT_WASM="$SCRATCH_PATH/out/Products/Release-webassembly-wasm32/AppWorkerLauncher.wasm"
OUTPUT_WASM="$HERE/../cloudflare/src/app.wasm"
test -s "$INPUT_WASM"
npx --yes wasm-opt \
  "$INPUT_WASM" \
  -Oz --strip-debug \
  --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
  -o "$OUTPUT_WASM"
test -s "$OUTPUT_WASM"
echo "wrote $OUTPUT_WASM"
