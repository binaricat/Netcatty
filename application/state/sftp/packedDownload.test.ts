import assert from "node:assert/strict";
import test from "node:test";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { runPackedDownload } from "./packedDownload";
import { serializeSftpTransferCenter, deserializeSftpTransferCenter } from "../../../domain/sftpTransferCenter";
import { findActivePathConflict } from "../../../domain/sftpTransferConflicts";
import { globalSftpTransferScheduler } from "./globalTransferScheduler";

const request = {
  fileName: "2 selected", remoteDirectory: "/srv", names: ["compose", "README.md"],
  localDirectory: "/downloads", sftpId: "pinned-sftp", connectionId: "browse", sourceHostId: "host", sourceHostLabel: "Host",
};

test("one selection retains the captured connection and owns only its selected destination paths", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => null);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  const leases: string[] = [];
  let id = "";
  t.mock.method(netcattyBridge, "get", () => ({
    retainSftpTransferSession: async (session: string, lease: string, options: { cancelOnOwnerGone: boolean }) => {
      assert.deepEqual(options, { cancelOnOwnerGone: true });
      leases.push(session + lease);
      return { success: true };
    },
    releaseSftpTransferSession: async (session: string, lease: string) => {
      assert.equal(leases.pop(), session + lease);
    },
    downloadPackedSftp: async (options: { transferId: string; sftpId: string; remoteDirectory: string; names: string[]; localDirectory: string },
                               progress: (p: { phase: "extracting"; bytes: number }) => void) => {
      id = options.transferId;
      assert.equal(options.sftpId, request.sftpId);
      assert.equal(options.remoteDirectory, "/srv");
      assert.equal(options.localDirectory, "/downloads");
      assert.deepEqual(options.names, request.names);
      progress({ phase: "extracting", bytes: 203 });
      const rows = sftpTransferCenterStore.getOwnerTasks("fixture");
      assert.equal(rows.length, 1);
      const recovered = deserializeSftpTransferCenter(serializeSftpTransferCenter(rows)).tasks[0];
      assert.equal(recovered.status, "cancelled", "after restart never resume a packed group as a conventional walk of its parent");
      assert.equal(recovered.resumable, false);
      assert.equal(rows[0].phase, "extracting");
      assert.equal(rows[0].transferredBytes, 203);
      for (const path of ["/downloads/compose", "/downloads/compose/config/.env", "/downloads/README.md"]) {
        assert.equal(findActivePathConflict(rows, { id: "other", targetConnectionId: "local", targetPath: path })?.id, id);
      }
      assert.equal(findActivePathConflict(rows, { id: "other", targetConnectionId: "local", targetPath: "/downloads/another" }), undefined);
      return { status: "completed" };
    },
  }));
  try {
    assert.equal(await runPackedDownload("fixture", request), "completed");
    assert.equal(sftpTransferCenterStore.getTask(id)?.status, "completed");
    assert.equal(leases.length, 0);
  } finally { if (id) sftpTransferCenterStore.dismiss(id); }
});

test("unavailable server and local collision release the path reservation, disabled switch bypasses the SSH request", async (t) => {
  let enabled = true;
  t.mock.method(localStorageAdapter, "readBoolean", () => enabled);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  let reason = "unsupported", calls = 0;
  t.mock.method(netcattyBridge, "get", () => ({
    downloadPackedSftp: async () => { calls++; return { status: "fallback", reason }; },
  }));
  assert.equal(await runPackedDownload("fallback", request), "unsupported");
  reason = "conflict";
  assert.equal(await runPackedDownload("fallback", request), "conflict");
  enabled = false;
  assert.equal(await runPackedDownload("fallback", request), "regular");
  assert.equal(calls, 2);
  assert.equal(sftpTransferCenterStore.getOwnerTasks("fallback").length, 0);
});

test("cancelling the transfer-center row aborts the packed operation without starting fallback", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => true);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  let signalStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => { signalStarted = resolve; });
  let signalStopped!: (result: { status: "cancelled" }) => void;
  const done = new Promise<{ status: "cancelled" }>((resolve) => { signalStopped = resolve; });
  let aborted = "", released = false;
  t.mock.method(netcattyBridge, "get", () => ({
    retainSftpTransferSession: async () => ({ success: true }),
    releaseSftpTransferSession: async () => { released = true; },
    downloadPackedSftp: async (options: { transferId: string }) => {
      signalStarted(options.transferId);
      return done;
    },
    cancelTransfer: async (id: string) => { aborted = id; signalStopped({ status: "cancelled" }); },
  }));
  const running = runPackedDownload("cancel-test", request);
  const id = await started;
  try {
    await sftpTransferCenterStore.cancel(id);
    assert.equal(await running, "cancelled");
    assert.equal(aborted, id);
    assert.equal(released, true);
    assert.equal(sftpTransferCenterStore.getTask(id)?.status, "cancelled");
  } finally {
    signalStopped({ status: "cancelled" });
    sftpTransferCenterStore.dismiss(id);
  }
});

test("I/O and archive validation failures keep a failed row instead of falling back over the destination", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => true);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  let id = "";
  t.mock.method(netcattyBridge, "get", () => ({
    downloadPackedSftp: async (options: { transferId: string }) => {
      id = options.transferId;
      throw new Error("Unsafe archive entry");
    },
  }));
  try {
    await assert.rejects(runPackedDownload("error", request), /Unsafe archive entry/);
    assert.equal(sftpTransferCenterStore.getTask(id)?.status, "failed");
  } finally {
    if (id) sftpTransferCenterStore.dismiss(id);
  }
});

test("register the selected roots globally before retaining or starting a packed download", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => true);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  const order: string[] = [];
  let id = "";
  t.mock.method(netcattyBridge, "get", () => ({
    registerPackedDownload: async (metadata: Record<string, unknown>) => {
      id = String(metadata.transferId);
      assert.equal(sftpTransferCenterStore.getTask(id)?.controlKind, "packed-download");
      assert.equal(metadata.sourceConnectionId, request.connectionId);
      assert.equal(metadata.sourcePath, "/srv");
      assert.deepEqual(metadata.packedTargetPaths, ["/downloads/compose", "/downloads/README.md"]);
      order.push("register");
      return { success: true };
    },
    retainSftpTransferSession: async () => { order.push("retain"); return { success: true }; },
    downloadPackedSftp: async () => { order.push("download"); return { status: "completed" }; },
    finishPackedDownload: async (transferId: string) => { assert.equal(transferId, id); order.push("finish"); },
    releaseSftpTransferSession: async () => { order.push("release"); },
  }));
  try {
    assert.equal(await runPackedDownload("global-order", request), "completed");
    assert.deepEqual(order, ["register", "retain", "download", "finish", "release"]);
  } finally { if (id) sftpTransferCenterStore.dismiss(id); }
});

test("cancellation from another window during registration never starts or retains the queued download", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => true);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  let id = "", finished = false;
  t.mock.method(netcattyBridge, "get", () => ({
    registerPackedDownload: async (metadata: { transferId: string }) => {
      id = metadata.transferId;
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "cancelled", transferId: id, controlKind: "packed-download", endedAt: Date.now(),
      });
      // Registration may already have returned success in main when a second
      // window cancels it; the broadcast can arrive before this IPC resolves.
      return { success: true };
    },
    retainSftpTransferSession: async () => { assert.fail("cancelled work must not acquire a connection lease"); },
    downloadPackedSftp: async () => { assert.fail("cancelled work must not start"); },
    finishPackedDownload: async (transferId: string, result: { status: string }) => {
      assert.equal(transferId, id);
      assert.equal(result.status, "cancelled");
      finished = true;
    },
  }));
  try {
    assert.equal(await runPackedDownload("global-cancel", request), "cancelled");
    assert.equal(sftpTransferCenterStore.getTask(id)?.status, "cancelled");
    assert.equal(finished, true);
  } finally { if (id) sftpTransferCenterStore.dismiss(id); }
});

test("failed startup and ordinary-download fallback settle the global row", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => true);
  t.mock.method(localStorageAdapter, "readNumber", () => 1);
  let id = "", failLease = true;
  const outcomes: { status: string; error?: string }[] = [];
  t.mock.method(netcattyBridge, "get", () => ({
    registerPackedDownload: async (metadata: { transferId: string }) => {
      id = metadata.transferId;
      return { success: true };
    },
    retainSftpTransferSession: async () => ({ success: !failLease, reason: "Connection closed" }),
    releaseSftpTransferSession: async () => {},
    downloadPackedSftp: async () => ({ status: "fallback", reason: "unsupported" }),
    finishPackedDownload: async (_id: string, result: { status: string; error?: string }) => { outcomes.push(result); },
  }));
  try {
    await assert.rejects(runPackedDownload("global-startup", request), /Connection closed/);
    assert.equal(outcomes[0].status, "failed");
    assert.equal(outcomes[0].error, "Connection closed");
    assert.equal(sftpTransferCenterStore.getTask(id)?.status, "failed");
    sftpTransferCenterStore.dismiss(id);
    failLease = false;
    assert.equal(await runPackedDownload("global-startup", request), "unsupported");
    assert.equal(outcomes[1].status, "dismissed");
    assert.equal(sftpTransferCenterStore.getTask(id), undefined);
  } finally { if (id) sftpTransferCenterStore.dismiss(id); }
});

test("worker failure while registering a queued job remains a failure and never starts it", async (t) => {
  t.mock.method(localStorageAdapter, "readBoolean", () => true);
  let id = "", finished = false;
  t.mock.method(netcattyBridge, "get", () => ({
    registerPackedDownload: async (metadata: { transferId: string }) => {
      id = metadata.transferId;
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "failed", transferId: id, controlKind: "packed-download", error: "Transfer worker stopped",
      });
      return { success: true };
    },
    retainSftpTransferSession: async () => assert.fail("must not retain after worker failure"),
    downloadPackedSftp: async () => assert.fail("must not start after worker failure"),
    finishPackedDownload: async (_id: string, result: { status: string; error: string }) => {
      assert.equal(result.status, "failed");
      assert.equal(result.error, "Transfer worker stopped");
      finished = true;
    },
  }));
  try {
    await assert.rejects(runPackedDownload("global-worker-failure", request), /Transfer worker stopped/);
    assert.equal(sftpTransferCenterStore.getTask(id)?.status, "failed");
    assert.equal(finished, true);
  } finally { if (id) sftpTransferCenterStore.dismiss(id); }
});

for (const terminal of ["cancelled", "failed"] as const) {
  test(`${terminal} during connection retention releases the lease without joining the admission queue`, async (t) => {
    t.mock.method(localStorageAdapter, "readBoolean", () => true);
    t.mock.method(globalSftpTransferScheduler, "run", async () => assert.fail("settled work must not queue behind another download"));
    let id = "", released = false;
    t.mock.method(netcattyBridge, "get", () => ({
      registerPackedDownload: async (metadata: { transferId: string }) => { id = metadata.transferId; return { success: true }; },
      retainSftpTransferSession: async () => {
        sftpTransferCenterStore.ingestBackgroundEvent({
          type: terminal, transferId: id, controlKind: "packed-download",
          ...(terminal === "failed" ? { error: "Worker exited while retaining" } : {}),
        });
        return { success: true };
      },
      releaseSftpTransferSession: async () => { released = true; },
      downloadPackedSftp: async () => assert.fail("settled work must not start"),
      finishPackedDownload: async () => {},
    }));
    try {
      const running = runPackedDownload("global-lease-terminal", request);
      if (terminal === "failed") await assert.rejects(running, /Worker exited while retaining/);
      else assert.equal(await running, "cancelled");
      assert.equal(sftpTransferCenterStore.getTask(id)?.status, terminal);
      assert.equal(released, true);
    } finally { if (id) sftpTransferCenterStore.dismiss(id); }
  });
}
