# Embedded Worker actor clock validation

This fixture compiles the unchanged production `CloudflareActorClock.swift`
with the real SwiftWeb Actors product and runs it in local workerd. It checks
shared-clock installation, preservation of a custom unavailable clock,
repeated/late installation rejection, automatic deadlines, cancellation, Core
shutdown, and zero active or late-firing timers after a 600 ms grace period.
A fresh WASM instance verifies that attempting the unavailable default clock
also closes the installation window.

Set `SWIFT_WEB_WASM_SWIFT` to the real pinned Swift 6.4 snapshot executable,
`SWIFT_WEB_REVISION` to the exact reviewed SwiftWeb commit, and
`SWIFT_WEB_TIMEOUT` to that checkout's `scripts/swift-test-timeout.sh`. Then run:

```bash
bash Validation/ActorClock/run.sh
```

The script creates a temporary directory, reuses the deployment's locked npm
dependencies and vendored JavaScript runtime, and retains the raw Debug WASM,
resolved package graph, build log, hashes, and workerd report. It does not
deploy or clean unrelated files. Linker flags belong only to the WASM fixture
target, not the native BridgeJS macro executable.

This is a clock/Core integration gate, not proof of page rendering, networking,
production Worker timing, or a hard-real-time deadline. The full page-worker
gate owns AppRenderer and generated deployment integration.
