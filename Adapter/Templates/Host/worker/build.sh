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
SWIFT_STATIC_RESOURCES_PATH="$(
  TOOLCHAINS="$SWIFT_TOOLCHAIN" /usr/bin/swift sdk configure \
    --show-configuration "$SWIFT_SDK" wasm32-unknown-wasip1 |
    awk -F ': ' '/^swiftStaticResourcesPath:/ { print $2 }'
)"
UNICODE_LIBRARY_DIRECTORY="$(dirname "$SWIFT_STATIC_RESOURCES_PATH")/swift/embedded/wasm32-unknown-wasip1"
if [ ! -f "$UNICODE_LIBRARY_DIRECTORY/libswiftUnicodeDataTables.a" ]; then
  echo "Matching Swift Unicode archive was not found for $SWIFT_SDK" >&2
  exit 1
fi
TOOLCHAINS="$SWIFT_TOOLCHAIN" /usr/bin/swift build \
  --scratch-path "$SCRATCH_PATH" \
  --swift-sdk "$SWIFT_SDK" \
  --product AppWorkerLauncher \
  -c release \
  --disable-index-store \
  -debug-info-format none \
  -j 1 \
  -Xlinker "-L$UNICODE_LIBRARY_DIRECTORY" \
  -Xswiftc -Osize \
  -Xswiftc -whole-module-optimization \
  -Xswiftc -Xfrontend \
  -Xswiftc -internalize-at-link \
  -Xswiftc -Xfrontend \
  -Xswiftc -disable-reflection-metadata \
  -Xbuild-tools-swiftc -Onone \
  -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
INPUT_WASM="$SCRATCH_PATH/out/Products/Release-webassembly-wasm32/AppWorkerLauncher.wasm"
OUTPUT_WASM="$HERE/../cloudflare/src/app.wasm"
test -s "$INPUT_WASM"
npx --yes --package binaryen@131.0.0 wasm-opt \
  "$INPUT_WASM" \
  -Oz --strip-debug \
  --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
  -o "$OUTPUT_WASM"
test -s "$OUTPUT_WASM"
echo "wrote $OUTPUT_WASM"
