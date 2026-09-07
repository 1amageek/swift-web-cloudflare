export interface PageDeadlineScheduler {
  schedule(expire: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
}

export const pageDeadlineScheduler: PageDeadlineScheduler = {
  schedule: (expire, delayMilliseconds) => setTimeout(expire, delayMilliseconds),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PageCallCapacityError extends Error {
  readonly callKind: string;
  readonly maximumPendingCalls: number;

  constructor(callKind: string, maximumPendingCalls: number) {
    super(`Page ${callKind} capacity is exhausted`);
    this.name = "PageCallCapacityError";
    this.callKind = callKind;
    this.maximumPendingCalls = maximumPendingCalls;
  }
}

export class PageCallTimeoutError extends Error {
  readonly callKind: string;
  readonly timeoutMilliseconds: number;

  constructor(callKind: string, timeoutMilliseconds: number) {
    super(`Page ${callKind} exceeded its deadline`);
    this.name = "PageCallTimeoutError";
    this.callKind = callKind;
    this.timeoutMilliseconds = timeoutMilliseconds;
  }
}

export class PageDeadlineSchedulingError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Page call deadline could not be scheduled");
    this.name = "PageDeadlineSchedulingError";
    this.cause = cause;
  }
}

type PendingPageCall<Result> = {
  generationID: number;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  deadlineHandle: unknown | null;
};

export class PageCallRegistry<Identifier, Result> {
  private readonly pendingCalls = new Map<
    Identifier,
    PendingPageCall<Result>
  >();

  constructor(
    private readonly callKind: string,
    private readonly maximumPendingCalls: number,
    private readonly timeoutMilliseconds: number,
    private readonly deadlineScheduler: PageDeadlineScheduler,
    private readonly didExpire: (generationID: number, error: Error) => void,
    private readonly didReceiveUnknownCall: (identifier: Identifier) => void,
  ) {
    if (!Number.isInteger(maximumPendingCalls) || maximumPendingCalls <= 0) {
      throw new RangeError("Maximum pending Page calls is invalid");
    }
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      throw new RangeError("Page call timeout is invalid");
    }
  }

  get pendingCallCount(): number {
    return this.pendingCalls.size;
  }

  contains(identifier: Identifier): boolean {
    return this.pendingCalls.has(identifier);
  }

  pendingCallCountForGeneration(generationID: number): number {
    let count = 0;
    for (const call of this.pendingCalls.values()) {
      if (call.generationID === generationID) {
        count += 1;
      }
    }
    return count;
  }

  register(generationID: number, identifier: Identifier): Promise<Result> {
    if (this.pendingCalls.has(identifier)) {
      throw new Error(`Page ${this.callKind} identifier is already active`);
    }
    if (this.pendingCalls.size >= this.maximumPendingCalls) {
      throw new PageCallCapacityError(
        this.callKind,
        this.maximumPendingCalls,
      );
    }

    let resolveCall: (result: Result) => void = () => undefined;
    let rejectCall: (error: Error) => void = () => undefined;
    const result = new Promise<Result>((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    const call: PendingPageCall<Result> = {
      generationID,
      resolve: resolveCall,
      reject: rejectCall,
      deadlineHandle: null,
    };
    this.pendingCalls.set(identifier, call);

    let deadlineHandle: unknown;
    try {
      deadlineHandle = this.deadlineScheduler.schedule(() => {
        if (this.pendingCalls.get(identifier) !== call) {
          return;
        }
        const error = new PageCallTimeoutError(
          this.callKind,
          this.timeoutMilliseconds,
        );
        this.didExpire(generationID, error);
      }, this.timeoutMilliseconds);
    } catch (error) {
      this.pendingCalls.delete(identifier);
      throw new PageDeadlineSchedulingError(error);
    }

    if (this.pendingCalls.get(identifier) === call) {
      call.deadlineHandle = deadlineHandle;
    } else {
      this.cancelDeadline(deadlineHandle);
    }
    return result;
  }

  succeed(identifier: Identifier, result: Result): void {
    const call = this.take(identifier);
    if (call === null) {
      this.didReceiveUnknownCall(identifier);
      return;
    }
    call.resolve(result);
  }

  fail(identifier: Identifier, error: Error): void {
    const call = this.take(identifier);
    if (call === null) {
      this.didReceiveUnknownCall(identifier);
      return;
    }
    call.reject(error);
  }

  failGeneration(generationID: number, error: Error): void {
    const identifiers: Identifier[] = [];
    for (const [identifier, call] of this.pendingCalls) {
      if (call.generationID === generationID) {
        identifiers.push(identifier);
      }
    }
    for (const identifier of identifiers) {
      const call = this.take(identifier);
      call?.reject(error);
    }
  }

  private take(identifier: Identifier): PendingPageCall<Result> | null {
    const call = this.pendingCalls.get(identifier);
    if (call === undefined) {
      return null;
    }
    this.pendingCalls.delete(identifier);
    if (call.deadlineHandle !== null) {
      this.cancelDeadline(call.deadlineHandle);
    }
    return call;
  }

  private cancelDeadline(handle: unknown): void {
    try {
      this.deadlineScheduler.cancel(handle);
    } catch {
      // Settlement is authoritative. A stale deadline observes that its entry
      // is absent and cannot re-enter the runtime generation.
    }
  }
}
