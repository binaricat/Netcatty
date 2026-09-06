import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Host, TransferTask } from "../../../domain/models";
import {
  classifyDedicatedResumeEndpoints,
  classifyResumeSourceValidationError,
  createPersistedResumeChildLookup,
  findPersistedChildForResumeFile,
  MAX_CONCURRENT_DEDICATED_SESSION_OPENS,
  resetDedicatedSessionOpenGateForTests,
  resumeTransferWithDedicatedSession,
  resolveDirectoryResumeTargetRoot,
  isUsableTransferSessionId,
  resolveHostForTransferEndpoint,
  resolveResumeHosts,
  shouldSkipCompletedResumeChild,
  withDedicatedSessionOpenSlot,
} from "./dedicatedTransferResume";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import {
  appendDirectoryCheckpointIdentity,
  appendDirectoryManifestIdentity,
  createDirectoryManifestAccumulator,
  createDirectoryEntryIdentity,
  createEmptyDirectoryResumeCheckpoint,
} from "../../../domain/sftpDirectoryCheckpoint";

const host = (id: string, label: string, hostname = label): Host => ({
  id,
  label,
  hostname,
  port: 22,
  username: "root",
  authMethod: "password",
  protocol: "ssh",
} as Host);

for (const retainedStatus of [undefined, "interrupted", "failed", "paused"] as const) {
for (const newerPause of retainedStatus === "paused" ? [false, true] : [false]) {
const batchExistingIdentity = retainedStatus !== undefined;
test(`superseded folder child settles when its completion was compacted into the parent: retained=${retainedStatus ?? "none"}, newerPause=${newerPause}`, async (t) => {
  const { sftpTransferCenterStore } = await import("../sftpTransferCenterStore");
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const originalGet = netcattyBridge.get;
  let abort = false;
  let running: Promise<unknown> | undefined;
  let childId: string | undefined;
  const parent: TransferTask = {
    id: "superseded-compacted-folder", fileName: "folder",
    sourcePath: "/local/folder", targetPath: "/remote/folder",
    sourceConnectionId: "local", targetConnectionId: "expired-sftp",
    targetHostId: "h1", direction: "upload", status: "transferring",
    totalBytes: 1, transferredBytes: 0, speed: 0, startTime: Date.now(),
    isDirectory: true, progressMode: "files", reconnectRequired: true,
  };
  t.after(async () => {
    abort = true;
    await running;
    netcattyBridge.get = originalGet;
    sftpTransferCenterStore.patchTask(parent.id, { status: "completed" });
    sftpTransferCenterStore.dismiss(parent.id);
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    resetDedicatedSessionOpenGateForTests();
  });
  const persisted: TransferTask = {
    ...parent, id: "retained-child", parentTaskId: parent.id, isDirectory: false,
    sourcePath: "/local/folder/a.bin", targetPath: "/remote/folder/a.bin",
    totalBytes: 10, sourceLastModified: 1, status: retainedStatus ?? "interrupted",
    directoryEntryIndex: 0, directoryEntryIdentity: "a".repeat(64),
  };
  const { createDedicatedResumeChildUpdateBatcher } = await import("../../app/dedicatedResumeProgress");
  // Exercise the real large-history batching branch with one relevant retained row.
  const childBatcher = createDedicatedResumeChildUpdateBatcher({
    getTaskCount: () => 4096,
    hasTask: (id) => id === persisted.id,
    upsertTasks: (updates) => sftpTransferCenterStore.upsertTasks(updates),
  });
  sftpTransferCenterStore.publishOwner("compacted-owner", [parent, ...(batchExistingIdentity ? [persisted] : [])]);
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp", closeSftp: async () => {},
    listLocalTree: async () => [{
      localPath: "/local/folder/a.bin", relativePath: "a.bin", type: "file", size: 10, lastModified: 1,
    }],
    mkdirSftp: async () => {},
    statLocal: async () => {
      if (newerPause) sftpTransferCenterStore.patchTask(persisted.id, { status: "paused", lifecycleEpoch: 9 });
      return { size: 10, lastModified: 1 };
    },
    startStreamTransfer: async (options: {
      transferId: string; parentTaskId?: string; directoryEntryIndex?: number; directoryEntryIdentity?: string;
    }) => {
      childId = options.transferId;
      // Main-process lifecycle events carry the stream's metadata, not queued UI updates.
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "started", transferId: childId, lifecycleEpoch: 0,
        parentTaskId: options.parentTaskId,
        directoryEntryIndex: options.directoryEntryIndex,
        directoryEntryIdentity: options.directoryEntryIdentity,
      });
      // A newer same-id owner completes before this older invocation rejoins.
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "completed", transferId: childId, transferred: 10, totalBytes: 10, lifecycleEpoch: 0,
      });
      return { superseded: true };
    },
  });
  running = resumeTransferWithDedicatedSession(parent, {
    hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
  }, undefined, {
    children: batchExistingIdentity ? [persisted] : [], shouldAbort: () => abort,
    onChildUpdate: (child) => batchExistingIdentity
      ? childBatcher.push(child)
      : sftpTransferCenterStore.publishOwner("compacted-owner", [parent, child]),
  });
  const result = await Promise.race([
    running,
    new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 450)),
  ]);
  if (newerPause) {
    assert.equal(result, "still-waiting", "a later pause must still hold fresh recovery");
    assert.equal(childId, undefined, "newer paused child must not start");
    assert.equal(sftpTransferCenterStore.getTask(persisted.id)?.lifecycleEpoch, 9);
    return;
  }
  assert.notEqual(result, "still-waiting", "completed compacted child must not leave its folder waiting forever");
  assert.ok(childId);
  assert.equal(sftpTransferCenterStore.getTask(childId), undefined, "completed row was compacted");
  assert.equal(sftpTransferCenterStore.getTask(parent.id)?.directoryResumeCheckpoint?.completedEntries, 1);
  assert.notEqual(result, "still-waiting", "completed compacted child must not leave its folder waiting forever");
  assert.equal((result as { success: boolean }).success, true);
});
}
}

test("resolveDirectoryResumeTargetRoot prefers staged replace path", () => {
  assert.equal(
    resolveDirectoryResumeTargetRoot({
      targetPath: "/final/dir",
      stagedTargetPath: "/final/dir.netcatty-abc.part",
      replaceExistingTarget: true,
    }),
    "/final/dir.netcatty-abc.part",
  );
  assert.equal(
    resolveDirectoryResumeTargetRoot({
      targetPath: "/final/dir",
    }),
    "/final/dir",
  );
});

test("findPersistedChildForResumeFile matches staged target paths", () => {
  const staged = "/final/dir.netcatty-abc.part/a.txt";
  const child = {
    id: "c1",
    status: "completed" as const,
    sourcePath: "/src/a.txt",
    targetPath: staged,
    checkpointBytes: 10,
    transferredBytes: 10,
    totalBytes: 10,
  };
  const planRoot = resolveDirectoryResumeTargetRoot({
    targetPath: "/final/dir",
    stagedTargetPath: "/final/dir.netcatty-abc.part",
  });
  const planned = { sourcePath: "/src/a.txt", targetPath: `${planRoot}/a.txt` };
  assert.equal(findPersistedChildForResumeFile([child], planned)?.id, "c1");
  assert.equal(shouldSkipCompletedResumeChild(findPersistedChildForResumeFile([child], planned)), true);
});

test("persisted resume child lookup handles 50,000 retained rows in linear time", () => {
  const children = Array.from({ length: 50_000 }, (_, index) => ({
    id: `child-${index}`,
    status: "failed" as const,
    sourcePath: `/source/file-${index}`,
    targetPath: `/target/file-${index}`,
    checkpointBytes: index,
    transferredBytes: index,
    totalBytes: index + 1,
  }));
  const startedAt = Date.now();
  const lookup = createPersistedResumeChildLookup(children);
  for (let index = 0; index < children.length; index += 1) {
    assert.equal(lookup({
      sourcePath: `/source/file-${index}`,
      targetPath: `/target/file-${index}`,
    })?.id, `child-${index}`);
  }
  assert.ok(Date.now() - startedAt < 2_000, "50k retained-child lookup should stay linear");
});

test("resolveHostForTransferEndpoint requires recorded id and supports unique legacy names", () => {
  const hosts = [host("id-1", "CI-Build-01", "ci-01.example")];
  assert.equal(resolveHostForTransferEndpoint(hosts, "id-1", "other")?.id, "id-1");
  assert.equal(resolveHostForTransferEndpoint(hosts, "missing", "CI-Build-01"), null);
  assert.equal(resolveHostForTransferEndpoint(hosts, undefined, "CI-Build-01")?.id, "id-1");
  assert.equal(resolveHostForTransferEndpoint(hosts, undefined, "ci-01.example")?.id, "id-1");
  assert.equal(resolveHostForTransferEndpoint(hosts, "missing", "gone"), null);
});

test("isUsableTransferSessionId rejects SFTP pane connection ids", () => {
  assert.equal(isUsableTransferSessionId("term-alive"), true);
  assert.equal(isUsableTransferSessionId("local"), false);
  assert.equal(isUsableTransferSessionId("agent"), false);
  assert.equal(isUsableTransferSessionId("left-abc"), false);
  assert.equal(isUsableTransferSessionId("right-deadbeef"), false);
  assert.equal(isUsableTransferSessionId(undefined), false);
});

test("resolveResumeHosts accepts ephemeral quick-connect hosts in the host list", () => {
  const ephemeral = {
    ...host("quick-1", "10.2.0.32", "10.2.0.32"),
    ephemeral: true,
    password: "secret",
  } as Host;
  const resolved = resolveResumeHosts({
    id: "up-1",
    fileName: "ChatGPT.dmg",
    sourcePath: "/local/ChatGPT.dmg",
    targetPath: "/remote/ChatGPT.dmg",
    sourceConnectionId: "local",
    targetConnectionId: "sess-1",
    targetHostId: "quick-1",
    targetHostLabel: "10.2.0.32",
    direction: "upload",
    status: "paused",
    totalBytes: 100,
    transferredBytes: 1,
    speed: 0,
    startTime: 1,
    isDirectory: false,
  } as TransferTask, { hosts: [ephemeral], keys: [], identities: [] });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.endpoints.targetHost?.id, "quick-1");
    // Pane-style ids are not terminal sessions — only real session ids attach.
    assert.equal(resolved.endpoints.targetSessionId, "sess-1");
  }
});

test("resolveResumeHosts ignores left-/right- pane connection ids", () => {
  const vaultHost = host("h1", "box", "1.2.3.4");
  const resolved = resolveResumeHosts({
    id: "up-pane",
    fileName: "file.bin",
    sourcePath: "/local/file.bin",
    targetPath: "/remote/file.bin",
    sourceConnectionId: "local",
    targetConnectionId: "left-not-a-terminal",
    targetHostId: "h1",
    targetHostLabel: "box",
    direction: "upload",
    status: "interrupted",
    totalBytes: 10,
    transferredBytes: 2,
    speed: 0,
    startTime: 1,
    isDirectory: false,
  } as TransferTask, { hosts: [vaultHost], keys: [], identities: [] });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.endpoints.targetHost?.id, "h1");
    assert.equal(resolved.endpoints.targetSessionId, undefined);
  }
});

test("resolveResumeHosts prefers attaching live session even when vault host exists", () => {
  const vaultHost = host("h1", "box", "1.2.3.4");
  const resolved = resolveResumeHosts({
    id: "up-shared",
    fileName: "file.bin",
    sourcePath: "/local/file.bin",
    targetPath: "/remote/file.bin",
    sourceConnectionId: "local",
    targetConnectionId: "term-live",
    targetHostId: "h1",
    targetHostLabel: "box",
    direction: "upload",
    status: "interrupted",
    totalBytes: 10,
    transferredBytes: 2,
    speed: 0,
    startTime: 1,
    isDirectory: false,
  } as TransferTask, { hosts: [vaultHost], keys: [], identities: [] });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.endpoints.targetHost?.id, "h1");
    assert.equal(resolved.endpoints.targetSessionId, "term-live");
  }
});

test("resolveResumeHosts falls back to a live session when vault host is missing", () => {
  const resolved = resolveResumeHosts({
    id: "up-2",
    fileName: "ChatGPT.dmg",
    sourcePath: "/local/ChatGPT.dmg",
    targetPath: "/remote/ChatGPT.dmg",
    sourceConnectionId: "local",
    targetConnectionId: "sess-live",
    targetHostId: "quick-missing",
    targetHostLabel: "10.2.0.32",
    direction: "upload",
    status: "paused",
    totalBytes: 100,
    transferredBytes: 1,
    speed: 0,
    startTime: 1,
    isDirectory: false,
  } as TransferTask, { hosts: [], keys: [], identities: [] });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.endpoints.targetHost, null);
    assert.equal(resolved.endpoints.targetSessionId, "sess-live");
  }
});

test("resolveResumeHosts errors when neither vault host nor live session exists", () => {
  const resolved = resolveResumeHosts({
    id: "up-3",
    fileName: "ChatGPT.dmg",
    sourcePath: "/local/ChatGPT.dmg",
    targetPath: "/remote/ChatGPT.dmg",
    sourceConnectionId: "local",
    targetConnectionId: "local",
    targetHostId: "gone",
    targetHostLabel: "10.2.0.32",
    direction: "upload",
    status: "paused",
    totalBytes: 100,
    transferredBytes: 1,
    speed: 0,
    startTime: 1,
    isDirectory: false,
  } as TransferTask, { hosts: [], keys: [], identities: [] });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.match(resolved.error, /Cannot find host "10\.2\.0\.32"/);
  }
});

test("dedicated resume of quick-connect host uses session when vault list is empty", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  let openedSession: string | undefined;
  let startOptions: Record<string, unknown> | undefined;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => {
      throw new Error("must not dial vault for missing host");
    },
    openSftpForSession: async (sessionId: string) => {
      openedSession = sessionId;
      return "session-sftp";
    },
    closeSftp: async () => {},
    statLocal: async () => ({ size: 100, lastModified: 123 }),
    startStreamTransfer: async (options: Record<string, unknown>) => {
      startOptions = options;
      return { transferId: "qc-resume" };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "qc-resume",
      fileName: "ChatGPT.dmg",
      sourcePath: "/local/ChatGPT.dmg",
      targetPath: "/remote/ChatGPT.dmg",
      sourceConnectionId: "local",
      targetConnectionId: "term-sess-1",
      targetHostId: "quick-1",
      targetHostLabel: "10.2.0.32",
      direction: "upload",
      status: "paused",
      totalBytes: 100,
      transferredBytes: 4,
      checkpointBytes: 4,
      speed: 0,
      startTime: 1,
      isDirectory: false,
      reconnectRequired: true,
    }, {
      hosts: [],
      keys: [],
      identities: [],
    });
    assert.equal(result.success, true, result.error);
    assert.equal(openedSession, "term-sess-1");
    assert.equal(startOptions?.targetSftpId, "session-sftp");
    assert.equal(startOptions?.checkpointBytes, 4);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("hard resume with vault host + live session reuses session transport (not cold dedicated dial)", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  let openSftpCalls = 0;
  let openForSessionCalls = 0;
  let openSftpOpts: { reuseTransport?: boolean } | undefined;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async (options: { reuseTransport?: boolean }) => {
      openSftpCalls += 1;
      openSftpOpts = options;
      return "unexpected-cold-sftp";
    },
    openSftpForSession: async (sessionId: string) => {
      openForSessionCalls += 1;
      assert.equal(sessionId, "term-alive");
      return "shared-sftp";
    },
    closeSftp: async () => {},
    statLocal: async () => ({ size: 50, lastModified: 1 }),
    startStreamTransfer: async (options: { targetSftpId?: string }) => {
      assert.equal(options.targetSftpId, "shared-sftp");
      return { transferId: "shared-resume" };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "shared-resume",
      fileName: "file.bin",
      sourcePath: "/local/file.bin",
      targetPath: "/remote/file.bin",
      sourceConnectionId: "local",
      targetConnectionId: "term-alive",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 50,
      transferredBytes: 10,
      checkpointBytes: 10,
      speed: 0,
      startTime: 1,
      isDirectory: false,
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")],
      keys: [],
      identities: [],
    });
    assert.equal(result.success, true, result.error);
    assert.equal(openForSessionCalls, 1, "must open on the live terminal transport");
    assert.equal(openSftpCalls, 0, "must not cold-dial a dedicated SSH connection");
    assert.equal(openSftpOpts, undefined);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("classifyDedicatedResumeEndpoints detects download, upload, and remote-to-remote", () => {
  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "download",
    sourceHostId: "h1",
    targetConnectionId: "local",
  }), { isDownload: true, isUpload: false, isRemoteToRemote: false });

  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "upload",
    targetHostId: "h1",
    sourceConnectionId: "local",
  }), { isDownload: false, isUpload: true, isRemoteToRemote: false });

  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "remote-to-remote",
    sourceHostId: "a",
    targetHostId: "b",
  }), { isDownload: false, isUpload: false, isRemoteToRemote: true });

  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "download",
    sourceHostId: "a",
    targetHostId: "b",
    sourceConnectionId: "s1",
    targetConnectionId: "s2",
  }), { isDownload: false, isUpload: false, isRemoteToRemote: true });
});

test("directory resume skips completed children and matches by path", () => {
  const children = [
    {
      id: "c1",
      status: "completed" as const,
      sourcePath: "/remote/a.txt",
      targetPath: "/local/a.txt",
      checkpointBytes: 10,
      transferredBytes: 10,
      totalBytes: 10,
    },
    {
      id: "c2",
      status: "interrupted" as const,
      sourcePath: "/remote/b.txt",
      targetPath: "/local/b.txt",
      checkpointBytes: 4,
      transferredBytes: 4,
      totalBytes: 20,
    },
  ];

  assert.equal(
    shouldSkipCompletedResumeChild(findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/a.txt",
      targetPath: "/local/a.txt",
    })),
    true,
  );
  assert.equal(
    shouldSkipCompletedResumeChild(findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/b.txt",
      targetPath: "/local/b.txt",
    })),
    false,
  );
  assert.equal(
    findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/b.txt",
      targetPath: "/local/b.txt",
    })?.checkpointBytes,
    4,
  );
  assert.equal(
    findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/missing.txt",
      targetPath: "/local/missing.txt",
    }),
    null,
  );
  // Ambiguous OR match must not win: two children share sourcePath different targets.
  const ambiguous = [
    { id: "x", status: "interrupted" as const, sourcePath: "/s/a", targetPath: "/t/1", checkpointBytes: 1, transferredBytes: 1, totalBytes: 10 },
    { id: "y", status: "interrupted" as const, sourcePath: "/s/a", targetPath: "/t/2", checkpointBytes: 2, transferredBytes: 2, totalBytes: 10 },
  ];
  assert.equal(
    findPersistedChildForResumeFile(ambiguous, { sourcePath: "/s/a", targetPath: "/t/other" }),
    null,
  );
  assert.equal(
    findPersistedChildForResumeFile(ambiguous, { sourcePath: "/s/a", targetPath: "/t/2" })?.id,
    "y",
  );
  const legacyWrongTarget = [{
    id: "legacy",
    status: "completed" as const,
    sourcePath: "/s/only",
    targetPath: "/t/folder/folder/only",
    checkpointBytes: 10,
    transferredBytes: 10,
    totalBytes: 10,
  }];
  assert.equal(
    findPersistedChildForResumeFile(legacyWrongTarget, {
      sourcePath: "/s/only",
      targetPath: "/t/folder/only",
    }),
    null,
    "a completed child at an obsolete target must be retransferred to the corrected target",
  );
  assert.equal(
    createPersistedResumeChildLookup(legacyWrongTarget)({
      sourcePath: "/s/only",
      targetPath: "/t/folder/only",
    }),
    null,
  );
});

test("directory parent classification stays distinct from single-file downloads", () => {
  const parent = {
    direction: "download" as const,
    sourceHostId: "h1",
    targetConnectionId: "local",
    isDirectory: true,
  } satisfies Pick<TransferTask, "direction" | "sourceHostId" | "targetConnectionId" | "isDirectory">;
  assert.equal(parent.isDirectory, true);
  assert.equal(classifyDedicatedResumeEndpoints(parent).isDownload, true);
});

test("classifyResumeSourceValidationError maps size vs modified vs fatal", () => {
  assert.equal(classifyResumeSourceValidationError(null).kind, "ok");
  assert.equal(classifyResumeSourceValidationError("Source size changed while the transfer was paused").kind, "restart");
  assert.equal(classifyResumeSourceValidationError("Saved checkpoint is beyond the current source size").kind, "restart");
  assert.equal(classifyResumeSourceValidationError("Source was modified while the transfer was paused").kind, "modified");
  assert.equal(classifyResumeSourceValidationError("Source is unavailable").kind, "fatal");
});

test("dedicated session open gate limits concurrent dials", async () => {
  resetDedicatedSessionOpenGateForTests();
  assert.equal(MAX_CONCURRENT_DEDICATED_SESSION_OPENS, 2);

  let inFlight = 0;
  let peak = 0;
  const work = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
  };

  await Promise.all([
    withDedicatedSessionOpenSlot(work),
    withDedicatedSessionOpenSlot(work),
    withDedicatedSessionOpenSlot(work),
    withDedicatedSessionOpenSlot(work),
  ]);

  assert.ok(peak <= MAX_CONCURRENT_DEDICATED_SESSION_OPENS, `peak open slots ${peak}`);
  resetDedicatedSessionOpenGateForTests();
});

test("single-file restart resume continues from checkpoint without page callbacks", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  let startOptions: Record<string, unknown> | undefined;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    statLocal: async () => ({ size: 100, lastModified: 123 }),
    startStreamTransfer: async function (options: Record<string, unknown>) {
      assert.equal(arguments.length, 1);
      startOptions = options;
      return { transferId: "file-restart" };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "file-restart",
      fileName: "file.bin",
      sourcePath: "/local/file.bin",
      targetPath: "/remote/file.bin",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 100,
      transferredBytes: 20,
      checkpointBytes: 20,
      speed: 0,
      startTime: 1,
      isDirectory: false,
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")],
      keys: [],
      identities: [],
    });

    assert.equal(result.success, true, result.error);
    assert.equal(startOptions?.checkpointBytes, 20);
    assert.equal(startOptions?.skipAdmission, true);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder restart resume reports file-count progress without child page callbacks", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const parentProgress: number[] = [];
  const childUpdates: TransferTask[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => [
      { localPath: "/local/folder/a.bin", relativePath: "a.bin", type: "file", size: 10, lastModified: 1 },
      { localPath: "/local/folder/b.bin", relativePath: "b.bin", type: "file", size: 20, lastModified: 2 },
    ],
    mkdirSftp: async () => {},
    statLocal: async (path: string) => ({ size: path.endsWith("a.bin") ? 10 : 20 }),
    startStreamTransfer: async function (options: { transferId: string; totalBytes?: number }) {
      assert.equal(arguments.length, 1);
      return { transferId: options.transferId };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "folder-restart",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/folder",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 2,
      transferredBytes: 0,
      checkpointBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")],
      keys: [],
      identities: [],
    }, (value) => parentProgress.push(value.transferred), {
      children: [],
      onChildUpdate: (child) => childUpdates.push(child),
    });

    assert.equal(result.success, true, result.error);
    assert.equal(parentProgress.at(-1), 2);
    assert.ok(childUpdates.some((child) => child.status === "transferring"));
    assert.equal(childUpdates.filter((child) => child.status === "completed").length, 2);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder upload restart honors the real local-tree root and recreates empty directories", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const createdDirectories: string[] = [];
  const startedTargets: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    // Real localFsBridge contract prefixes every relativePath with rootName.
    listLocalTree: async () => [
      { localPath: "/local/folder", relativePath: "folder", type: "directory", size: 0, lastModified: 1 },
      { localPath: "/local/folder/empty", relativePath: "folder/empty", type: "directory", size: 0, lastModified: 1 },
      { localPath: "/local/folder/nested", relativePath: "folder/nested", type: "directory", size: 0, lastModified: 1 },
      { localPath: "/local/folder/nested/a.bin", relativePath: "folder/nested/a.bin", type: "file", size: 10, lastModified: 2 },
    ],
    mkdirSftp: async (_id: string, remotePath: string) => { createdDirectories.push(remotePath); },
    statLocal: async () => ({ size: 10, lastModified: 2 }),
    startStreamTransfer: async (options: { targetPath: string; transferId: string }) => {
      startedTargets.push(options.targetPath);
      return { transferId: options.transferId };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "real-local-tree-contract",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/folder",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 1,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")],
      keys: [],
      identities: [],
    });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(startedTargets, ["/remote/folder/nested/a.bin"]);
    assert.ok(createdDirectories.includes("/remote/folder/empty"));
    assert.ok(createdDirectories.includes("/remote/folder/nested"));
    assert.equal(createdDirectories.includes("/remote/folder/folder"), false);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder download restart recreates nested empty remote directories", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const createdDirectories: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async (_id: string, remotePath: string) => remotePath === "/remote/folder"
      ? [{ name: "empty", type: "directory", size: 0 }]
      : [],
    mkdirLocal: async (localPath: string) => { createdDirectories.push(localPath); },
    startStreamTransfer: async () => { throw new Error("empty tree must not start a file stream"); },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "remote-empty-directory",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/folder",
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, true, result.error);
    assert.ok(createdDirectories.includes("/local/folder"));
    assert.ok(createdDirectories.includes("/local/folder/empty"));
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder download restart skips a symlink directory cycle by canonical path", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const listedPaths: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    realpathSftp: async () => "/remote/folder",
    listSftp: async (_id: string, remotePath: string) => {
      listedPaths.push(remotePath);
      return [{ name: "loop", type: "symlink", linkTarget: "directory", size: 0 }];
    },
    mkdirLocal: async () => {},
    startStreamTransfer: async () => { throw new Error("cycle must not start a stream"); },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "remote-directory-cycle",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/folder",
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(listedPaths, ["/remote/folder"]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder download restart stops remote discovery as soon as cancellation is observed", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  let cancelled = false;
  const listedPaths: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async (_id: string, remotePath: string) => {
      listedPaths.push(remotePath);
      cancelled = true;
      return remotePath === "/remote/folder"
        ? [{ name: "nested", type: "directory", size: 0 }]
        : [];
    },
    mkdirLocal: async () => {
      throw new Error("cancelled discovery must not create destination directories");
    },
    startStreamTransfer: async () => {
      throw new Error("cancelled discovery must not start file transfers");
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "cancel-directory-discovery",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/folder",
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      shouldAbort: () => cancelled,
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /cancelled/i);
    assert.deepEqual(listedPaths, ["/remote/folder"]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder download restart rejects a Windows backslash traversal entry", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  let starts = 0;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async () => [{ name: "..\\outside.txt", type: "file", size: 10 }],
    mkdirLocal: async () => {},
    startStreamTransfer: async () => {
      starts += 1;
      return { transferId: "unsafe" };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "unsafe-remote-name",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "C:\\Users\\alice\\Downloads\\folder",
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 1,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /unsafe transfer path/i);
    assert.equal(starts, 0);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("folder restart skips 50,000 compacted completions without rebuilding child tasks", async (t) => {
  const resumeStartedAt = Date.now();
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "16", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const entries = Array.from({ length: 50_000 }, (_, index) => ({
    localPath: `/local/folder/file-${index.toString().padStart(5, "0")}.bin`,
    relativePath: `file-${index.toString().padStart(5, "0")}.bin`,
    type: "file" as const,
    size: index + 1,
    lastModified: index + 10,
  }));
  const checkpoint = createEmptyDirectoryResumeCheckpoint();
  const manifest = createDirectoryManifestAccumulator(checkpoint);
  for (const entry of entries) {
    manifest.append(createDirectoryEntryIdentity({
      sourcePath: entry.localPath,
      targetPath: `/remote/folder/${entry.relativePath}`,
      size: entry.size,
      lastModified: entry.lastModified,
    }));
    checkpoint.coveredEntries += 1;
    checkpoint.completedEntries += 1;
  }
  checkpoint.manifestHash = manifest.digest();

  const originalGet = netcattyBridge.get;
  let starts = 0;
  let childUpdates = 0;
  let eventLoopHeartbeats = 0;
  const heartbeat = setInterval(() => { eventLoopHeartbeats += 1; }, 1);
  t.after(() => clearInterval(heartbeat));
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => entries,
    mkdirSftp: async () => {},
    startStreamTransfer: async () => {
      starts += 1;
      return { transferId: "unexpected" };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "huge-folder-restart",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/folder",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 50_000,
      transferredBytes: 50_000,
      checkpointBytes: 50_000,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
      directoryResumeCheckpoint: checkpoint,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")],
      keys: [],
      identities: [],
    }, undefined, {
      children: [],
      onChildUpdate: () => { childUpdates += 1; },
    });

    assert.equal(result.success, true, result.error);
    assert.equal(
      eventLoopHeartbeats >= 5,
      true,
      "50k indexing and manifest validation must yield repeatedly to the renderer event loop",
    );
    assert.equal(starts, 0, "validated compact completions must not retransfer");
    assert.equal(childUpdates, 0, "compacted completions must not return to the task array");
    assert.ok(Date.now() - resumeStartedAt < 5_000, "50k resume validation should finish within 5 seconds");
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("a validated version 1 directory checkpoint migrates to the faster manifest", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const entry = {
    localPath: "/local/folder/a.bin",
    relativePath: "a.bin",
    type: "file" as const,
    size: 10,
    lastModified: 1,
  };
  const identity = createDirectoryEntryIdentity({
    sourcePath: entry.localPath,
    targetPath: "/remote/folder/a.bin",
    size: entry.size,
    lastModified: entry.lastModified,
  });
  const legacyCheckpoint = {
    version: 1 as const,
    coveredEntries: 1,
    completedEntries: 1,
    manifestHash: appendDirectoryManifestIdentity("0".repeat(64), identity),
  };
  const originalGet = netcattyBridge.get;
  let starts = 0;
  const checkpointUpdates: Array<TransferTask["directoryResumeCheckpoint"]> = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => [entry],
    mkdirSftp: async () => {},
    startStreamTransfer: async () => {
      starts += 1;
      return { transferId: "unexpected" };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "legacy-folder-restart",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/folder",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 1,
      transferredBytes: 1,
      checkpointBytes: 1,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
      directoryResumeCheckpoint: legacyCheckpoint,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      children: [],
      onDirectoryCheckpointUpdate: (checkpoint) => checkpointUpdates.push(checkpoint),
    });

    assert.equal(result.success, true, result.error);
    assert.equal(starts, 0, "a compatible legacy checkpoint must still skip completed data");
    assert.equal(checkpointUpdates.length, 1);
    assert.equal(checkpointUpdates[0]?.version, 2);
    assert.equal(checkpointUpdates[0]?.coveredEntries, 1);
    assert.equal(checkpointUpdates[0]?.completedEntries, 1);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("out-of-order compact resume transfers index 0 and skips completed index 1", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const entries = [
    { localPath: "/local/folder/a.bin", relativePath: "a.bin", type: "file" as const, size: 10, lastModified: 1 },
    { localPath: "/local/folder/b.bin", relativePath: "b.bin", type: "file" as const, size: 20, lastModified: 2 },
  ];
  const identities = entries.map((entry) => createDirectoryEntryIdentity({
    sourcePath: entry.localPath,
    targetPath: `/remote/folder/${entry.relativePath}`,
    size: entry.size,
    lastModified: entry.lastModified,
  }));
  const checkpoint = createEmptyDirectoryResumeCheckpoint();
  for (const identity of identities) {
    checkpoint.manifestHash = appendDirectoryCheckpointIdentity(checkpoint, identity);
    checkpoint.coveredEntries += 1;
  }
  checkpoint.completedEntries = 1;

  const originalGet = netcattyBridge.get;
  const startedPaths: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => entries,
    mkdirSftp: async () => {},
    statLocal: async (path: string) => ({ size: path.endsWith("a.bin") ? 10 : 20, lastModified: path.endsWith("a.bin") ? 1 : 2 }),
    startStreamTransfer: async (options: { sourcePath: string; transferId: string }) => {
      startedPaths.push(options.sourcePath);
      return { transferId: options.transferId };
    },
  });
  try {
    const parent: TransferTask = {
      id: "out-of-order-parent",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/folder",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 2,
      transferredBytes: 1,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
      directoryResumeCheckpoint: checkpoint,
    };
    const result = await resumeTransferWithDedicatedSession(parent, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      children: [{
        ...parent,
        id: "unfinished-index-0",
        fileName: "a.bin",
        sourcePath: entries[0].localPath,
        targetPath: "/remote/folder/a.bin",
        parentTaskId: parent.id,
        isDirectory: false,
        status: "interrupted",
        totalBytes: 10,
        directoryEntryIndex: 0,
        directoryEntryIdentity: identities[0],
      }],
    });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(startedPaths, ["/local/folder/a.bin"]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("changed directory manifest clears compact completion state and retransfers safely", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalEntries = [
    { localPath: "/local/folder/a.bin", relativePath: "a.bin", type: "file" as const, size: 10, lastModified: 1 },
    { localPath: "/local/folder/b.bin", relativePath: "b.bin", type: "file" as const, size: 20, lastModified: 2 },
  ];
  const checkpoint = createEmptyDirectoryResumeCheckpoint();
  for (const entry of originalEntries) {
    checkpoint.manifestHash = appendDirectoryCheckpointIdentity(checkpoint, createDirectoryEntryIdentity({
      sourcePath: entry.localPath,
      targetPath: `/remote/folder/${entry.relativePath}`,
      size: entry.size,
      lastModified: entry.lastModified,
    }));
    checkpoint.coveredEntries += 1;
    checkpoint.completedEntries += 1;
  }
  const changedEntries = originalEntries.map((entry, index) => index === 1
    ? { ...entry, lastModified: 99 }
    : entry);
  const originalGet = netcattyBridge.get;
  const startedPaths: string[] = [];
  const startedCheckpoints = new Map<string, { checkpointBytes?: number; sourceFingerprint?: string }>();
  const checkpointUpdates: Array<TransferTask["directoryResumeCheckpoint"]> = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => changedEntries,
    mkdirSftp: async () => {},
    statLocal: async (path: string) => {
      const entry = changedEntries.find((candidate) => candidate.localPath === path)!;
      return { size: entry.size, lastModified: entry.lastModified };
    },
    startStreamTransfer: async (options: { sourcePath: string; transferId: string; checkpointBytes?: number; sourceFingerprint?: string }) => {
      startedPaths.push(options.sourcePath);
      startedCheckpoints.set(options.sourcePath, {
        checkpointBytes: options.checkpointBytes,
        sourceFingerprint: options.sourceFingerprint,
      });
      return { transferId: options.transferId };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "changed-parent",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/folder",
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      targetHostLabel: "box",
      direction: "upload",
      status: "interrupted",
      totalBytes: 2,
      transferredBytes: 2,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
      directoryResumeCheckpoint: checkpoint,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      children: [{
        id: "old-completed-b",
        fileName: "b.bin",
        sourcePath: "/local/folder/b.bin",
        targetPath: "/remote/folder/b.bin",
        sourceConnectionId: "local",
        targetConnectionId: "old-sftp",
        targetHostId: "h1",
        direction: "upload",
        status: "completed",
        totalBytes: 20,
        transferredBytes: 20,
        checkpointBytes: 20,
        sourceFingerprint: "sha256:old-b",
        speed: 0,
        startTime: 1,
        endTime: 2,
        isDirectory: false,
        parentTaskId: "changed-parent",
        directoryEntryIndex: 1,
        directoryEntryIdentity: createDirectoryEntryIdentity({
          sourcePath: "/local/folder/b.bin",
          targetPath: "/remote/folder/b.bin",
          size: 20,
          lastModified: 2,
        }),
      }],
      onDirectoryCheckpointUpdate: (value) => checkpointUpdates.push(value),
    });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(startedPaths.sort(), changedEntries.map((entry) => entry.localPath).sort());
    assert.deepEqual(startedCheckpoints.get("/local/folder/b.bin"), {
      checkpointBytes: 0,
      sourceFingerprint: undefined,
    });
    assert.deepEqual(checkpointUpdates, [undefined]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("changed replace-directory manifest rebuilds the stage before promotion", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const operations: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async (_id: string, remotePath: string) => remotePath === "/remote/folder"
      ? [{ name: "new.txt", type: "file", size: 10, lastModified: 2 }]
      : [],
    mkdirLocal: async (localPath: string) => { operations.push(`mkdir:${localPath}`); },
    statLocal: async (localPath: string) => {
      if (localPath === "/local/final.netcatty-replace-parent.part") {
        return { type: "directory", size: 0, lastModified: 1 };
      }
      return null;
    },
    statSftp: async () => ({ type: "file", size: 10, lastModified: 2 }),
    deleteLocalFile: async (localPath: string) => { operations.push(`delete:${localPath}`); },
    renameLocalFile: async (source: string, target: string) => {
      operations.push(`rename:${source}->${target}`);
      if (source === "/local/final") throw new Error("ENOENT");
    },
    startStreamTransfer: async (options: { transferId: string }) => {
      operations.push("start");
      return { transferId: options.transferId };
    },
  });
  try {
    const stage = "/local/final.netcatty-replace-parent.part";
    const result = await resumeTransferWithDedicatedSession({
      id: "replace-parent",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/final",
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 1,
      transferredBytes: 1,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
      directoryResumeCheckpoint: {
        version: 1,
        coveredEntries: 1,
        completedEntries: 1,
        manifestHash: "a".repeat(64),
      },
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, true, result.error);
    const resetIndex = operations.indexOf(`delete:${stage}`);
    const startIndex = operations.indexOf("start");
    assert.ok(resetIndex >= 0, `stage was not reset: ${operations.join(", ")}`);
    assert.ok(resetIndex < startIndex, `stage reset must precede transfer: ${operations.join(", ")}`);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("local replace retries transient old-directory backup cleanup failures", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const stage = "/local/final.netcatty-local-cleanup.part";
  const backup = "/local/final.netcatty-local-cleanup.backup";
  const updates: TransferTask[] = [];
  let backupDeleteAttempts = 0;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async () => [],
    statLocal: async (localPath: string) => localPath === stage
      ? { type: "directory", size: 0, lastModified: 1 }
      : null,
    mkdirLocal: async () => {},
    deleteLocalFile: async (localPath: string) => {
      if (localPath === backup) {
        backupDeleteAttempts += 1;
        if (backupDeleteAttempts < 3) throw new Error("backup busy");
      }
    },
    renameLocalFile: async () => {},
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "local-cleanup",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/final",
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      onChildUpdate: (update) => updates.push(update),
    });

    assert.equal(result.success, true, result.error);
    assert.equal(backupDeleteAttempts, 3);
    assert.equal(updates.at(-1)?.stagedTargetPath, undefined);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("local replace removes a stale transfer backup before promoting a rebuilt stage", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-replace-stale-backup-"));
  const target = path.join(root, "final");
  const stage = `${target}.netcatty-stale-backup.part`;
  const backup = `${target}.netcatty-stale-backup.backup`;
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.writeFile(path.join(target, "current.txt"), "current");
  await fs.promises.mkdir(stage, { recursive: true });
  await fs.promises.mkdir(backup, { recursive: true });
  await fs.promises.writeFile(path.join(backup, "old.txt"), "old");
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async () => [],
    statLocal: async (localPath: string) => {
      try {
        const stat = await fs.promises.stat(localPath);
        return { type: stat.isDirectory() ? "directory" : "file", size: stat.size, lastModified: stat.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    mkdirLocal: async (localPath: string) => { await fs.promises.mkdir(localPath, { recursive: true }); },
    deleteLocalFile: async (localPath: string) => { await fs.promises.rm(localPath, { recursive: true }); },
    renameLocalFile: async (source: string, destination: string) => {
      await fs.promises.rename(source, destination);
    },
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "stale-backup",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: target,
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, true, result.error);
    await assert.rejects(fs.promises.stat(backup), { code: "ENOENT" });
    assert.equal((await fs.promises.stat(target)).isDirectory(), true);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("local replace restores the only backup before retrying a failed promote", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const target = "/local/final";
  const stage = `${target}.netcatty-recover-backup.part`;
  const backup = `${target}.netcatty-recover-backup.backup`;
  const existing = new Set([stage, backup]);
  const operations: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async () => [],
    statLocal: async (localPath: string) => existing.has(localPath)
      ? { type: "directory", size: 0, lastModified: 1 }
      : null,
    mkdirLocal: async (localPath: string) => { existing.add(localPath); },
    deleteLocalFile: async (localPath: string) => {
      operations.push(`delete:${localPath}`);
      existing.delete(localPath);
    },
    renameLocalFile: async (source: string, destination: string) => {
      operations.push(`rename:${source}->${destination}`);
      if (!existing.has(source)) throw new Error(`ENOENT: ${source}`);
      if (existing.has(destination)) throw new Error(`EEXIST: ${destination}`);
      existing.delete(source);
      existing.add(destination);
    },
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "recover-backup",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: target,
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, true, result.error);
    const restoreIndex = operations.indexOf(`rename:${backup}->${target}`);
    const firstBackupDeleteIndex = operations.indexOf(`delete:${backup}`);
    assert.ok(restoreIndex >= 0, operations.join(", "));
    assert.ok(
      firstBackupDeleteIndex < 0 || restoreIndex < firstBackupDeleteIndex,
      `the only backup must be restored before deletion: ${operations.join(", ")}`,
    );
    assert.equal(existing.has(target), true);
    assert.equal(existing.has(backup), false);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("remote replace stays retryable when old-directory backup cleanup keeps failing", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const stage = "/remote/final.netcatty-remote-cleanup.part";
  const backup = "/remote/final.netcatty-remote-cleanup.backup";
  const updates: TransferTask[] = [];
  let backupDeleteAttempts = 0;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => [{
      localPath: "/local/folder",
      relativePath: "folder",
      type: "directory",
      size: 0,
      lastModified: 1,
    }],
    statSftp: async (_sftpId: string, remotePath: string) => remotePath === stage
      ? { type: "directory", size: 0, lastModified: 1 }
      : null,
    mkdirSftp: async () => {},
    deleteSftp: async (_sftpId: string, remotePath: string) => {
      if (remotePath === backup) {
        backupDeleteAttempts += 1;
        throw new Error("backup busy");
      }
    },
    renameSftp: async () => {},
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "remote-cleanup",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: "/remote/final",
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      direction: "upload",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      onChildUpdate: (update) => updates.push(update),
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /backup busy/i);
    assert.equal(backupDeleteAttempts, 3);
    assert.equal(
      updates.some((update) => update.id === "remote-cleanup" && update.stagedTargetPath === undefined),
      false,
    );
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("local replace does not publish the stage when backing up the target fails", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const target = "/local/final";
  const stage = `${target}.netcatty-local-backup-denied.part`;
  const backup = `${target}.netcatty-local-backup-denied.backup`;
  const renames: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async () => [],
    statLocal: async (localPath: string) => (
      localPath === target || localPath === stage
        ? { type: "directory", size: 0, lastModified: 1 }
        : null
    ),
    mkdirLocal: async () => {},
    deleteLocalFile: async () => {},
    renameLocalFile: async (source: string, destination: string) => {
      renames.push(`${source}->${destination}`);
      if (source === target && destination === backup) {
        const error = new Error("EACCES: permission denied");
        (error as NodeJS.ErrnoException).code = "EACCES";
        throw error;
      }
    },
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "local-backup-denied",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: target,
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /permission denied/i);
    assert.deepEqual(renames, [`${target}->${backup}`]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("remote replace does not publish the stage when backing up the target fails", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const target = "/remote/final";
  const stage = `${target}.netcatty-remote-backup-denied.part`;
  const backup = `${target}.netcatty-remote-backup-denied.backup`;
  const renames: string[] = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listLocalTree: async () => [{
      localPath: "/local/folder",
      relativePath: "folder",
      type: "directory",
      size: 0,
      lastModified: 1,
    }],
    statSftp: async (_sftpId: string, remotePath: string) => (
      remotePath === target || remotePath === stage
        ? { type: "directory", size: 0, lastModified: 1 }
        : null
    ),
    mkdirSftp: async () => {},
    deleteSftp: async () => {},
    renameSftp: async (_sftpId: string, source: string, destination: string) => {
      renames.push(`${source}->${destination}`);
      if (source === target && destination === backup) {
        const error = new Error("EACCES: permission denied");
        (error as NodeJS.ErrnoException).code = "EACCES";
        throw error;
      }
    },
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "remote-backup-denied",
      fileName: "folder",
      sourcePath: "/local/folder",
      targetPath: target,
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "local",
      targetConnectionId: "old-sftp",
      targetHostId: "h1",
      direction: "upload",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /permission denied/i);
    assert.deepEqual(renames, [`${target}->${backup}`]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("valid file checkpoint still rebuilds a replace stage so deleted empty directories cannot survive", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  const stage = "/local/final.netcatty-exact-replace.part";
  const entry = { name: "kept.txt", type: "file", size: 10, lastModified: 2 } as const;
  const identity = createDirectoryEntryIdentity({
    sourcePath: "/remote/folder/kept.txt",
    targetPath: `${stage}/kept.txt`,
    size: 10,
    lastModified: 2,
  });
  const checkpoint = createEmptyDirectoryResumeCheckpoint();
  checkpoint.manifestHash = appendDirectoryCheckpointIdentity(checkpoint, identity);
  checkpoint.coveredEntries = 1;
  checkpoint.completedEntries = 1;
  const operations: string[] = [];
  const checkpointUpdates: Array<TransferTask["directoryResumeCheckpoint"]> = [];
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async (_id: string, remotePath: string) => remotePath === "/remote/folder" ? [entry] : [],
    mkdirLocal: async () => {},
    statLocal: async () => ({ type: "directory", size: 0, lastModified: 1 }),
    statSftp: async () => ({ type: "file", size: 10, lastModified: 2 }),
    deleteLocalFile: async () => { operations.push("reset-stage"); },
    renameLocalFile: async (source: string) => {
      if (source === "/local/final") throw new Error("ENOENT");
    },
    startStreamTransfer: async (options: { transferId: string }) => {
      operations.push("retransfer-file");
      return { transferId: options.transferId };
    },
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "exact-replace",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/final",
      stagedTargetPath: stage,
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 1,
      transferredBytes: 1,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
      directoryResumeCheckpoint: checkpoint,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    }, undefined, {
      onDirectoryCheckpointUpdate: (value) => checkpointUpdates.push(value),
    });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(operations.slice(0, 2), ["reset-stage", "retransfer-file"]);
    assert.deepEqual(checkpointUpdates, [undefined]);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

test("corrupted replace-stage history cannot delete an unrelated directory", async (t) => {
  resetDedicatedSessionOpenGateForTests();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "2", setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const originalGet = netcattyBridge.get;
  let deletes = 0;
  (netcattyBridge as { get: () => unknown }).get = () => ({
    openSftp: async () => "dedicated-sftp",
    closeSftp: async () => {},
    listSftp: async () => [],
    statLocal: async () => ({ type: "directory", size: 0, lastModified: 1 }),
    deleteLocalFile: async () => { deletes += 1; },
    mkdirLocal: async () => {},
    startStreamTransfer: async () => ({ transferId: "unexpected" }),
  });
  try {
    const result = await resumeTransferWithDedicatedSession({
      id: "safe-id",
      fileName: "folder",
      sourcePath: "/remote/folder",
      targetPath: "/local/final",
      stagedTargetPath: "/local/unrelated-important-directory",
      replaceExistingTarget: true,
      sourceConnectionId: "old-sftp",
      targetConnectionId: "local",
      sourceHostId: "h1",
      sourceHostLabel: "box",
      direction: "download",
      status: "interrupted",
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: 1,
      isDirectory: true,
      progressMode: "files",
      reconnectRequired: true,
    }, {
      hosts: [host("h1", "box", "1.2.3.4")], keys: [], identities: [],
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /unsafe replacement stage path/i);
    assert.equal(deletes, 0);
  } finally {
    (netcattyBridge as { get: typeof originalGet }).get = originalGet;
    resetDedicatedSessionOpenGateForTests();
  }
});

for (const scenario of ["deleted-id", "ambiguous-legacy-label"] as const) {
  test(`restart upload does not select a different server by ${scenario}`, async (t) => {
    const originalGet = netcattyBridge.get;
    t.after(() => { netcattyBridge.get = originalGet; });
    const opened: string[] = [];
    let uploads = 0;
    (netcattyBridge as { get: () => unknown }).get = () => ({
      openSftp: async (options: { hostname: string }) => { opened.push(options.hostname); return "new-channel"; },
      closeSftp: async () => {},
      statLocal: async () => ({ size: 100, lastModified: 123 }),
      startStreamTransfer: async () => { uploads++; return { transferId: "wrong-host-resume" }; },
    });
    const hosts = scenario === "deleted-id"
      ? [host("different-id", "production", "different.example")]
      : [host("first-id", "production", "first.example"), host("second-id", "production", "second.example")];
    const result = await resumeTransferWithDedicatedSession({
      id: "wrong-host-resume", fileName: "deployment.zip",
      sourcePath: "/fixture/deployment.zip", targetPath: "/srv/deployment.zip",
      sourceConnectionId: "local", targetConnectionId: "right-expired",
      targetHostId: scenario === "deleted-id" ? "deleted-original-id" : undefined,
      targetHostLabel: "production", direction: "upload", status: "interrupted",
      totalBytes: 100, transferredBytes: 20, checkpointBytes: 20,
      speed: 0, startTime: 1, isDirectory: false, reconnectRequired: true,
    }, {hosts, keys: [], identities: []});
    assert.equal(result.success, false, "resume must stop instead of selecting another endpoint by display name");
    assert.deepEqual(opened, [], "must not authenticate to an unproven replacement host");
    assert.equal(uploads, 0);
  });
}
