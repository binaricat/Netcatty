import assert from "node:assert/strict";
import test from "node:test";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { runPackedDownload } from "./packedDownload";
import { serializeSftpTransferCenter, deserializeSftpTransferCenter } from "../../../domain/sftpTransferCenter";
import { findActivePathConflict } from "../../../domain/sftpTransferConflicts";

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
