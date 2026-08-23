import assert from "node:assert/strict";
import test from "node:test";
import { swiftWebActorFrameLimits } from "../src/actor-frame-limits.ts";

test("reserves a bounded actor envelope outside the payload budget", () => {
  assert.equal(
    swiftWebActorFrameLimits.maximumPayloadByteCount,
    4 * 1024 * 1024,
  );
  assert.equal(
    swiftWebActorFrameLimits.maximumFrameByteCount
      - swiftWebActorFrameLimits.maximumPayloadByteCount,
    64 * 1024,
  );
});
