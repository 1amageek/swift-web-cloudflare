export class RequestBodyTooLargeError extends Error {}

export async function readBoundedBytes(
  request: Request,
  maximumBytes: number
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("request body exceeds the configured limit");
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(
  request: Request,
  maximumBytes: number
): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, maximumBytes));
}

export function errorResponse(reason: string, status: number): Response {
  return Response.json(
    { error: true, reason },
    {
      status,
      headers: { "cache-control": "no-store" },
    }
  );
}

export function logError(message: string, error: unknown): void {
  console.error(
    JSON.stringify({
      message,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}
