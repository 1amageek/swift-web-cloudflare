import { PageRequestCancellationError } from "./PageRequestCancellation.ts";

export type PageRequestCapacityReason =
  | "pendingRequests"
  | "reservedBytes";

export class PageRequestCapacityError extends Error {
  readonly reason: PageRequestCapacityReason;
  readonly limit: number;
  readonly pending: number;
  readonly requested: number;

  constructor(options: {
    reason: PageRequestCapacityReason;
    limit: number;
    pending: number;
    requested: number;
  }) {
    super(`Page request capacity is exhausted: ${options.reason}`);
    this.name = "PageRequestCapacityError";
    this.reason = options.reason;
    this.limit = options.limit;
    this.pending = options.pending;
    this.requested = options.requested;
  }
}

export class PageRequestAdmission {
  private pendingRequestCount = 0;
  private reservedByteCount = 0;

  constructor(
    private readonly maximumPendingRequests: number,
    private readonly maximumReservedBytes: number,
  ) {
    if (!Number.isInteger(maximumPendingRequests) || maximumPendingRequests <= 0) {
      throw new RangeError("Maximum pending Page requests is invalid");
    }
    if (!Number.isSafeInteger(maximumReservedBytes) || maximumReservedBytes <= 0) {
      throw new RangeError("Maximum reserved Page bytes is invalid");
    }
  }

  get pendingCount(): number {
    return this.pendingRequestCount;
  }

  get reservedBytes(): number {
    return this.reservedByteCount;
  }

  async perform<Result>(
    reservationByteCount: number,
    operation: () => Promise<Result>,
    cancellationSignal?: AbortSignal,
  ): Promise<Result> {
    this.reserve(reservationByteCount);
    try {
      if (cancellationSignal?.aborted) {
        throw new PageRequestCancellationError();
      }
      return await operation();
    } finally {
      this.pendingRequestCount -= 1;
      this.reservedByteCount -= reservationByteCount;
    }
  }

  private reserve(reservationByteCount: number): void {
    if (!Number.isSafeInteger(reservationByteCount) || reservationByteCount < 0) {
      throw new RangeError("Page request reservation is invalid");
    }
    if (this.pendingRequestCount >= this.maximumPendingRequests) {
      throw new PageRequestCapacityError({
        reason: "pendingRequests",
        limit: this.maximumPendingRequests,
        pending: this.pendingRequestCount,
        requested: 1,
      });
    }
    const nextReservedBytes = this.reservedByteCount + reservationByteCount;
    if (!Number.isSafeInteger(nextReservedBytes)
        || nextReservedBytes > this.maximumReservedBytes) {
      throw new PageRequestCapacityError({
        reason: "reservedBytes",
        limit: this.maximumReservedBytes,
        pending: this.reservedByteCount,
        requested: reservationByteCount,
      });
    }
    this.pendingRequestCount += 1;
    this.reservedByteCount = nextReservedBytes;
  }
}
