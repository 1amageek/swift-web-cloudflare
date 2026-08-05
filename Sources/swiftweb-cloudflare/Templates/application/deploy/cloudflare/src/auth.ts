// Edge authentication: verifies the caller's ID token at the Worker with
// WebCrypto (WASM has no crypto), then the Worker forwards the verified
// principal to the Durable Object. Firebase ID tokens by configuration; the
// claim checks mirror FirebaseIDTokenVerifier (RS256 + JWKS, iss/aud/exp/sub),
// and emulator tokens (alg=none) skip only the signature step.

export interface AuthConfig {
  // Verified against the token `aud` claim and used to derive the expected
  // `iss` (`https://securetoken.google.com/<projectID>`).
  projectID: string;
  // When set, signature verification is skipped (emulator tokens are unsigned);
  // claim checks still run.
  emulatorHost?: string;
  // JWKS endpoint serving the Secure Token Service public keys (RSA n/e).
  jwksURL: string;
}

const DEFAULT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface AuthenticationEnvironment {
  SWIFTWEB_AUTH_PROJECT_ID?: string;
  SWIFTWEB_AUTH_EMULATOR_HOST?: string;
  SWIFTWEB_AUTH_JWKS_URL?: string;
}

/// Reads the auth configuration from the Worker environment. Returns null when
/// no project ID is set, which disables edge verification — the Durable
/// Object's actor policy is then the only gate (and denies external RPC by
/// default). Set SWIFTWEB_AUTH_PROJECT_ID to require verified tokens.
export function authConfigFromEnv(env: AuthenticationEnvironment): AuthConfig | null {
  const projectID = env.SWIFTWEB_AUTH_PROJECT_ID?.trim();
  if (!projectID) {
    return null;
  }
  const emulatorHost = env.SWIFTWEB_AUTH_EMULATOR_HOST?.trim();
  return {
    projectID,
    emulatorHost: emulatorHost ? emulatorHost : undefined,
    jwksURL: env.SWIFTWEB_AUTH_JWKS_URL?.trim() || DEFAULT_JWKS_URL,
  };
}

export class TokenVerificationError extends Error {}

export interface VerifiedToken {
  uid: string;
  claims: Record<string, unknown>;
}

interface JWTHeader {
  alg?: string;
  kid?: string;
}

// The DOM/WebWorker `JsonWebKey` type omits `kid`; the Firebase JWKS keys it.
interface FirebaseJWK extends JsonWebKey {
  kid?: string;
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  expiresAt: number; // epoch ms
  url: string;
}

let keyCache: KeyCache | undefined;

/// Verifies a Firebase ID token and returns its uid and claims. Throws
/// TokenVerificationError on any malformed token, bad signature, or failed
/// claim check.
export async function verifyIdToken(token: string, config: AuthConfig): Promise<VerifiedToken> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenVerificationError("token is not a well-formed JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
    throw new TokenVerificationError("token is not a well-formed JWT");
  }

  const header = decodeHeader(headerB64);
  const claims = decodeClaims(payloadB64);

  if (!config.emulatorHost) {
    if (header.alg !== "RS256") {
      throw new TokenVerificationError(`unsupported algorithm: ${header.alg ?? "none"}`);
    }
    if (!header.kid) {
      throw new TokenVerificationError("missing key id (kid)");
    }
    const key = await publicKey(header.kid, config);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64urlToBytes(signatureB64);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      signingInput
    );
    if (!valid) {
      throw new TokenVerificationError("signature is invalid");
    }
  }

  validateClaims(claims, config);

  const userID = claims.user_id;
  const uid = typeof userID === "string" && userID.length > 0 ? userID : claims.sub;
  if (typeof uid !== "string" || uid.length === 0) {
    throw new TokenVerificationError("missing user identifier");
  }
  return { uid, claims };
}

// Firebase's documented claim requirements:
// https://firebase.google.com/docs/auth/admin/verify-id-tokens
function validateClaims(claims: Record<string, unknown>, config: AuthConfig): void {
  const now = Math.floor(Date.now() / 1000);

  const exp = claims.exp;
  if (typeof exp !== "number" || exp <= now) {
    throw new TokenVerificationError("token is expired");
  }

  const expectedIssuer = `https://securetoken.google.com/${config.projectID}`;
  if (claims.iss !== expectedIssuer) {
    throw new TokenVerificationError(`invalid issuer: ${String(claims.iss)}`);
  }

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.projectID)) {
    throw new TokenVerificationError(`invalid audience: ${String(claims.aud)}`);
  }

  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new TokenVerificationError("missing subject (sub)");
  }
}

async function publicKey(kid: string, config: AuthConfig): Promise<CryptoKey> {
  const now = Date.now();
  if (keyCache && keyCache.url === config.jwksURL && keyCache.expiresAt > now) {
    const cached = keyCache.keys.get(kid);
    if (cached) {
      return cached;
    }
  }
  await refreshKeys(config);
  const key = keyCache?.keys.get(kid);
  if (!key) {
    throw new TokenVerificationError(`no public key for kid: ${kid}`);
  }
  return key;
}

async function refreshKeys(config: AuthConfig): Promise<void> {
  const response = await fetch(config.jwksURL);
  if (!response.ok) {
    throw new TokenVerificationError(`JWKS fetch failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new TokenVerificationError("JWKS has no keys");
  }

  const keys = new Map<string, CryptoKey>();
  for (const candidate of body.keys) {
    if (!isFirebaseJWK(candidate)) {
      continue;
    }
    const jwk = candidate;
    if (jwk.kty && jwk.kty !== "RSA") {
      continue;
    }
    if (!jwk.kid) {
      continue;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, alg: "RS256" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) {
    throw new TokenVerificationError("JWKS had no usable RSA keys");
  }

  const maxAge = parseMaxAge(response.headers.get("Cache-Control")) ?? 300;
  keyCache = { keys, expiresAt: Date.now() + maxAge * 1000, url: config.jwksURL };
}

function parseMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) {
    return null;
  }
  for (const directive of cacheControl.split(",")) {
    const trimmed = directive.trim().toLowerCase();
    if (trimmed.startsWith("max-age=")) {
      const seconds = Number(trimmed.slice("max-age=".length));
      if (Number.isFinite(seconds)) {
        return seconds;
      }
    }
  }
  return null;
}

function decodeHeader(segment: string): JWTHeader {
  const value = decodeJSON(segment, "header");
  if (!isRecord(value)) {
    throw new TokenVerificationError("malformed token header");
  }
  const alg = value.alg;
  const kid = value.kid;
  if (alg !== undefined && typeof alg !== "string") {
    throw new TokenVerificationError("malformed token header algorithm");
  }
  if (kid !== undefined && typeof kid !== "string") {
    throw new TokenVerificationError("malformed token header key id");
  }
  return { alg, kid };
}

function decodeClaims(segment: string): Record<string, unknown> {
  const value = decodeJSON(segment, "payload");
  if (!isRecord(value)) {
    throw new TokenVerificationError("malformed token payload");
  }
  return value;
}

function decodeJSON(segment: string, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(segment)));
  } catch {
    throw new TokenVerificationError(`malformed token ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFirebaseJWK(value: unknown): value is FirebaseJWK {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.kid === undefined || typeof value.kid === "string") &&
    (value.kty === undefined || typeof value.kty === "string") &&
    (value.n === undefined || typeof value.n === "string") &&
    (value.e === undefined || typeof value.e === "string")
  );
}

function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
