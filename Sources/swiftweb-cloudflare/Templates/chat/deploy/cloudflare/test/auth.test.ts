import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyIdToken, authConfigFromEnv, TokenVerificationError, type AuthConfig } from "../src/auth.ts";

const config: AuthConfig = {
  projectID: "demo-proj",
  emulatorHost: "127.0.0.1:9099", // emulator mode → signature skipped, claims enforced
  jwksURL: "",
};

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "none" }) =>
  `${b64url(header)}.${b64url(payload)}.`;
const validPayload = () => ({
  iss: "https://securetoken.google.com/demo-proj",
  aud: "demo-proj",
  sub: "user-123",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

test("accepts a valid emulator token and returns the uid", async () => {
  const { uid } = await verifyIdToken(token(validPayload()), config);
  assert.equal(uid, "user-123");
});

test("prefers user_id over sub for the uid", async () => {
  const { uid } = await verifyIdToken(token({ ...validPayload(), user_id: "canonical" }), config);
  assert.equal(uid, "canonical");
});

test("rejects an expired token", async () => {
  await assert.rejects(
    verifyIdToken(token({ ...validPayload(), exp: Math.floor(Date.now() / 1000) - 10 }), config),
    TokenVerificationError
  );
});

test("rejects a wrong issuer", async () => {
  await assert.rejects(
    verifyIdToken(token({ ...validPayload(), iss: "https://evil.example/demo-proj" }), config),
    TokenVerificationError
  );
});

test("rejects a wrong audience", async () => {
  await assert.rejects(
    verifyIdToken(token({ ...validPayload(), aud: "other-proj" }), config),
    TokenVerificationError
  );
});

test("rejects a missing subject", async () => {
  const p = validPayload(); delete (p as any).sub;
  await assert.rejects(verifyIdToken(token(p), config), TokenVerificationError);
});

test("rejects a malformed JWT", async () => {
  await assert.rejects(verifyIdToken("not-a-jwt", config), TokenVerificationError);
});

test("authConfigFromEnv: disabled without a project id, enabled with one", () => {
  assert.equal(authConfigFromEnv({}), null);
  assert.equal(authConfigFromEnv({ SWIFTWEB_AUTH_PROJECT_ID: "  " }), null);
  const c = authConfigFromEnv({ SWIFTWEB_AUTH_PROJECT_ID: "p", SWIFTWEB_AUTH_EMULATOR_HOST: "h" });
  assert.equal(c?.projectID, "p");
  assert.equal(c?.emulatorHost, "h");
});
