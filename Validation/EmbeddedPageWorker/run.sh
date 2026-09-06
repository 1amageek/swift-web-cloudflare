#!/usr/bin/env bash
set -euo pipefail

: "${SWIFT_WEB_WASM_SWIFT:?Set the real pinned Swift executable}"
: "${SWIFT_WEB_TIMEOUT:?Set SwiftWeb scripts/swift-test-timeout.sh}"
: "${SWIFT_WEB_NATIVE_SCRATCH:?Set an exclusive warm Native build scratch directory}"
: "${SWIFT_WEB_SWEB:?Set the public-revision sweb executable}"

fixture_root="$(cd "$(dirname "$0")" && pwd)"
sdk="swift-6.4.x-DEVELOPMENT-SNAPSHOT-2026-08-14-a_wasm-embedded"
export SWIFT_WEB_WASM_TOOLCHAIN_BIN="$(dirname "$SWIFT_WEB_WASM_SWIFT")"
test -x "$SWIFT_WEB_WASM_TOOLCHAIN_BIN/wasm-ld"
case "$("$SWIFT_WEB_WASM_SWIFT" --version)" in
  *"Swift 424cae54c1a10da"*) ;;
  *) printf 'The compiler must match the pinned SDK.\n' >&2; exit 1 ;;
esac
df -h "$fixture_root"
sdk_configuration="$("$SWIFT_WEB_WASM_SWIFT" sdk configure --show-configuration "$sdk" wasm32-unknown-wasip1)"
printf '%s\n' "$sdk_configuration"
sdk_root="$(printf '%s\n' "$sdk_configuration" | sed -n 's/^sdkRootPath: //p')"
sdk_resources="$(printf '%s\n' "$sdk_configuration" | sed -n 's/^swiftResourcesPath: //p')"
cd "$fixture_root"
bash "$SWIFT_WEB_TIMEOUT" 300 "$SWIFT_WEB_WASM_SWIFT" build \
  --scratch-path "$SWIFT_WEB_NATIVE_SCRATCH" --jobs 2 --product actor-system
native_products="$SWIFT_WEB_NATIVE_SCRATCH/out/Products/Debug"
generator="$native_products/actor-system"
test -x "$generator"
generation=(--module EmbeddedPage --package embeddedpageworker \
  --source-root "$fixture_root/Sources/EmbeddedPage" \
  --source "$fixture_root/Sources/EmbeddedPage/ProbeActor.swift" \
  --lock "$fixture_root/ActorSchema.lock" \
  --swiftc "$SWIFT_WEB_WASM_TOOLCHAIN_BIN/swiftc" \
  --actor-system-type SwiftWebActors.WebActorSystem --include-actor-system WebActorSystem)
bash "$SWIFT_WEB_TIMEOUT" 120 "$generator" generate "${generation[@]}" \
  --profile nativeHost --output "$fixture_root/Sources/EmbeddedPage/ActorSystemGenerated" \
  --compiler-arg -I --compiler-arg "$native_products" \
  --compiler-arg -F --compiler-arg "$native_products" \
  --compiler-arg -sdk --compiler-arg "$(xcrun --sdk macosx --show-sdk-path)"
bash "$SWIFT_WEB_TIMEOUT" 120 "$generator" project "${generation[@]}" \
  --profile embeddedClient --output "$fixture_root/.generated/embedded/Sources/EmbeddedPage/Generated" \
  --compiler-arg -enable-experimental-feature --compiler-arg Embedded \
  --compiler-arg -target --compiler-arg wasm32-unknown-wasip1 \
  --compiler-arg -sdk --compiler-arg "$sdk_root" \
  --compiler-arg -resource-dir --compiler-arg "$sdk_resources" \
  --available-module ActorSystemCore --available-module ActorSystemEmbedded \
  --available-module SwiftWebActors
cp Sources/EmbeddedPage/EmbeddedPage.swift Sources/EmbeddedPage/ProbePage.swift .generated/embedded/Sources/EmbeddedPage/
bash "$SWIFT_WEB_TIMEOUT" 300 "$SWIFT_WEB_SWEB" prepare --package-path "$fixture_root" --environment local --runtime embedded
bash "$SWIFT_WEB_TIMEOUT" 300 "$SWIFT_WEB_SWEB" prepare --package-path "$fixture_root" --environment embedded --runtime embedded

workspace="$fixture_root/.swiftweb/generated/environments/embedded/workspace"
cloudflare="$workspace/cloudflare"
cp Sources/EmbeddedPage/EmbeddedPage.swift Sources/EmbeddedPage/ProbePage.swift .generated/embedded/Sources/EmbeddedPage/
mkdir -p "$fixture_root/.generated/native"
cp "$fixture_root/.swiftweb/generated/server/Sources/AppServerLauncher/ServerLauncher.swift" "$fixture_root/.generated/native/ServerLauncher.swift"
SWIFT_WEB_BUILD_NATIVE_PEER=1 bash "$SWIFT_WEB_TIMEOUT" 1200 "$SWIFT_WEB_WASM_SWIFT" build \
  --package-path "$fixture_root" \
  --scratch-path "$SWIFT_WEB_NATIVE_SCRATCH" --jobs 2 --product NativePeer \
  2>&1 | tee "$fixture_root/.generated/native-build.log"
df -h "$fixture_root"
unicode_directory="$sdk_resources/embedded/wasm32-unknown-wasip1"
test -f "$unicode_directory/libswiftUnicodeDataTables.a"
SWIFTWEB_HOSTED_APPLICATION=1 JAVASCRIPTKIT_EXPERIMENTAL_EMBEDDED_WASM=1 \
  bash "$SWIFT_WEB_TIMEOUT" 1200 "$SWIFT_WEB_WASM_SWIFT" build \
  --package-path "$workspace/wasm" --build-path "$fixture_root/.build" \
  --build-system native --jobs 2 --disable-index-store --swift-sdk "$sdk" --product AppWorkerLauncher \
  -Xswiftc -Onone \
  -Xlinker "-L$unicode_directory" \
  -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor \
  2>&1 | tee "$fixture_root/.generated/embedded-build.log"
cp "$fixture_root/.build/wasm32-unknown-wasip1/debug/AppWorkerLauncher.wasm" "$cloudflare/src/app.wasm"
shasum -a 256 ActorSchema.lock "$cloudflare/src/app.wasm"
node --input-type=module - "$SWIFT_WEB_NATIVE_SCRATCH/workspace-state.json" "$fixture_root/.build/workspace-state.json" \
  "$fixture_root/.build/wasm32-unknown-wasip1/debug/description.json" \
  "$fixture_root/.build/arm64-apple-macosx/debug/plugin-tools-description.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const revisions = {
  "swift-web": "3408c74f35143539fa4b79c0785dad72dbb795a1",
  "swift-web-cloudflare": "6f9d70353e65d01e1cad2dcc8a8e6b783d243844",
  "swift-actor-system": "cdbca08b3a08d3cd5620ae16b5c33c372aff1ad3",
};
const [nativeState, embeddedState, targetPlan, toolPlan] = process.argv.slice(2);
for (const path of [nativeState, embeddedState]) {
  const dependencies = JSON.parse(readFileSync(path)).object.dependencies;
  assert(dependencies.every(dependency => dependency.state.name !== "edited"));
  for (const [identity, revision] of Object.entries(revisions)) {
    const dependency = dependencies.find(value => value.packageRef.identity === identity);
    assert(dependency, `${identity} is absent from ${path}`);
    assert.equal(dependency.packageRef.kind, "remoteSourceControl");
    assert.equal(dependency.state.checkoutState.revision, revision);
  }
  console.log(`Verified public dependency revisions: ${path}`);
}
const target = JSON.parse(readFileSync(targetPlan)).swiftCommands["C.AppWorkerLauncher-wasm32-unknown-wasip1-debug.module"];
assert(target.otherArguments.includes("Embedded"));
assert(target.otherArguments.includes("-wmo"));
assert(target.otherArguments.includes("-Onone"));
const macro = JSON.parse(readFileSync(toolPlan)).swiftCommands["C.SwiftSyntax-arm64-apple-macosx-debug-tool.module"];
assert(!macro.otherArguments.includes("-wmo"));
assert(!macro.otherArguments.includes("-whole-module-optimization"));
console.log("Verified Embedded Debug WMO and native macro compilation separation");
NODE

port="${SWIFT_WEB_NATIVE_PORT:-18767}"
origin="http://127.0.0.1:$port"
"$native_products/NativePeer" --hostname 127.0.0.1 --port "$port" > "$fixture_root/.generated/native-runtime.log" 2>&1 &
native_pid=$!
native_cleanup_started=0
cleanup() {
  if test "$native_cleanup_started" -eq 1; then return 0; fi
  native_cleanup_started=1
  local cleanup_status=0 acknowledgement native_exit
  if ! kill -0 "$native_pid" 2>/dev/null; then
    printf 'Native peer exited before Core shutdown.\n' >&2
    if wait "$native_pid"; then native_exit=0; else native_exit=$?; fi
    printf 'Unexpected Native exit: %s\n' "$native_exit" >&2
    return 1
  fi
  if acknowledgement="$(curl --fail --silent --show-error --max-time 10 -X POST "$origin/shutdown")"; then
    test "$acknowledgement" = stopped || cleanup_status=1
  else
    cleanup_status=1
  fi
  kill -TERM "$native_pid" || cleanup_status=1
  for _ in $(seq 1 50); do
    if ! kill -0 "$native_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if kill -0 "$native_pid" 2>/dev/null; then
    kill -KILL "$native_pid"
    cleanup_status=1
  fi
  if wait "$native_pid"; then native_exit=0; else native_exit=$?; fi
  test "$native_exit" -eq 143 || cleanup_status=1
  return "$cleanup_status"
}
trap 'status=$?; cleanup || status=1; exit "$status"' EXIT
ready=0
for _ in $(seq 1 100); do
  if curl --fail --silent --max-time 1 "$origin/health" > /dev/null; then ready=1; break; fi
  kill -0 "$native_pid"
  sleep 0.1
done
test "$ready" -eq 1
bash "$SWIFT_WEB_TIMEOUT" 90 node "$fixture_root/run-workerd.mjs" "$cloudflare" "$origin" \
  2>&1 | tee "$fixture_root/.generated/workerd.log"
cleanup
trap - EXIT
