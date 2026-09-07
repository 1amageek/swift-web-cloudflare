export const PAGE_HEADER_FIELD_SEPARATOR = "\u001f";

export interface PageRequestEnvelope {
  method: string;
  path: string;
  search: string;
  scheme: string;
  host: string;
  encodedHeaders: string;
  encodedBody: string;
}

export interface PagePreparedRequest {
  request: Request;
  envelope: Omit<PageRequestEnvelope, "encodedBody">;
  declaredBodyByteCount: number | null;
  reservationByteCount: number;
}

export interface PageRenderResult {
  status: number;
  encodedHeaders: string;
  encodedBody: string;
}

export interface PageResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

export type PageWireErrorReason =
  | "invalidRequest"
  | "requestTooLarge"
  | "invalidResponse"
  | "responseTooLarge";

export class PageWireError extends Error {
  readonly reason: PageWireErrorReason;
  override readonly cause: unknown;

  constructor(
    reason: PageWireErrorReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "PageWireError";
    this.reason = reason;
    this.cause = cause;
  }
}

const maximumRequestBodyBytes = 4 * 1024 * 1024;
const maximumRequestBodyChunks = 1024;
const maximumRequestHeaderBytes = 128 * 1024;
const maximumRequestHeaderFields = 256;
const maximumResponseBodyBytes = 4 * 1024 * 1024;
const maximumResponseHeaderBytes = 256 * 1024;
const maximumResponseHeaderFields = 512;
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export async function encodePageRequest(
  request: Request,
): Promise<PageRequestEnvelope> {
  return encodePreparedPageRequest(preparePageRequest(request));
}

export function preparePageRequest(
  request: Request,
): PagePreparedRequest {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new PageWireError(
      "invalidRequest",
      "Page request URL is invalid",
      error,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageWireError(
      "invalidRequest",
      "Page request scheme is invalid",
    );
  }
  validateRequestText(request.method, 32, "method");
  validateRequestText(url.pathname, 32 * 1024, "path");
  validateRequestText(url.search, 32 * 1024, "search");
  validateRequestText(url.host, 1024, "host");
  const encodedHeaders = encodeRequestHeaders(request.headers);
  const declaredBodyByteCount = declaredRequestBodyByteCount(request);
  const maximumBodyByteCount = hasRequestBody(request)
    ? declaredBodyByteCount ?? maximumRequestBodyBytes
    : 0;
  const encodedBodyByteCount = Math.ceil(maximumBodyByteCount / 3) * 4;
  const envelopeTextByteCount = utf8ByteCount(request.method)
    + utf8ByteCount(url.pathname)
    + utf8ByteCount(url.search)
    + utf8ByteCount(url.protocol)
    + utf8ByteCount(url.host)
    + utf8ByteCount(encodedHeaders);
  return {
    request,
    envelope: {
      method: request.method,
      path: url.pathname,
      search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
      scheme: url.protocol.replace(":", ""),
      host: url.host,
      encodedHeaders,
    },
    declaredBodyByteCount,
    // The stream may retain raw chunks while the ABI string exists. Count
    // UTF-16 conservatively so admission remains safe across V8 string forms.
    reservationByteCount: maximumBodyByteCount
      + encodedBodyByteCount * 2
      + envelopeTextByteCount * 2,
  };
}

export async function encodePreparedPageRequest(
  preparedRequest: PagePreparedRequest,
): Promise<PageRequestEnvelope> {
  return {
    ...preparedRequest.envelope,
    encodedBody: await encodeRequestBody(
      preparedRequest.request,
      preparedRequest.declaredBodyByteCount,
    ),
  };
}

export function decodePageResponse(
  result: PageRenderResult,
): PageResponse {
  if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
    throw new PageWireError(
      "invalidResponse",
      "Page response status is invalid",
    );
  }
  if (utf8ByteCount(result.encodedHeaders) > maximumResponseHeaderBytes) {
    throw new PageWireError(
      "responseTooLarge",
      "Page response headers exceed the limit",
    );
  }

  const headers: [string, string][] = [];
  if (result.encodedHeaders.length > 0) {
    const fields = result.encodedHeaders.split(
      PAGE_HEADER_FIELD_SEPARATOR,
    );
    if (fields.length % 2 !== 0) {
      throw new PageWireError(
        "invalidResponse",
        "Page response headers are incomplete",
      );
    }
    if (fields.length > maximumResponseHeaderFields) {
      throw new PageWireError(
        "responseTooLarge",
        "Page response has too many headers",
      );
    }
    for (let index = 0; index < fields.length; index += 2) {
      const name = fields[index];
      const value = fields[index + 1];
      if (name === undefined || !httpFieldNamePattern.test(name)) {
        throw new PageWireError(
          "invalidResponse",
          "Page response header name is invalid",
        );
      }
      if (value === undefined || containsInvalidHeaderValue(value)) {
        throw new PageWireError(
          "invalidResponse",
          "Page response header value is invalid",
        );
      }
      headers.push([name, value]);
    }
  }

  return {
    status: result.status,
    headers,
    body: decodeBoundedBase64(result.encodedBody, maximumResponseBodyBytes),
  };
}

function encodeRequestHeaders(headers: Headers): string {
  const fields: string[] = [];
  let byteCount = 0;
  headers.forEach((value, name) => {
    if (!httpFieldNamePattern.test(name) || containsInvalidHeaderValue(value)) {
      throw new PageWireError(
        "invalidRequest",
        "Page request header is invalid",
      );
    }
    fields.push(name, value);
    byteCount += utf8ByteCount(name) + utf8ByteCount(value);
  });
  if (fields.length > maximumRequestHeaderFields) {
    throw new PageWireError(
      "requestTooLarge",
      "Page request has too many headers",
    );
  }
  byteCount += Math.max(0, fields.length - 1);
  if (byteCount > maximumRequestHeaderBytes) {
    throw new PageWireError(
      "requestTooLarge",
      "Page request headers exceed the limit",
    );
  }
  return fields.join(PAGE_HEADER_FIELD_SEPARATOR);
}

async function encodeRequestBody(
  request: Request,
  declaredByteCount: number | null,
): Promise<string> {
  const requestBody = request.body;
  if (!hasRequestBody(request) || requestBody === null) {
    return "";
  }

  const reader = requestBody.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let retainedByteCount = 0;
  const retainedBuffers = new Set<ArrayBuffer>();
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      const chunk = read.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new PageWireError(
          "invalidRequest",
          "Page request body chunk is invalid",
        );
      }
      if (!(chunk.buffer instanceof ArrayBuffer)) {
        throw new PageWireError(
          "invalidRequest",
          "Page request body storage is unsupported",
        );
      }
      if (chunks.length >= maximumRequestBodyChunks) {
        throw new PageWireError(
          "requestTooLarge",
          "Page request body has too many chunks",
        );
      }
      byteCount += chunk.byteLength;
      const bodyByteLimit = declaredByteCount ?? maximumRequestBodyBytes;
      if (!Number.isSafeInteger(byteCount) || byteCount > bodyByteLimit) {
        throw new PageWireError(
          "requestTooLarge",
          "Page request body exceeds the limit",
        );
      }
      if (!retainedBuffers.has(chunk.buffer)) {
        retainedBuffers.add(chunk.buffer);
        retainedByteCount += chunk.buffer.byteLength;
        if (!Number.isSafeInteger(retainedByteCount)
            || retainedByteCount > maximumRequestBodyBytes) {
          throw new PageWireError(
            "requestTooLarge",
            "Page request body storage exceeds the limit",
          );
        }
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The original body failure remains authoritative.
    }
    if (error instanceof PageWireError) {
      throw error;
    }
    throw new PageWireError(
      "invalidRequest",
      "Page request body could not be read",
      error,
    );
  } finally {
    reader.releaseLock();
  }

  if (declaredByteCount !== null && byteCount !== declaredByteCount) {
    throw new PageWireError(
      "invalidRequest",
      "Page request length does not match its body",
    );
  }

  if (chunks.length === 0) {
    return "";
  }
  if (chunks.length === 1) {
    return encodeBytesAsBase64(chunks[0]!);
  }
  return encodeByteChunksAsBase64(chunks);
}

function declaredRequestBodyByteCount(request: Request): number | null {
  if (!hasRequestBody(request)) {
    return 0;
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength === null) {
    return null;
  }
  if (!/^\d+$/.test(declaredLength)) {
    throw new PageWireError(
      "invalidRequest",
      "Page request length is invalid",
    );
  }
  const byteCount = Number(declaredLength);
  if (!Number.isSafeInteger(byteCount)) {
    throw new PageWireError(
      "invalidRequest",
      "Page request length is invalid",
    );
  }
  if (byteCount > maximumRequestBodyBytes) {
    throw new PageWireError(
      "requestTooLarge",
      "Page request body exceeds the limit",
    );
  }
  return byteCount;
}

function hasRequestBody(request: Request): boolean {
  return request.method !== "GET"
    && request.method !== "HEAD"
    && request.body !== null;
}

function validateRequestText(value: string, maximumBytes: number, field: string): void {
  if (utf8ByteCount(value) > maximumBytes) {
    throw new PageWireError(
      "requestTooLarge",
      `Page request ${field} exceeds the limit`,
    );
  }
}

function encodeBytesAsBase64(bytes: Uint8Array): string {
  let text = "";
  // Keep each variadic conversion bounded; btoa still receives one logical
  // byte string for this view.
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(text);
}

function encodeByteChunksAsBase64(chunks: readonly Uint8Array[]): string {
  const encodedSegments: string[] = [];
  const carry: number[] = [];

  for (const chunk of chunks) {
    let offset = 0;
    while (carry.length < 3 && offset < chunk.byteLength) {
      carry.push(chunk[offset]!);
      offset += 1;
    }
    if (carry.length === 3) {
      encodedSegments.push(btoa(String.fromCharCode(...carry)));
      carry.length = 0;
    }

    const remainingByteCount = chunk.byteLength - offset;
    const completeByteCount = remainingByteCount - (remainingByteCount % 3);
    if (completeByteCount > 0) {
      encodedSegments.push(
        encodeBytesAsBase64(chunk.subarray(offset, offset + completeByteCount)),
      );
      offset += completeByteCount;
    }
    while (offset < chunk.byteLength) {
      carry.push(chunk[offset]!);
      offset += 1;
    }
  }

  if (carry.length > 0) {
    encodedSegments.push(btoa(String.fromCharCode(...carry)));
  }
  return encodedSegments.join("");
}

function decodeBoundedBase64(encoded: string, maximumBytes: number): Uint8Array {
  if (encoded.length === 0) {
    return new Uint8Array();
  }
  const maximumEncodedBytes = Math.ceil(maximumBytes / 3) * 4;
  if (encoded.length > maximumEncodedBytes) {
    throw new PageWireError(
      "responseTooLarge",
      "Page response body exceeds the limit",
    );
  }
  if (encoded.length % 4 !== 0 || !base64Pattern.test(encoded)) {
    throw new PageWireError(
      "invalidResponse",
      "Page response body is not canonical base64",
    );
  }
  const paddingByteCount = encoded.endsWith("==")
    ? 2
    : encoded.endsWith("=")
      ? 1
      : 0;
  const decodedByteCount = (encoded.length / 4) * 3 - paddingByteCount;
  if (decodedByteCount > maximumBytes) {
    throw new PageWireError(
      "responseTooLarge",
      "Page response body exceeds the limit",
    );
  }
  const decoded = atob(encoded);
  if (decoded.length !== decodedByteCount) {
    throw new PageWireError(
      "invalidResponse",
      "Page response body length is invalid",
    );
  }
  const bytes = new Uint8Array(decodedByteCount);
  for (let index = 0; index < decodedByteCount; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function containsInvalidHeaderValue(value: string): boolean {
  return value.includes("\r")
    || value.includes("\n")
    || value.includes("\0")
    || value.includes(PAGE_HEADER_FIELD_SEPARATOR);
}

function utf8ByteCount(value: string): number {
  let byteCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    if (codePoint <= 0x7f) {
      byteCount += 1;
    } else if (codePoint <= 0x7ff) {
      byteCount += 2;
    } else if (codePoint <= 0xffff) {
      byteCount += 3;
    } else {
      byteCount += 4;
      index += 1;
    }
  }
  return byteCount;
}
