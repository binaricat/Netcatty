import assert from "node:assert/strict";
import test from "node:test";
import { createSftpTransferCenterStore } from "./sftpTransferCenterStore";

for (const outcome of ["success", "failure", "pause", "cancel"] as const) {
  test(`resume feedback clears after ${outcome} without changing the paused checkpoint`, async (t) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    });
    let settle!: (value: { success: boolean; reason?: string }) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<{ success: boolean; reason?: string }>((resolve) => { settle = resolve; });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { netcatty: {
      resumeTransfer: () => { started(); return gate; },
      pauseTransfer: async () => ({ success: true, checkpointBytes: 100 }),
      cancelTransfer: async () => ({ success: true }),
    } } });
    const store = createSftpTransferCenterStore();
    store.publishOwner("feedback", [{
      id: "feedback", fileName: "file.bin", sourcePath: "/source.bin", targetPath: "/target.bin",
      sourceConnectionId: "remote", targetConnectionId: "local", direction: "download",
      status: "paused", totalBytes: 1000, transferredBytes: 100, checkpointBytes: 100,
      speed: 0, startTime: 1, isDirectory: false, resumable: true,
    }]);
    let notifications = 0;
    const unsubscribe = store.subscribeResume(() => { notifications += 1; });
    t.after(unsubscribe);
    const running = store.resume("feedback");
    assert.equal(store.isResuming("feedback"), true);
    assert.equal(store.getTask("feedback")?.status, "paused");
    assert.equal(store.getTask("feedback")?.checkpointBytes, 100);
    await entered;
    const followup = outcome === "pause" ? store.pause("feedback")
      : outcome === "cancel" ? store.cancel("feedback") : Promise.resolve();
    if (outcome === "pause" || outcome === "cancel") assert.equal(store.isResuming("feedback"), false);
    settle(outcome === "failure" ? { success: false, reason: "Resume safety check failed" } : { success: true });
    await Promise.all([running, followup]);
    assert.equal(store.isResuming("feedback"), false);
    assert.ok(notifications >= 2);
    if (outcome === "pause") assert.equal(store.getTask("feedback")?.status, "paused");
    if (outcome === "cancel") assert.equal(store.getTask("feedback")?.status, "cancelled");
  });
}
