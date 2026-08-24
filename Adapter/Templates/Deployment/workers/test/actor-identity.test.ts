import assert from "node:assert/strict";
import test from "node:test";
import {
  namedActorIdentity,
  requireMatchingActorIdentity,
} from "../src/actor-identity.ts";
import {
  writeActorFrameInvocationContext,
} from "../src/actor-frame-invocation.ts";

test("uses the Durable Object name as the hosted actor identity", () => {
  assert.equal(namedActorIdentity({ name: "tenant-a/calendar" }), "tenant-a/calendar");
  assert.throws(
    () => namedActorIdentity({ name: undefined }),
    /require a named identity/,
  );
});

test("rejects an actor identity that does not select this Durable Object", () => {
  assert.doesNotThrow(() =>
    requireMatchingActorIdentity("tenant-a/calendar", "tenant-a/calendar")
  );
  assert.throws(
    () => requireMatchingActorIdentity("tenant-a/calendar", "tenant-b/calendar"),
    /does not match the Durable Object/,
  );
});

test("writes the hosted actor identity and clears absent optional context", () => {
  const bridge = {
    __swiftWebActorPrincipalID: "stale-principal",
    __swiftWebActorSessionID: "stale-session",
    __swiftWebActorTenantID: "stale-tenant",
    __swiftWebActorRemoteAddress: "stale-address",
  };

  writeActorFrameInvocationContext(bridge, {
    peerID: "page-runtime",
    hostedActorIdentity: "tenant-a/calendar",
  });

  assert.deepEqual(bridge, {
    __swiftWebActorPrincipalID: "",
    __swiftWebActorSessionID: "",
    __swiftWebActorTenantID: "",
    __swiftWebActorRemoteAddress: "",
    __swiftWebActorPeerID: "page-runtime",
    __swiftWebHostedActorIdentity: "tenant-a/calendar",
  });
});

test("rejects incomplete actor host context before entering Swift", () => {
  assert.throws(
    () => writeActorFrameInvocationContext({}, {
      peerID: "",
      hostedActorIdentity: "tenant-a/calendar",
    }),
    /peer identity is empty/,
  );
  assert.throws(
    () => writeActorFrameInvocationContext({}, {
      peerID: "page-runtime",
      hostedActorIdentity: "",
    }),
    /Hosted actor identity is empty/,
  );
});
