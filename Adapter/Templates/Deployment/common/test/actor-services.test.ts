import assert from "node:assert/strict";
import test from "node:test";
import {
  createSwiftWebActorRequestHandler,
  type ActorServiceBinding,
} from "../src/actor-services.ts";

const databaseBinding: ActorServiceBinding = {
  service: "database",
  product: "DatabaseContract",
  module: "DatabaseContract",
  type: "DatabaseActor",
  hostRoute: {
    transport: "swiftweb.http",
    endpointPrefix: "cloudflare-do://database/",
    endpointSuffix: "?scope=primary",
  },
  clientRoute: null,
  configuration: {
    bindingName: "DATABASE_SERVICE",
    className: "DatabaseService",
    scriptName: "database-worker",
  },
};

test("routes a frame to the Durable Object selected by logical identity", async () => {
  let selectedIdentity: string | undefined;
  let receivedFrame: Uint8Array | undefined;
  let receivedContext:
    | { peerID: string; hostedActorIdentity: string }
    | undefined;
  const handler = createSwiftWebActorRequestHandler(
    {
      DATABASE_SERVICE: {
        getByName(identity: string) {
          selectedIdentity = identity;
          return {
            async invokeActorFrame(
              frame: Uint8Array,
              context: { peerID: string; hostedActorIdentity: string },
            ): Promise<Uint8Array> {
              receivedFrame = frame;
              receivedContext = context;
              return new Uint8Array([9, 8, 7]);
            },
          };
        },
      },
    },
    [databaseBinding],
  );

  const response = await handler(
    "cloudflare-do://database/tenant%20A%2Fcalendar?scope=primary",
    new Uint8Array([1, 2, 3]),
    { aborted: false },
    "page-runtime",
  );

  assert.equal(selectedIdentity, "tenant A/calendar");
  assert.deepEqual(receivedFrame, new Uint8Array([1, 2, 3]));
  assert.deepEqual(receivedContext, {
    peerID: "page-runtime",
    hostedActorIdentity: "tenant A/calendar",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.swift-actor-frame");
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    new Uint8Array([9, 8, 7]),
  );
});

test("represents a one-way actor frame as an empty response", async () => {
  const handler = createSwiftWebActorRequestHandler(
    {
      DATABASE_SERVICE: {
        getByName() {
          return {
            async invokeActorFrame(): Promise<null> {
              return null;
            },
          };
        },
      },
    },
    [databaseBinding],
  );

  const response = await handler(
    "cloudflare-do://database/database?scope=primary",
    new Uint8Array([1]),
    { aborted: false },
    "page-runtime",
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("content-type"), null);
});

test("rejects an endpoint that has ambiguous deployment ownership", async () => {
  const handler = createSwiftWebActorRequestHandler(
    {},
    [databaseBinding, databaseBinding],
  );

  await assert.rejects(
    handler(
      "cloudflare-do://database/database?scope=primary",
      new Uint8Array([1]),
      { aborted: false },
      "page-runtime",
    ),
    /ambiguous deployment bindings/,
  );
});

test("does not dispatch a request that was already cancelled", async () => {
  let dispatched = false;
  const handler = createSwiftWebActorRequestHandler(
    {
      DATABASE_SERVICE: {
        getByName() {
          dispatched = true;
          throw new Error("The request must not reach this binding");
        },
      },
    },
    [databaseBinding],
  );

  await assert.rejects(
    handler(
      "cloudflare-do://database/database?scope=primary",
      new Uint8Array([1]),
      { aborted: true },
      "page-runtime",
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(dispatched, false);
});

test("does not return a reply after cancellation wins the race", async () => {
  const signal = { aborted: false };
  const handler = createSwiftWebActorRequestHandler(
    {
      DATABASE_SERVICE: {
        getByName() {
          return {
            async invokeActorFrame(): Promise<Uint8Array> {
              signal.aborted = true;
              return new Uint8Array([1]);
            },
          };
        },
      },
    },
    [databaseBinding],
  );

  await assert.rejects(
    handler(
      "cloudflare-do://database/database?scope=primary",
      new Uint8Array([1]),
      signal,
      "page-runtime",
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("settles promptly when an in-flight Durable Object RPC does not settle", async () => {
  const controller = new AbortController();
  const handler = createSwiftWebActorRequestHandler(
    {
      DATABASE_SERVICE: {
        getByName() {
          return {
            invokeActorFrame(): Promise<Uint8Array> {
              return new Promise(() => undefined);
            },
          };
        },
      },
    },
    [databaseBinding],
  );

  const request = handler(
    "cloudflare-do://database/database?scope=primary",
    new Uint8Array([1]),
    controller.signal,
    "page-runtime",
  );
  controller.abort();

  await assert.rejects(
    completesWithin(request, 100),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("observes a remote rejection after local cancellation", async () => {
  const controller = new AbortController();
  let rejectRemoteRequest: ((error: Error) => void) | undefined;
  const handler = createSwiftWebActorRequestHandler(
    {
      DATABASE_SERVICE: {
        getByName() {
          return {
            invokeActorFrame(): Promise<Uint8Array> {
              return new Promise((_resolve, reject) => {
                rejectRemoteRequest = reject;
              });
            },
          };
        },
      },
    },
    [databaseBinding],
  );

  const request = handler(
    "cloudflare-do://database/database?scope=primary",
    new Uint8Array([1]),
    controller.signal,
    "page-runtime",
  );
  controller.abort();
  await assert.rejects(
    completesWithin(request, 100),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );

  assert.notEqual(rejectRemoteRequest, undefined);
  rejectRemoteRequest?.(new Error("Remote request completed after cancellation"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

async function completesWithin<Result>(
  operation: Promise<Result>,
  timeoutMilliseconds: number,
): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Actor request did not settle after cancellation")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
