import test from "node:test";
import assert from "node:assert/strict";

import {
  reduceZmodemTransferState,
  type ZmodemTransferState,
} from "./hooks/useZmodemTransfer.ts";
import { applyZmodemTransferToast, resolveZmodemTransferToast } from "./useTerminalEffects.ts";

const initialState: ZmodemTransferState = {
  active: false,
  transferType: null,
  filename: null,
  transferred: 0,
  total: 0,
  fileIndex: 0,
  fileCount: 0,
  finalizing: false,
  completed: false,
  startedAt: null,
  updatedAt: null,
  bytesPerSecond: null,
  error: null,
};

test("ZMODEM state drives success toast after completion", () => {
  const detected = reduceZmodemTransferState(initialState, {
    type: "detect",
    sessionId: "session-1",
    transferType: "download",
  }, 1_000);

  assert.equal(detected.active, true);
  assert.equal(detected.transferType, "download");
  assert.equal(detected.startedAt, 1_000);

  const progressed = reduceZmodemTransferState(detected, {
    type: "progress",
    sessionId: "session-1",
    transferType: "download",
    filename: "large.bin",
    transferred: 1024 * 1024,
    total: 2 * 1024 * 1024,
    fileIndex: 0,
    fileCount: -1,
  }, 2_000);

  assert.equal(progressed.active, true);
  assert.equal(progressed.filename, "large.bin");
  assert.equal(progressed.bytesPerSecond, 1024 * 1024);

  const completed = reduceZmodemTransferState(progressed, {
    type: "complete",
    sessionId: "session-1",
  }, 3_000);

  assert.equal(completed.active, false);
  assert.equal(completed.completed, true);
  assert.equal(completed.filename, "large.bin");
  assert.equal(completed.transferType, "download");
  assert.equal(completed.finalizing, false);
  assert.deepEqual(resolveZmodemTransferToast(completed), {
    kind: "success",
    message: "Downloaded: large.bin",
    title: "ZMODEM",
  });
});

test("ZMODEM completion without a filename still produces a success toast", () => {
  const detected = reduceZmodemTransferState(initialState, {
    type: "detect",
    sessionId: "session-1",
    transferType: "upload",
  }, 1_000);

  const completed = reduceZmodemTransferState(detected, {
    type: "complete",
    sessionId: "session-1",
  }, 1_500);

  assert.deepEqual(resolveZmodemTransferToast(completed), {
    kind: "success",
    message: "Uploaded",
    title: "ZMODEM",
  });
});

test("ZMODEM state drives error toast after a transfer fails", () => {
  const detected = reduceZmodemTransferState(initialState, {
    type: "detect",
    sessionId: "session-1",
    transferType: "upload",
  }, 1_000);

  const failed = reduceZmodemTransferState(detected, {
    type: "error",
    sessionId: "session-1",
    error: "Transfer cancelled",
  }, 1_500);

  assert.equal(failed.active, false);
  assert.equal(failed.transferType, "upload");
  assert.equal(failed.error, "Transfer cancelled");
  assert.equal(failed.finalizing, false);
  assert.deepEqual(resolveZmodemTransferToast(failed), {
    kind: "error",
    message: "Transfer cancelled",
    title: "ZMODEM",
  });
});

test("ZMODEM progress clears old speed when the next file starts", () => {
  const firstFile = reduceZmodemTransferState(initialState, {
    type: "progress",
    sessionId: "session-1",
    transferType: "upload",
    filename: "first.bin",
    fileIndex: 0,
    fileCount: 2,
    transferred: 1024 * 1024,
    total: 2 * 1024 * 1024,
  }, 1_000);
  const firstFileProgressed = reduceZmodemTransferState(firstFile, {
    type: "progress",
    sessionId: "session-1",
    filename: "first.bin",
    fileIndex: 0,
    transferred: 2 * 1024 * 1024,
    total: 2 * 1024 * 1024,
  }, 2_000);

  assert.equal(firstFileProgressed.bytesPerSecond, 1024 * 1024);

  const secondFileStarted = reduceZmodemTransferState(firstFileProgressed, {
    type: "progress",
    sessionId: "session-1",
    filename: "second.bin",
    fileIndex: 1,
    fileCount: 2,
    transferred: 0,
    total: 1024,
  }, 3_000);

  assert.equal(secondFileStarted.filename, "second.bin");
  assert.equal(secondFileStarted.bytesPerSecond, null);
});

test("ZMODEM toast application calls success and error once per transfer", () => {
  const successCalls: Array<[string, string | undefined]> = [];
  const errorCalls: Array<[string, string | undefined]> = [];
  const toast = {
    success: (message: string, title?: string) => successCalls.push([message, title]),
    error: (message: string, title?: string) => errorCalls.push([message, title]),
  };
  const toastedRef = { current: false };

  applyZmodemTransferToast({
    active: false,
    completed: true,
    transferType: "upload",
    filename: "large.bin",
    error: null,
  }, toastedRef, toast);

  assert.deepEqual(successCalls, [["Uploaded: large.bin", "ZMODEM"]]);
  assert.deepEqual(errorCalls, []);
  assert.equal(toastedRef.current, true);

  applyZmodemTransferToast({
    active: false,
    completed: true,
    transferType: "upload",
    filename: "large.bin",
    error: null,
  }, toastedRef, toast);

  assert.deepEqual(successCalls, [["Uploaded: large.bin", "ZMODEM"]]);
  assert.deepEqual(errorCalls, []);

  applyZmodemTransferToast({
    active: true,
    completed: false,
    transferType: "download",
    filename: null,
    error: null,
  }, toastedRef, toast);
  assert.equal(toastedRef.current, false);

  applyZmodemTransferToast({
    active: false,
    completed: false,
    transferType: "download",
    filename: "large.bin",
    error: "Remote closed the transfer",
  }, toastedRef, toast);

  assert.deepEqual(successCalls, [["Uploaded: large.bin", "ZMODEM"]]);
  assert.deepEqual(errorCalls, [["Remote closed the transfer", "ZMODEM"]]);
  assert.equal(toastedRef.current, true);
});
