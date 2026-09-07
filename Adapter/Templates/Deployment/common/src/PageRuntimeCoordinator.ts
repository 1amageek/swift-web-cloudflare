import {
  PageCallCapacityError,
  PageCallRegistry,
  PageCallTimeoutError,
  type PageDeadlineScheduler,
  pageDeadlineScheduler,
} from "./PageCallRegistry.ts";
import {
  type PageRequestEnvelope,
  type PageResponse,
  PageWireError,
  decodePageResponse,
} from "./PageWire.ts";
import { PageRequestCancellationError } from "./PageRequestCancellation.ts";

export interface PageRuntimeAdapter<Runtime, Environment> {
  instantiate(environment: Environment): Promise<Runtime>;
  start(runtime: Runtime, startID: number): void;
  render(
    runtime: Runtime,
    renderID: string,
    request: PageRequestEnvelope,
  ): void;
  memoryByteCount(runtime: Runtime): number;
  release(runtime: Runtime): void;
}

export interface PageRuntimeCoordinatorOptions {
  maximumPendingStarts?: number;
  maximumPendingRenders?: number;
  startTimeoutMilliseconds?: number;
  renderTimeoutMilliseconds?: number;
  retirementThresholdBytes?: number;
  deadlineScheduler?: PageDeadlineScheduler;
  reportProtocolViolation?: (error: Error) => void;
}

export class PageProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageProtocolError";
  }
}

export class PageStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageStartError";
  }
}

export class PageRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageRenderError";
  }
}

export class PageRuntimeUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "PageRuntimeUnavailableError";
    this.cause = cause;
  }
}

type PageRuntimeGenerationState =
  | "starting"
  | "ready"
  | "retiring"
  | "terminal";

type PageRuntimeGeneration<Runtime> = {
  id: number;
  state: PageRuntimeGenerationState;
  runtime: Runtime | null;
  nextRenderSequence: number;
};

type ActivePageRuntime<Runtime> = {
  generation: PageRuntimeGeneration<Runtime>;
  readiness: Promise<PageRuntimeGeneration<Runtime>>;
};

const maximumGenerationID = 0x7fff_ffff;
const maximumRenderSequence = Number.MAX_SAFE_INTEGER;
const maximumFailureMessageBytes = 4096;

export class PageRuntimeCoordinator<Runtime, Environment> {
  private readonly generations = new Map<
    number,
    PageRuntimeGeneration<Runtime>
  >();
  private readonly startCalls: PageCallRegistry<number, void>;
  private readonly renderCalls: PageCallRegistry<
    string,
    PageResponse
  >;
  private readonly retirementThresholdBytes: number;
  private readonly reportProtocolViolation: (error: Error) => void;

  private nextGenerationID = 1;
  private activeRuntime: ActivePageRuntime<Runtime> | null = null;

  constructor(
    private readonly adapter: PageRuntimeAdapter<Runtime, Environment>,
    options: PageRuntimeCoordinatorOptions = {},
  ) {
    const deadlineScheduler = options.deadlineScheduler
      ?? pageDeadlineScheduler;
    this.retirementThresholdBytes = options.retirementThresholdBytes
      ?? 48 * 1024 * 1024;
    if (!Number.isSafeInteger(this.retirementThresholdBytes)
        || this.retirementThresholdBytes <= 0) {
      throw new RangeError("Page runtime retirement threshold is invalid");
    }
    this.reportProtocolViolation = options.reportProtocolViolation
      ?? ((error) => console.error("Page protocol violation", error));
    this.startCalls = new PageCallRegistry(
      "start",
      options.maximumPendingStarts ?? 4,
      options.startTimeoutMilliseconds ?? 10_000,
      deadlineScheduler,
      (generationID, error) => this.terminateGenerationByID(generationID, error),
      (startID) => this.receiveUnknownStart(startID),
    );
    this.renderCalls = new PageCallRegistry(
      "render",
      options.maximumPendingRenders ?? 64,
      options.renderTimeoutMilliseconds ?? 30_000,
      deadlineScheduler,
      (generationID, error) => this.terminateGenerationByID(generationID, error),
      (renderID) => this.receiveUnknownRender(renderID),
    );
  }

  get pendingStartCount(): number {
    return this.startCalls.pendingCallCount;
  }

  get pendingRenderCount(): number {
    return this.renderCalls.pendingCallCount;
  }

  async render(
    environment: Environment,
    request: PageRequestEnvelope,
    cancellationSignal?: AbortSignal,
  ): Promise<PageResponse> {
    const cancellationError = new PageRequestCancellationError();
    let cancellationGeneration:
      PageRuntimeGeneration<Runtime> | null = null;
    const cancel = () => {
      if (cancellationGeneration !== null) {
        this.terminateGeneration(cancellationGeneration, cancellationError);
      }
    };
    if (cancellationSignal?.aborted) {
      throw cancellationError;
    }
    cancellationSignal?.addEventListener("abort", cancel, { once: true });

    try {
      let generationReadiness = this.loadActiveGeneration(environment);
      cancellationGeneration = this.activeRuntime?.generation ?? null;
      let generation = await generationReadiness;
      if (generation.state !== "ready"
          || this.adapter.memoryByteCount(this.requireRuntime(generation))
            >= this.retirementThresholdBytes) {
        this.retireGeneration(generation);
        generationReadiness = this.loadActiveGeneration(environment);
        cancellationGeneration = this.activeRuntime?.generation ?? null;
        generation = await generationReadiness;
      }

      if (cancellationSignal?.aborted) {
        cancel();
        throw cancellationError;
      }

      const renderID = this.reserveRenderID(generation);
      let response: Promise<PageResponse>;
      try {
        response = this.renderCalls.register(generation.id, renderID);
      } catch (error) {
        if (error instanceof PageCallCapacityError) {
          throw error;
        }
        const terminalError = asError(error);
        this.terminateGeneration(generation, terminalError);
        throw terminalError;
      }

      try {
        this.adapter.render(this.requireRuntime(generation), renderID, request);
      } catch (error) {
        const dispatchError = new PageRuntimeUnavailableError(
          "Page runtime failed while rendering",
          error,
        );
        this.terminateGeneration(generation, dispatchError);
        await response.then(
          () => undefined,
          () => undefined,
        );
        throw dispatchError;
      }

      try {
        return await response;
      } finally {
        this.releaseInactiveGenerationIfIdle(generation);
      }
    } finally {
      cancellationSignal?.removeEventListener("abort", cancel);
    }
  }

  didStart(startID: unknown): void {
    const generationID = parseStartID(startID);
    if (generationID === null) {
      this.receiveUnattributedViolation("Page start ID is invalid");
      return;
    }
    this.startCalls.succeed(generationID, undefined);
    this.releaseInactiveGenerationByIDIfIdle(generationID);
  }

  didFailToStart(startID: unknown, message: unknown): void {
    const generationID = parseStartID(startID);
    if (generationID === null) {
      this.receiveUnattributedViolation("Page failed-start ID is invalid");
      return;
    }
    const failureMessage = parseFailureMessage(message);
    if (failureMessage === null) {
      this.receiveGenerationViolation(
        generationID,
        new PageProtocolError("Page start failure is invalid"),
      );
      return;
    }
    this.startCalls.fail(generationID, new PageStartError(failureMessage));
    this.releaseInactiveGenerationByIDIfIdle(generationID);
  }

  didRenderPage(
    renderID: unknown,
    status: unknown,
    encodedHeaders: unknown,
    encodedBody: unknown,
  ): void {
    const parsedRenderID = parseRenderID(renderID);
    if (parsedRenderID === null) {
      this.receiveUnattributedViolation("Page render ID is invalid");
      return;
    }
    if (!this.renderCalls.contains(parsedRenderID.identifier)) {
      this.receiveUnknownRender(parsedRenderID.identifier);
      return;
    }
    if (typeof status !== "number"
        || typeof encodedHeaders !== "string"
        || typeof encodedBody !== "string") {
      this.receiveGenerationViolation(
        parsedRenderID.generationID,
        new PageProtocolError("Page render payload types are invalid"),
      );
      return;
    }

    let response: PageResponse;
    try {
      response = decodePageResponse({ status, encodedHeaders, encodedBody });
    } catch (error) {
      const protocolError = error instanceof PageWireError
        ? error
        : new PageProtocolError("Page response decoding failed");
      this.receiveGenerationViolation(parsedRenderID.generationID, protocolError);
      return;
    }
    this.renderCalls.succeed(parsedRenderID.identifier, response);
    this.releaseInactiveGenerationByIDIfIdle(parsedRenderID.generationID);
  }

  didFailToRenderPage(renderID: unknown, message: unknown): void {
    const parsedRenderID = parseRenderID(renderID);
    if (parsedRenderID === null) {
      this.receiveUnattributedViolation("Page failed-render ID is invalid");
      return;
    }
    if (!this.renderCalls.contains(parsedRenderID.identifier)) {
      this.receiveUnknownRender(parsedRenderID.identifier);
      return;
    }
    const failureMessage = parseFailureMessage(message);
    if (failureMessage === null) {
      this.receiveGenerationViolation(
        parsedRenderID.generationID,
        new PageProtocolError("Page render failure is invalid"),
      );
      return;
    }
    this.renderCalls.fail(
      parsedRenderID.identifier,
      new PageRenderError(failureMessage),
    );
    this.releaseInactiveGenerationByIDIfIdle(parsedRenderID.generationID);
  }

  private loadActiveGeneration(
    environment: Environment,
  ): Promise<PageRuntimeGeneration<Runtime>> {
    if (this.activeRuntime !== null) {
      return this.activeRuntime.readiness;
    }

    const generation: PageRuntimeGeneration<Runtime> = {
      id: this.reserveGenerationID(),
      state: "starting",
      runtime: null,
      nextRenderSequence: 1,
    };
    this.generations.set(generation.id, generation);
    const readiness = this.prepareGeneration(generation, environment);
    const activeRuntime = { generation, readiness };
    this.activeRuntime = activeRuntime;
    void readiness.catch(() => {
      if (this.activeRuntime === activeRuntime) {
        this.activeRuntime = null;
      }
      this.releaseInactiveGenerationIfIdle(generation);
    });
    return readiness;
  }

  private async prepareGeneration(
    generation: PageRuntimeGeneration<Runtime>,
    environment: Environment,
  ): Promise<PageRuntimeGeneration<Runtime>> {
    try {
      let readiness: Promise<void>;
      try {
        readiness = this.startCalls.register(generation.id, generation.id);
      } catch (error) {
        throw asError(error);
      }
      let instantiation: Promise<Runtime>;
      try {
        instantiation = this.adapter.instantiate(environment).then((runtime) => {
          if (generation.state === "terminal") {
            this.adapter.release(runtime);
            throw new PageProtocolError("Page runtime became available after retirement");
          }
          return runtime;
        });
      } catch (error) {
        throw new PageRuntimeUnavailableError(
          "Page runtime could not be instantiated",
          error,
        );
      }
      try {
        generation.runtime = await Promise.race([
          instantiation,
          readiness.then<Runtime>(() => {
            throw new PageProtocolError(
              "Page runtime completed startup before instantiation",
            );
          }),
        ]);
        if (generation.state === "terminal") {
          this.releaseInactiveGenerationIfIdle(generation);
          await readiness;
          throw new PageProtocolError("Page runtime retired before startup dispatch");
        }
      } catch (error) {
        if (error instanceof PageCallTimeoutError
            || error instanceof PageRequestCancellationError
            || error instanceof PageProtocolError) {
          throw error;
        }
        throw new PageRuntimeUnavailableError(
          "Page runtime could not be instantiated",
          error,
        );
      }
      let dispatchError: PageRuntimeUnavailableError | null = null;
      try {
        this.adapter.start(generation.runtime, generation.id);
      } catch (error) {
        dispatchError = new PageRuntimeUnavailableError(
          "Page runtime failed while starting",
          error,
        );
        this.terminateGeneration(generation, dispatchError);
      }
      if (dispatchError !== null) {
        await readiness.then(
          () => undefined,
          () => undefined,
        );
        throw dispatchError;
      }
      await readiness;
      // Terminal settlement releases the runtime, including during this await.
      this.requireRuntime(generation);
      generation.state = "ready";
      return generation;
    } catch (error) {
      const terminalError = asError(error);
      this.terminateGeneration(generation, terminalError);
      throw terminalError;
    }
  }

  private retireGeneration(generation: PageRuntimeGeneration<Runtime>): void {
    if (generation.state === "ready") {
      generation.state = "retiring";
    }
    if (this.activeRuntime?.generation === generation) {
      this.activeRuntime = null;
    }
    this.releaseInactiveGenerationIfIdle(generation);
  }

  private terminateGenerationByID(generationID: number, error: Error): void {
    const generation = this.generations.get(generationID);
    if (generation === undefined) {
      return;
    }
    this.terminateGeneration(generation, error);
  }

  private receiveGenerationViolation(generationID: number, error: Error): void {
    this.reportViolation(error);
    this.terminateGenerationByID(generationID, error);
  }

  private terminateGeneration(
    generation: PageRuntimeGeneration<Runtime>,
    error: Error,
  ): void {
    if (generation.state === "terminal") {
      return;
    }
    generation.state = "terminal";
    if (this.activeRuntime?.generation === generation) {
      this.activeRuntime = null;
    }
    this.startCalls.failGeneration(generation.id, error);
    this.renderCalls.failGeneration(generation.id, error);
    this.releaseInactiveGenerationIfIdle(generation);
  }

  private receiveUnknownStart(startID: number): void {
    this.terminateUnknownCallGeneration(
      startID,
      `Page start callback ${startID} is unknown`,
    );
  }

  private receiveUnknownRender(renderID: string): void {
    const parsed = parseRenderID(renderID);
    if (parsed === null) {
      this.receiveUnattributedViolation("Page render callback ID is invalid");
      return;
    }
    this.terminateUnknownCallGeneration(
      parsed.generationID,
      `Page render callback ${renderID} is unknown`,
    );
  }

  private terminateUnknownCallGeneration(
    generationID: number,
    message: string,
  ): void {
    const error = new PageProtocolError(message);
    const generation = this.generations.get(generationID);
    if (generation === undefined) {
      this.reportViolation(error);
      return;
    }
    this.reportViolation(error);
    this.terminateGeneration(generation, error);
  }

  private receiveUnattributedViolation(message: string): void {
    const error = new PageProtocolError(message);
    this.reportViolation(error);
  }

  private reportViolation(error: Error): void {
    try {
      this.reportProtocolViolation(error);
    } catch {
      // Observation must not change runtime ownership or settlement.
    }
  }

  private reserveGenerationID(): number {
    for (let attempt = 0; attempt <= this.generations.size; attempt += 1) {
      const candidate = this.nextGenerationID;
      this.nextGenerationID = candidate === maximumGenerationID
        ? 1
        : candidate + 1;
      if (!this.generations.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Page runtime generation space is exhausted");
  }

  private reserveRenderID(
    generation: PageRuntimeGeneration<Runtime>,
  ): string {
    for (let attempt = 0; attempt <= this.renderCalls.pendingCallCount; attempt += 1) {
      const sequence = generation.nextRenderSequence;
      generation.nextRenderSequence = sequence === maximumRenderSequence
        ? 1
        : sequence + 1;
      const identifier = `g${generation.id}-r${sequence}`;
      if (!this.renderCalls.contains(identifier)) {
        return identifier;
      }
    }
    throw new Error("Page render identifier space is exhausted");
  }

  private requireRuntime(
    generation: PageRuntimeGeneration<Runtime>,
  ): Runtime {
    if (generation.runtime === null) {
      throw new Error("Page runtime instance is unavailable");
    }
    return generation.runtime;
  }

  private releaseInactiveGenerationByIDIfIdle(generationID: number): void {
    const generation = this.generations.get(generationID);
    if (generation !== undefined) {
      this.releaseInactiveGenerationIfIdle(generation);
    }
  }

  private releaseInactiveGenerationIfIdle(
    generation: PageRuntimeGeneration<Runtime>,
  ): void {
    if (generation.state === "starting" || generation.state === "ready") {
      return;
    }
    if (this.startCalls.pendingCallCountForGeneration(generation.id) !== 0
        || this.renderCalls.pendingCallCountForGeneration(generation.id) !== 0) {
      return;
    }
    this.generations.delete(generation.id);
    const runtime = generation.runtime;
    generation.runtime = null;
    if (runtime !== null) this.adapter.release(runtime);
  }
}

function parseStartID(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value <= maximumGenerationID
    ? value
    : null;
}

function parseRenderID(value: unknown): {
  identifier: string;
  generationID: number;
} | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match = /^g([1-9][0-9]*)-r([1-9][0-9]*)$/.exec(value);
  if (match === null) {
    return null;
  }
  const generationID = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isInteger(generationID)
      || generationID > maximumGenerationID
      || !Number.isSafeInteger(sequence)
      || sequence > maximumRenderSequence) {
    return null;
  }
  return { identifier: value, generationID };
}

function parseFailureMessage(value: unknown): string | null {
  return typeof value === "string"
    && new TextEncoder().encode(value).byteLength <= maximumFailureMessageBytes
    ? value
    : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
