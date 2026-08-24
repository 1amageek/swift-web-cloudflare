export function namedActorIdentity(
  durableObjectID: Pick<DurableObjectId, "name">,
): string {
  const identity = durableObjectID.name;
  if (!identity) {
    throw new TypeError("SwiftWeb actor Durable Objects require a named identity");
  }
  return identity;
}

export function requireMatchingActorIdentity(
  hostedActorIdentity: string,
  requestedActorIdentity: string,
): void {
  if (requestedActorIdentity.length === 0) {
    throw new TypeError("Hosted actor identity is empty");
  }
  if (requestedActorIdentity !== hostedActorIdentity) {
    throw new TypeError("Hosted actor identity does not match the Durable Object");
  }
}
