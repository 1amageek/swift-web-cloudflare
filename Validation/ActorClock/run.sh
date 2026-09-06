#!/usr/bin/env bash
set -euo pipefail

: "${SWIFT_WEB_WASM_SWIFT:?Set the real pinned Swift executable, not a shim}"
: "${SWIFT_WEB_REVISION:?Set the reviewed SwiftWeb commit}"
: "${SWIFT_WEB_TIMEOUT:?Set the path to SwiftWeb scripts/swift-test-timeout.sh}"

fixture_root="$(cd "$(dirname "$0")" && pwd)"
adapter_root="$(cd "$fixture_root/../.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/swift-web-actor-clock.XXXXXX")"
sdk="swift-6.4.x-DEVELOPMENT-SNAPSHOT-2026-08-14-a_wasm-embedded"

test -x "$(dirname "$SWIFT_WEB_WASM_SWIFT")/wasm-ld"
compiler_version="$("$SWIFT_WEB_WASM_SWIFT" --version)"
printf '%s\n' "$compiler_version"
case "$compiler_version" in
  *"Swift 424cae54c1a10da"*) ;;
  *) printf 'The compiler does not match the pinned SDK.\n' >&2; exit 1 ;;
esac
sdk_configuration="$("$SWIFT_WEB_WASM_SWIFT" sdk configure --show-configuration "$sdk" wasm32-unknown-wasip1)"
printf '%s\n' "$sdk_configuration"
resources="$(printf '%s\n' "$sdk_configuration" | sed -n 's/^swiftStaticResourcesPath: //p')"
export ACTOR_CLOCK_UNICODE_ARCHIVE="$(dirname "$resources")/swift/embedded/wasm32-unknown-wasip1/libswiftUnicodeDataTables.a"
test -f "$ACTOR_CLOCK_UNICODE_ARCHIVE"
export SWIFTWEB_CORE_ONLY=1

cp "$fixture_root/Package.swift" "$fixture_root/worker.mjs" "$fixture_root/run-workerd.mjs" "$scratch/"
cp -R "$fixture_root/Sources" "$scratch/"
cp "$adapter_root/Sources/SwiftWebCloudflareHost/CloudflareActorClock.swift" "$scratch/Sources/ClockValidation/"
cp "$adapter_root/Adapter/Templates/Deployment/common/"package{,-lock}.json "$scratch/"
cp "$adapter_root/Adapter/Templates/Deployment/common/src/runtime.mjs" "$scratch/"
cd "$scratch"
printf 'Validation scratch: %s\n' "$scratch"
bash "$SWIFT_WEB_TIMEOUT" 180 npm ci --no-audit --no-fund
bash "$SWIFT_WEB_TIMEOUT" 300 "$SWIFT_WEB_WASM_SWIFT" build --build-system native --jobs 2 \
  --swift-sdk "$sdk" -Xswiftc -Onone 2>&1 | tee embedded-build.log
cmp "$adapter_root/Sources/SwiftWebCloudflareHost/CloudflareActorClock.swift" Sources/ClockValidation/CloudflareActorClock.swift
cp .build/wasm32-unknown-wasip1/debug/ClockValidation.wasm app.wasm
shasum -a 256 app.wasm Sources/ClockValidation/CloudflareActorClock.swift
bash "$SWIFT_WEB_TIMEOUT" 120 node run-workerd.mjs 2>&1 | tee workerd.log
