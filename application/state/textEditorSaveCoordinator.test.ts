import test from "node:test";
import assert from "node:assert/strict";

import { createTextEditorSaveCoordinator } from "./textEditorSaveCoordinator.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("text editor save coordinator joins duplicate saves already in flight", async () => {
  const pending = deferred();
  const saved: string[] = [];
  const savingStates: boolean[] = [];
  const coordinator = createTextEditorSaveCoordinator({
    onSave: async (content) => {
      saved.push(content);
      await pending.promise;
    },
    onSavingChange: (saving) => savingStates.push(saving),
  });

  const first = coordinator.save("remote text");
  const second = coordinator.save("remote text");

  assert.deepEqual(saved, ["remote text"]);
  pending.resolve();

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(saved, ["remote text"]);
  assert.deepEqual(savingStates, [true, false]);
});

test("text editor save coordinator saves newer content after an in-flight save finishes", async () => {
  const firstSave = deferred();
  const secondSave = deferred();
  const saved: string[] = [];
  const coordinator = createTextEditorSaveCoordinator({
    onSave: async (content) => {
      saved.push(content);
      await (content === "v1" ? firstSave.promise : secondSave.promise);
    },
  });

  const first = coordinator.save("v1");
  const second = coordinator.save("v2");

  assert.deepEqual(saved, ["v1"]);
  firstSave.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, ["v1", "v2"]);
  secondSave.resolve();

  assert.equal(await first, true);
  assert.equal(await second, true);
});

test("text editor save coordinator returns false to duplicate callers when the in-flight save fails", async () => {
  const pending = deferred();
  const errors: string[] = [];
  const coordinator = createTextEditorSaveCoordinator({
    onSave: async () => {
      await pending.promise;
      throw new Error("denied");
    },
    onSaveError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  const first = coordinator.save("content");
  const second = coordinator.save("content");

  pending.resolve();

  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.deepEqual(errors, ["denied"]);
});

test("text editor save coordinator reset prevents an old in-flight save from updating the next file", async () => {
  const pending = deferred();
  const successes: string[] = [];
  const errors: string[] = [];
  const savingStates: boolean[] = [];
  const coordinator = createTextEditorSaveCoordinator({
    onSave: async () => {
      await pending.promise;
    },
    onSaveSuccess: (content) => successes.push(content),
    onSaveError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    onSavingChange: (saving) => savingStates.push(saving),
  });

  const save = coordinator.save("old file");
  coordinator.reset();
  pending.resolve();

  assert.equal(await save, false);
  assert.deepEqual(successes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(savingStates, [true, false]);
});

test("text editor save coordinator reset cancels queued stale saves", async () => {
  const firstSave = deferred();
  const saved: string[] = [];
  const coordinator = createTextEditorSaveCoordinator({
    onSave: async (content) => {
      saved.push(content);
      await firstSave.promise;
    },
  });

  const first = coordinator.save("old v1");
  const queued = coordinator.save("old v2");
  coordinator.reset();
  firstSave.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(await first, false);
  assert.equal(await queued, false);
  assert.deepEqual(saved, ["old v1"]);
});
