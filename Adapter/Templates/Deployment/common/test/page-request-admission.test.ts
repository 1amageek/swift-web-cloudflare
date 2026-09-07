import assert from "node:assert/strict";
import test from "node:test";
import {
  PageRequestAdmission,
  PageRequestCapacityError,
} from "../src/PageRequestAdmission.ts";

test("production admission accepts a bounded concurrent render burst", async () => {
  const admission = new PageRequestAdmission(
    64,
    128 * 1024 * 1024,
  );
  const releases: (() => void)[] = [];
  const admitted = Array.from(
    { length: 64 },
    () => admission.perform(1, () => new Promise<void>((resolve) => {
      releases.push(resolve);
    })),
  );

  assert.equal(
    admission.pendingCount,
    64,
  );
  await assert.rejects(
    admission.perform(1, async () => undefined),
    PageRequestCapacityError,
  );

  for (const release of releases) {
    release();
  }
  await Promise.all(admitted);
  assert.equal(admission.pendingCount, 0);
  assert.equal(admission.reservedBytes, 0);
});

test("request admission rejects excess work before its operation starts", async () => {
  const admission = new PageRequestAdmission(1, 100);
  let releaseFirst: (() => void) | undefined;
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let rejectedOperationStarted = false;
  const first = admission.perform(10, () => firstBarrier);

  await assert.rejects(
    admission.perform(10, async () => {
      rejectedOperationStarted = true;
    }),
    (error: unknown) => error instanceof PageRequestCapacityError
      && error.reason === "pendingRequests",
  );
  assert.equal(rejectedOperationStarted, false);
  assert.equal(admission.pendingCount, 1);

  releaseFirst?.();
  await first;
  await admission.perform(10, async () => undefined);
  assert.equal(admission.pendingCount, 0);
  assert.equal(admission.reservedBytes, 0);
});

test("request admission bounds and releases aggregate memory reservations", async () => {
  const admission = new PageRequestAdmission(4, 10);
  let releaseFirst: (() => void) | undefined;
  const first = admission.perform(7, () => new Promise<void>((resolve) => {
    releaseFirst = resolve;
  }));

  await assert.rejects(
    admission.perform(4, async () => undefined),
    (error: unknown) => error instanceof PageRequestCapacityError
      && error.reason === "reservedBytes",
  );
  assert.equal(admission.reservedBytes, 7);

  releaseFirst?.();
  await first;
  await admission.perform(10, async () => undefined);
  assert.equal(admission.reservedBytes, 0);
});

test("request admission releases reservations after operation failure", async () => {
  const admission = new PageRequestAdmission(1, 10);
  await assert.rejects(
    admission.perform(10, async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  assert.equal(admission.pendingCount, 0);
  assert.equal(admission.reservedBytes, 0);
});

test("request cancellation does not overlap admitted work", async () => {
  const admission = new PageRequestAdmission(1, 10);
  const cancellation = new AbortController();
  let finishAbandonedWork: (() => void) | undefined;
  const abandonedWork = admission.perform(
    10,
    () => new Promise<void>((resolve) => {
      finishAbandonedWork = resolve;
    }),
    cancellation.signal,
  );

  cancellation.abort();
  assert.equal(admission.pendingCount, 1);
  assert.equal(admission.reservedBytes, 10);
  await assert.rejects(
    admission.perform(10, async () => undefined),
    PageRequestCapacityError,
  );

  finishAbandonedWork?.();
  await abandonedWork;
  assert.equal(admission.pendingCount, 0);
  assert.equal(admission.reservedBytes, 0);
  await admission.perform(10, async () => undefined);
});
