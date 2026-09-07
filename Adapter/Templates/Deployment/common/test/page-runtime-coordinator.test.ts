import assert from "node:assert/strict";
import test from "node:test";
import type { PageDeadlineScheduler } from "../src/PageCallRegistry.ts";
import {
  PageCallCapacityError,
  PageCallTimeoutError,
  PageDeadlineSchedulingError,
} from "../src/PageCallRegistry.ts";
import {
  PageRenderError,
  PageRuntimeCoordinator,
  PageRuntimeUnavailableError,
  type PageRuntimeAdapter,
} from "../src/PageRuntimeCoordinator.ts";
import { PageRequestCancellationError } from "../src/PageRequestCancellation.ts";
import type { PageRequestEnvelope } from "../src/PageWire.ts";

type TestRuntime = {
  id: number;
  memoryByteCount: number;
};

class RecordingRuntimeAdapter implements PageRuntimeAdapter<TestRuntime, string> {
  readonly instances: TestRuntime[] = [];
  readonly released: TestRuntime[] = [];
  readonly starts: { runtime: TestRuntime; startID: number }[] = [];
  readonly renders: {
    runtime: TestRuntime;
    renderID: string;
    request: PageRequestEnvelope;
  }[] = [];

  throwWhenStarting = false;
  throwWhenRendering = false;
  holdInstantiation = false;
  beforeStartTrap: ((startID: number) => void) | null = null;
  beforeRenderTrap: ((renderID: string) => void) | null = null;
  private readonly heldInstantiationResolvers: (() => void)[] = [];

  async instantiate(): Promise<TestRuntime> {
    const runtime = {
      id: this.instances.length + 1,
      memoryByteCount: 1,
    };
    this.instances.push(runtime);
    if (this.holdInstantiation) {
      await new Promise<void>((resolve) => {
        this.heldInstantiationResolvers.push(resolve);
      });
    }
    return runtime;
  }

  releaseHeldInstantiations(): void {
    for (const resolve of this.heldInstantiationResolvers.splice(0)) {
      resolve();
    }
  }

  start(runtime: TestRuntime, startID: number): void {
    this.starts.push({ runtime, startID });
    if (this.throwWhenStarting) {
      this.beforeStartTrap?.(startID);
      throw new Error("start trapped");
    }
  }

  render(
    runtime: TestRuntime,
    renderID: string,
    request: PageRequestEnvelope,
  ): void {
    this.renders.push({ runtime, renderID, request });
    if (this.throwWhenRendering) {
      this.beforeRenderTrap?.(renderID);
      throw new Error("render trapped");
    }
  }

  memoryByteCount(runtime: TestRuntime): number {
    return runtime.memoryByteCount;
  }

  release(runtime: TestRuntime): void {
    assert.ok(!this.released.includes(runtime), "Runtime must be released once");
    this.released.push(runtime);
  }
}

type ScheduledDeadline = {
  expire: () => void;
  active: boolean;
};

class ControllableDeadlineScheduler implements PageDeadlineScheduler {
  readonly deadlines: ScheduledDeadline[] = [];
  failNextSchedule = false;

  schedule(expire: () => void): unknown {
    if (this.failNextSchedule) {
      this.failNextSchedule = false;
      throw new Error("deadline unavailable");
    }
    const deadline = { expire, active: true };
    this.deadlines.push(deadline);
    return deadline;
  }

  cancel(handle: unknown): void {
    (handle as ScheduledDeadline).active = false;
  }

  expireNextActive(): void {
    const deadline = this.deadlines.find((candidate) => candidate.active);
    assert.ok(deadline, "Expected an active deadline");
    deadline.active = false;
    deadline.expire();
  }
}

const request: PageRequestEnvelope = {
  method: "GET",
  path: "/",
  search: "",
  scheme: "https",
  host: "calendar.test",
  encodedHeaders: "",
  encodedBody: "",
};

test("concurrent cold start is shared and render completion is correlated", async () => {
  const { adapter, coordinator } = makeCoordinator();
  const first = coordinator.render("environment", request);
  const second = coordinator.render("environment", request);

  await waitFor(() => adapter.starts.length === 1);
  assert.equal(adapter.instances.length, 1);
  coordinator.didStart(adapter.starts[0].startID);
  await waitFor(() => adapter.renders.length === 2);

  coordinator.didRenderPage(adapter.renders[1].renderID, 201, "", "Qg==");
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "QQ==");
  assert.equal((await first).body[0], 0x41);
  assert.equal((await second).body[0], 0x42);
  assert.equal(coordinator.pendingStartCount, 0);
  assert.equal(coordinator.pendingRenderCount, 0);
});

test("production render capacity correlates a concurrent request burst", async () => {
  const { adapter, coordinator } = makeCoordinator({
    maximumPendingRenders: 64,
  });
  const renders = Array.from(
    { length: 64 },
    () => coordinator.render("environment", request),
  );

  await waitFor(() => adapter.starts.length === 1);
  coordinator.didStart(adapter.starts[0].startID);
  await waitFor(
    () => adapter.renders.length
      === 64,
  );
  for (const render of adapter.renders) {
    coordinator.didRenderPage(render.renderID, 200, "", "");
  }

  await Promise.all(renders);
  assert.equal(coordinator.pendingRenderCount, 0);
});

test("a normal render failure rejects only its call", async () => {
  const { adapter, coordinator } = makeCoordinator();
  const first = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didFailToRenderPage(adapter.renders[0].renderID, "route failed");
  await assert.rejects(first, PageRenderError);

  const second = coordinator.render("environment", request);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await second;
  assert.equal(adapter.instances.length, 1);
});

test("a synchronous runtime trap cleans pending calls and retries with a new generation", async () => {
  const { adapter, coordinator } = makeCoordinator();
  adapter.throwWhenStarting = true;
  const failed = coordinator.render("environment", request);
  await assert.rejects(failed, PageRuntimeUnavailableError);
  assert.equal(coordinator.pendingStartCount, 0);
  assert.equal(coordinator.pendingRenderCount, 0);

  adapter.throwWhenStarting = false;
  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
});

test("a startup trap overrides a synchronous ready callback", async () => {
  const { adapter, coordinator } = makeCoordinator();
  adapter.throwWhenStarting = true;
  adapter.beforeStartTrap = (startID) => coordinator.didStart(startID);
  await assert.rejects(
    coordinator.render("environment", request),
    PageRuntimeUnavailableError,
  );
  assert.equal(coordinator.pendingStartCount, 0);
  assert.equal(coordinator.pendingRenderCount, 0);
});

test("a synchronous render trap terminates its generation and permits retry", async () => {
  const { adapter, coordinator } = makeCoordinator();
  adapter.throwWhenRendering = true;
  const failed = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await assert.rejects(failed, PageRuntimeUnavailableError);
  assert.equal(coordinator.pendingRenderCount, 0);

  adapter.throwWhenRendering = false;
  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
});

test("a render trap overrides a synchronous success callback", async () => {
  const { adapter, coordinator } = makeCoordinator();
  adapter.throwWhenRendering = true;
  adapter.beforeRenderTrap = (renderID) => {
    coordinator.didRenderPage(renderID, 200, "", "");
  };
  const failed = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await assert.rejects(failed, PageRuntimeUnavailableError);
  assert.equal(coordinator.pendingRenderCount, 0);
});

test("a render trap overrides a synchronous failure callback", async () => {
  const { adapter, coordinator } = makeCoordinator();
  adapter.throwWhenRendering = true;
  adapter.beforeRenderTrap = (renderID) => {
    coordinator.didFailToRenderPage(renderID, "route failed first");
  };
  const failed = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await assert.rejects(failed, PageRuntimeUnavailableError);
  assert.equal(coordinator.pendingRenderCount, 0);
});

test("a startup timeout releases its generation and permits retry", async () => {
  const { adapter, coordinator, deadlines } = makeCoordinator();
  const failed = coordinator.render("environment", request);
  await waitFor(() => adapter.starts.length === 1);
  deadlines.expireNextActive();
  await assert.rejects(failed, PageCallTimeoutError);
  assert.equal(coordinator.pendingStartCount, 0);

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
});

test("the startup deadline includes runtime instantiation", async () => {
  const { adapter, coordinator, deadlines } = makeCoordinator();
  adapter.holdInstantiation = true;
  const failed = coordinator.render("environment", request);
  await waitFor(() => adapter.instances.length === 1);
  deadlines.expireNextActive();
  await assert.rejects(failed, PageCallTimeoutError);
  assert.equal(coordinator.pendingStartCount, 0);

  adapter.holdInstantiation = false;
  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  adapter.releaseHeldInstantiations();
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
  assert.equal(adapter.starts.length, 1);
  assert.deepEqual(adapter.released, [adapter.instances[0]]);
});

test("a deadline scheduling failure does not retain a pending generation", async () => {
  const { adapter, coordinator, deadlines } = makeCoordinator();
  deadlines.failNextSchedule = true;
  await assert.rejects(
    coordinator.render("environment", request),
    PageDeadlineSchedulingError,
  );
  assert.equal(coordinator.pendingStartCount, 0);
  assert.equal(coordinator.pendingRenderCount, 0);

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 1);
});

test("an unattributed malformed callback cannot terminate the active generation", async () => {
  const violations: Error[] = [];
  const { adapter, coordinator } = makeCoordinator({ violations });
  const render = coordinator.render("environment", request);
  await waitFor(() => adapter.starts.length === 1);
  coordinator.didStart("not-a-generation");
  assert.equal(violations.length, 1);
  coordinator.didStart(adapter.starts[0].startID);
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "");
  await render;
  assert.equal(adapter.instances.length, 1);
});

test("a render timeout terminates only its generation and releases capacity", async () => {
  const { adapter, coordinator, deadlines } = makeCoordinator();
  const failed = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  deadlines.expireNextActive();
  await assert.rejects(failed, PageCallTimeoutError);
  assert.equal(coordinator.pendingRenderCount, 0);

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
});

test("request cancellation terminates its generation and permits retry", async () => {
  const { adapter, coordinator } = makeCoordinator({
    maximumPendingRenders: 1,
  });
  const cancellation = new AbortController();
  const cancelled = coordinator.render(
    "environment",
    request,
    cancellation.signal,
  );
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);

  cancellation.abort();
  await assert.rejects(cancelled, PageRequestCancellationError);
  assert.equal(coordinator.pendingStartCount, 0);
  assert.equal(coordinator.pendingRenderCount, 0);

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
});

test("unknown duplicate completion terminates the owning generation", async () => {
  const violations: Error[] = [];
  const { adapter, coordinator } = makeCoordinator({ violations });
  const first = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  const firstRenderID = adapter.renders[0].renderID;
  coordinator.didRenderPage(firstRenderID, 200, "", "");
  await first;
  coordinator.didRenderPage(firstRenderID, 200, "", "");
  assert.equal(violations.length, 1);

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await retry;
  assert.equal(adapter.instances.length, 2);
});

test("retired generation completion cannot terminate its replacement", async () => {
  const violations: Error[] = [];
  const { adapter, coordinator } = makeCoordinator({
    violations,
    retirementThresholdBytes: 10,
  });
  const first = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  adapter.instances[0].memoryByteCount = 10;

  const second = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  const firstRenderID = adapter.renders[0].renderID;
  coordinator.didRenderPage(firstRenderID, 200, "", "");
  await first;
  coordinator.didRenderPage(firstRenderID, 200, "", "");
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await second;
  assert.equal(adapter.instances.length, 2);
  assert.equal(violations.length, 1);
});

test("capacity exhaustion does not poison the active runtime", async () => {
  const { adapter, coordinator } = makeCoordinator({
    maximumPendingRenders: 1,
  });
  const first = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  await assert.rejects(
    coordinator.render("environment", request),
    PageCallCapacityError,
  );
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "", "");
  await first;

  const next = coordinator.render("environment", request);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await next;
  assert.equal(adapter.instances.length, 1);
});

test("invalid render wire terminates the generation", async () => {
  const { adapter, coordinator } = makeCoordinator();
  const failed = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  coordinator.didRenderPage(adapter.renders[0].renderID, 200, "orphan", "");
  await assert.rejects(failed, /headers are incomplete/);

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await retry;
});

test("unknown render callbacks are rejected before payload decoding", async () => {
  const { adapter, coordinator } = makeCoordinator();
  const failed = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  const generationID = /^g([0-9]+)-/.exec(adapter.renders[0].renderID)?.[1];
  assert.ok(generationID);
  coordinator.didRenderPage(
    `g${generationID}-r999999`,
    200,
    "orphan",
    "not-base64",
  );
  await assert.rejects(failed, /callback .* is unknown/);
});

test("protocol reporting cannot interrupt generation cleanup", async () => {
  const { adapter, coordinator } = makeCoordinator({
    reportProtocolViolation: () => {
      throw new Error("observer failed");
    },
  });
  const first = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 0);
  await waitFor(() => adapter.renders.length === 1);
  const renderID = adapter.renders[0].renderID;
  coordinator.didRenderPage(renderID, 200, "", "");
  await first;
  coordinator.didRenderPage(renderID, 200, "", "");

  const retry = coordinator.render("environment", request);
  await startGeneration(adapter, coordinator, 1);
  await waitFor(() => adapter.renders.length === 2);
  coordinator.didRenderPage(adapter.renders[1].renderID, 200, "", "");
  await retry;
});

function makeCoordinator(options: {
  violations?: Error[];
  reportProtocolViolation?: (error: Error) => void;
  maximumPendingRenders?: number;
  retirementThresholdBytes?: number;
} = {}) {
  const adapter = new RecordingRuntimeAdapter();
  const deadlines = new ControllableDeadlineScheduler();
  const coordinator = new PageRuntimeCoordinator(adapter, {
    deadlineScheduler: deadlines,
    maximumPendingRenders: options.maximumPendingRenders ?? 8,
    retirementThresholdBytes: options.retirementThresholdBytes ?? 1024,
    reportProtocolViolation: options.reportProtocolViolation
      ?? ((error) => options.violations?.push(error)),
  });
  return { adapter, coordinator, deadlines };
}

async function startGeneration(
  adapter: RecordingRuntimeAdapter,
  coordinator: PageRuntimeCoordinator<TestRuntime, string>,
  startIndex: number,
): Promise<void> {
  await waitFor(() => adapter.starts.length > startIndex);
  coordinator.didStart(adapter.starts[startIndex].startID);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Condition did not become true");
}
