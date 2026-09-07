import assert from "node:assert/strict";
import test from "node:test";
import {
  PageWireError,
  decodePageResponse,
  encodePageRequest,
  preparePageRequest,
} from "../src/PageWire.ts";

test("Page wire validates and decodes a response", () => {
  const response = decodePageResponse({
    status: 200,
    encodedHeaders: "content-type\u001ftext/plain",
    encodedBody: "SGVsbG8=",
  });
  assert.deepEqual(response.headers, [["content-type", "text/plain"]]);
  assert.equal(new TextDecoder().decode(response.body), "Hello");
});

test("Page wire rejects malformed response fields", () => {
  assert.throws(
    () => decodePageResponse({
      status: 99,
      encodedHeaders: "",
      encodedBody: "",
    }),
    PageWireError,
  );
  assert.throws(
    () => decodePageResponse({
      status: 200,
      encodedHeaders: "orphan",
      encodedBody: "",
    }),
    /headers are incomplete/,
  );
  assert.throws(
    () => decodePageResponse({
      status: 200,
      encodedHeaders: "",
      encodedBody: "not-base64",
    }),
    /canonical base64/,
  );
});

test("Page request body is bounded before reading", async () => {
  let readerCount = 0;
  const request = {
    url: "https://calendar.test/import",
    method: "POST",
    headers: new Headers({
      "Content-Length": String(4 * 1024 * 1024 + 1),
    }),
    body: {
      getReader() {
        readerCount += 1;
        throw new Error("Request body must not be read");
      },
    },
  } as unknown as Request;

  await assert.rejects(encodePageRequest(request), /body exceeds the limit/);
  assert.equal(readerCount, 0);
});

test("Page request encodes bounded chunks without body consolidation", async () => {
  const request = new Request("https://calendar.test/import?dry-run=1", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0x41]));
        controller.enqueue(new Uint8Array([0x42, 0x43]));
        controller.enqueue(new Uint8Array([0x44, 0x45]));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const encoded = await encodePageRequest(request);
  assert.equal(encoded.search, "dry-run=1");
  assert.equal(encoded.encodedBody, "QUJDREU=");
});

test("Page request base64 remains canonical across encoder segments", async () => {
  const body = new Uint8Array(40_001);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = index % 251;
  }
  const request = new Request("https://calendar.test/import", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const encoded = await encodePageRequest(request);
  const decoded = Uint8Array.from(
    atob(encoded.encodedBody),
    (character) => character.charCodeAt(0),
  );
  assert.deepEqual(decoded, body);
});

test("Page request headers enforce UTF-8 byte limits", async () => {
  const request = new Request("https://calendar.test/", {
    headers: { "x-large": "é".repeat(70_000) },
  });
  await assert.rejects(
    encodePageRequest(request),
    (error: unknown) => error instanceof PageWireError
      && error.reason === "requestTooLarge",
  );
});

test("Page preparation reserves raw and encoded body memory", () => {
  const prepared = preparePageRequest(
    new Request("https://calendar.test/import", {
      method: "POST",
      headers: { "Content-Length": "3" },
      body: new Uint8Array([1, 2, 3]),
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  assert.ok(prepared.reservationByteCount >= 11);
  assert.equal(prepared.declaredBodyByteCount, 3);
});

test("Page request rejects a mismatched declared body length", async () => {
  const request = new Request("https://calendar.test/import", {
    method: "POST",
    headers: { "Content-Length": "2" },
    body: new Uint8Array([1]),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    encodePageRequest(request),
    (error: unknown) => error instanceof PageWireError
      && error.reason === "invalidRequest",
  );
});

test("Page request bounds backing storage retained by body views", async () => {
  const backing = new Uint8Array(4 * 1024 * 1024 + 1);
  const request = new Request("https://calendar.test/import", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(backing.subarray(0, 1));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    encodePageRequest(request),
    (error: unknown) => error instanceof PageWireError
      && error.reason === "requestTooLarge",
  );
});

test("Page response rejects oversized base64 before decoding", () => {
  const maximumEncodedLength = Math.ceil((4 * 1024 * 1024) / 3) * 4;
  assert.throws(
    () => decodePageResponse({
      status: 200,
      encodedHeaders: "",
      encodedBody: "A".repeat(maximumEncodedLength + 4),
    }),
    (error: unknown) => error instanceof PageWireError
      && error.reason === "responseTooLarge",
  );
});
