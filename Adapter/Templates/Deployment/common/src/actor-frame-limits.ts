/// Matches SwiftWebActorMessageLimits: the actor payload may consume 4 MiB,
/// while framing, identity, method, schema, and result metadata use a separate
/// bounded allowance.
export const swiftWebActorFrameLimits = {
  maximumPayloadByteCount: 4 * 1024 * 1024,
  maximumFrameByteCount: 4 * 1024 * 1024 + 64 * 1024,
} as const;
