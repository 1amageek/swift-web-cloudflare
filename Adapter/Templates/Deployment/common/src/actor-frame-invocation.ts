export interface ActorFrameInvocationContext {
  principalID?: string;
  sessionID?: string;
  tenantID?: string;
  remoteAddress?: string;
  peerID: string;
  hostedActorIdentity: string;
}

export interface ActorFrameInvocationBridge {
  __swiftWebActorPrincipalID?: string;
  __swiftWebActorSessionID?: string;
  __swiftWebActorTenantID?: string;
  __swiftWebActorRemoteAddress?: string;
  __swiftWebActorPeerID?: string;
  __swiftWebHostedActorIdentity?: string;
}

export function writeActorFrameInvocationContext(
  bridge: ActorFrameInvocationBridge,
  context: ActorFrameInvocationContext,
): void {
  if (context.peerID.length === 0) {
    throw new TypeError("Actor frame peer identity is empty");
  }
  if (context.hostedActorIdentity.length === 0) {
    throw new TypeError("Hosted actor identity is empty");
  }
  bridge.__swiftWebActorPrincipalID = context.principalID ?? "";
  bridge.__swiftWebActorSessionID = context.sessionID ?? "";
  bridge.__swiftWebActorTenantID = context.tenantID ?? "";
  bridge.__swiftWebActorRemoteAddress = context.remoteAddress ?? "";
  bridge.__swiftWebActorPeerID = context.peerID;
  bridge.__swiftWebHostedActorIdentity = context.hostedActorIdentity;
}
