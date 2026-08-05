import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  cleanupFailedExternalOpenTemp,
  useExternalFileWatchLifecycle,
  type ExternalFileWatchLifecycle,
} from "./externalFileWatchLifecycle";

test("failed external app launch unregisters and deletes its remote temp file", async () => {
  const calls: string[] = [];
  await cleanupFailedExternalOpenTemp({
    unregisterTempFile: async (sftpId, localPath) => {
      calls.push(`${sftpId}:${localPath}`);
      return { success: true };
    },
  }, "sftp-1", "/tmp/edit.txt");
  assert.deepEqual(calls, ["sftp-1:/tmp/edit.txt"]);
});

test("renderer tracks a reused watch once and releases it on unmount", async () => {
  const stopped: Array<{ watchId: string; cleanupTempFile: boolean }> = [];
  let lifecycle: ExternalFileWatchLifecycle | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    lifecycle = useExternalFileWatchLifecycle(async (watchId, cleanupTempFile) => {
      stopped.push({ watchId, cleanupTempFile });
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  await act(async () => {
    lifecycle!.remember("watch-reused");
    lifecycle!.remember("watch-reused");
  });
  assert.equal(lifecycle!.activeCountRef.current, 1);

  await act(async () => renderer!.unmount());
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, [{ watchId: "watch-reused", cleanupTempFile: false }]);
});

test("explicit SFTP lifecycle cleanup releases every tracked watch and temp file", async () => {
  const stopped: Array<{ watchId: string; cleanupTempFile: boolean }> = [];
  let lifecycle: ExternalFileWatchLifecycle | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    lifecycle = useExternalFileWatchLifecycle(async (watchId, cleanupTempFile) => {
      stopped.push({ watchId, cleanupTempFile });
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  lifecycle!.remember("watch-a");
  lifecycle!.remember("watch-b");

  await lifecycle!.releaseAll(true);

  assert.equal(lifecycle!.activeCountRef.current, 0);
  assert.deepEqual(stopped, [
    { watchId: "watch-a", cleanupTempFile: true },
    { watchId: "watch-b", cleanupTempFile: true },
  ]);
  await act(async () => renderer!.unmount());
});

test("a watch that starts after unmount is stopped instead of being retained", async () => {
  const stopped: Array<{ watchId: string; cleanupTempFile: boolean }> = [];
  let lifecycle: ExternalFileWatchLifecycle | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    lifecycle = useExternalFileWatchLifecycle(async (watchId, cleanupTempFile) => {
      stopped.push({ watchId, cleanupTempFile });
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  const lateLifecycle = lifecycle!;
  await act(async () => renderer!.unmount());

  lateLifecycle.remember("watch-started-after-unmount");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, [{
    watchId: "watch-started-after-unmount",
    cleanupTempFile: false,
  }]);
  assert.equal(lateLifecycle.activeCountRef.current, 0);
});

test("release invalidates pending watch starts while a new generation remains usable", async () => {
  const stopped: Array<{ watchId: string; cleanupTempFile: boolean }> = [];
  let lifecycle: ExternalFileWatchLifecycle | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    lifecycle = useExternalFileWatchLifecycle(async (watchId, cleanupTempFile) => {
      stopped.push({ watchId, cleanupTempFile });
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  const oldGeneration = lifecycle!.captureGeneration();
  await lifecycle!.releaseAll(true);

  lifecycle!.remember("late-old-watch", oldGeneration);
  const currentGeneration = lifecycle!.captureGeneration();
  lifecycle!.remember("fresh-watch", currentGeneration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, [{ watchId: "late-old-watch", cleanupTempFile: true }]);
  assert.equal(lifecycle!.activeCountRef.current, 1);

  await lifecycle!.releaseAll(false);
  assert.deepEqual(stopped, [
    { watchId: "late-old-watch", cleanupTempFile: true },
    { watchId: "fresh-watch", cleanupTempFile: false },
  ]);
  await act(async () => renderer!.unmount());
});

test("backend session cleanup removes a stopped watch from renderer ownership", async () => {
  const stopped: Array<{ watchId: string; cleanupTempFile: boolean }> = [];
  let onBackendStopped: ((payload: {
    watchId: string;
    localPath?: string;
  }) => void) | null = null;
  let lifecycle: ExternalFileWatchLifecycle | null = null;
  let renderer: ReactTestRenderer | null = null;
  const forgottenPaths: string[] = [];

  function Probe() {
    lifecycle = useExternalFileWatchLifecycle(
      async (watchId, cleanupTempFile) => {
        stopped.push({ watchId, cleanupTempFile });
      },
      (callback) => {
        onBackendStopped = callback;
        return () => { onBackendStopped = null; };
      },
      (localPath) => { forgottenPaths.push(localPath); },
    );
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  lifecycle!.remember("watch-closed-with-session");
  assert.equal(lifecycle!.activeCountRef.current, 1);

  await act(async () => {
    onBackendStopped?.({
      watchId: "watch-closed-with-session",
      localPath: "/tmp/externally-deleted.txt",
    });
  });
  assert.equal(lifecycle!.activeCountRef.current, 0);
  assert.deepEqual(forgottenPaths, ["/tmp/externally-deleted.txt"]);

  await act(async () => renderer!.unmount());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, [], "backend-owned cleanup must not issue a duplicate stop");
});
