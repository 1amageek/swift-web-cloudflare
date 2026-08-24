interface ActorRequestAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export function resolveActorRequestUnlessCancelled<Result>(
  startRemoteRequest: () => Promise<Result>,
  signal: unknown,
): Promise<Result> {
  throwIfActorRequestCancelled(signal);
  const abortSignal = actorRequestAbortSignal(signal);
  if (abortSignal === null) {
    return startRemoteRequest().then((result) => {
      throwIfActorRequestCancelled(signal);
      return result;
    });
  }

  return new Promise<Result>((resolve, reject) => {
    let isSettled = false;
    const settle = (completion: () => void): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      abortSignal.removeEventListener("abort", cancelRequest);
      completion();
    };
    const cancelRequest = (): void => {
      settle(() => reject(actorRequestCancellationError()));
    };

    abortSignal.addEventListener("abort", cancelRequest, { once: true });
    if (abortSignal.aborted) {
      cancelRequest();
      return;
    }
    let remoteResult: Promise<Result>;
    try {
      remoteResult = startRemoteRequest();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    remoteResult.then(
      (result) => settle(() => resolve(result)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function actorRequestAbortSignal(
  value: unknown,
): ActorRequestAbortSignal | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<ActorRequestAbortSignal>;
  return typeof candidate.aborted === "boolean"
      && typeof candidate.addEventListener === "function"
      && typeof candidate.removeEventListener === "function"
    ? candidate as ActorRequestAbortSignal
    : null;
}

function throwIfActorRequestCancelled(signal: unknown): void {
  if (typeof signal === "object"
      && signal !== null
      && "aborted" in signal
      && signal.aborted === true) {
    throw actorRequestCancellationError();
  }
}

function actorRequestCancellationError(): DOMException {
  return new DOMException("Actor request was cancelled", "AbortError");
}
