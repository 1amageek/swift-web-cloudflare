const ACTOR_FRAME_MEDIA_TYPE = "application/vnd.swift-actor-frame";

export interface ActorServiceRoute {
  transport: string;
  endpointPrefix: string;
  endpointSuffix: string;
}

export interface ActorServiceConfiguration {
  bindingName: string;
  className: string;
  scriptName: string;
}

export interface ActorServiceBinding {
  service: string;
  product: string;
  module: string;
  type: string;
  hostRoute: ActorServiceRoute;
  clientRoute: ActorServiceRoute | null;
  configuration: ActorServiceConfiguration;
}

interface ActorServiceObject {
  invokeActorFrame(
    frame: Uint8Array,
    context: { peerID: string; hostedActorIdentity: string },
  ): Promise<Uint8Array | null>;
}

interface ActorServiceNamespace {
  getByName(identity: string): ActorServiceObject;
}

const actorServices = {{actors.deploymentBindingsJSON}} as ActorServiceBinding[];

export function installSwiftWebActorServices(environment: unknown): void {
  const bridge = globalThis as typeof globalThis & {
    __swiftWebActorRequest?: (
      endpoint: unknown,
      frame: unknown,
      signal: unknown,
      peerID: unknown,
    ) => Promise<Response>;
  };
  bridge.__swiftWebActorRequest = createSwiftWebActorRequestHandler(
    environment,
    actorServices,
  );
}

export function createSwiftWebActorRequestHandler(
  environment: unknown,
  services: readonly ActorServiceBinding[],
): (
  endpoint: unknown,
  frame: unknown,
  signal: unknown,
  peerID: unknown,
) => Promise<Response> {
  const bindings = environment as Record<string, unknown>;
  return async (endpoint, frame, signal, peerID) => {
    if (typeof endpoint !== "string") {
      throw new TypeError("Actor service endpoint must be a string");
    }
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError("Actor service frame must be Uint8Array");
    }
    if (typeof peerID !== "string" || peerID.length === 0) {
      throw new TypeError("Actor service peer identity is missing");
    }
    if (isAborted(signal)) {
      throw new DOMException("Actor request was cancelled", "AbortError");
    }

    const matches = services.filter((service) =>
      endpoint.startsWith(service.hostRoute.endpointPrefix)
        && endpoint.endsWith(service.hostRoute.endpointSuffix)
    );
    if (matches.length === 0) {
      throw new TypeError("Actor service endpoint has no deployment binding");
    }
    if (matches.length > 1) {
      throw new TypeError("Actor service endpoint has ambiguous deployment bindings");
    }
    const match = matches[0];
    const identityEnd = match.hostRoute.endpointSuffix.length === 0
      ? endpoint.length
      : endpoint.length - match.hostRoute.endpointSuffix.length;
    const encodedIdentity = endpoint.slice(
      match.hostRoute.endpointPrefix.length,
      identityEnd,
    );
    if (encodedIdentity.length === 0) {
      throw new TypeError("Actor service identity is missing");
    }
    const identity = decodeURIComponent(encodedIdentity);
    const namespace = bindings[match.configuration.bindingName] as
      ActorServiceNamespace | undefined;
    if (!namespace || typeof namespace.getByName !== "function") {
      throw new TypeError(
        `Actor service binding '${match.configuration.bindingName}' is unavailable`,
      );
    }
    const result = await namespace.getByName(identity).invokeActorFrame(
      frame,
      { peerID, hostedActorIdentity: identity },
    );
    if (isAborted(signal)) {
      throw new DOMException("Actor request was cancelled", "AbortError");
    }
    return new Response(result, {
      status: result === null ? 204 : 200,
      headers: result === null
        ? undefined
        : { "content-type": ACTOR_FRAME_MEDIA_TYPE },
    });
  };
}

function isAborted(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "aborted" in value
    && value.aborted === true;
}
