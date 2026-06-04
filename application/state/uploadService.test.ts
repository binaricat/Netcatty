import test from "node:test";
import assert from "node:assert/strict";

import {
  UploadController,
  startUploadScanningTask,
  uploadEntriesDirect,
  uploadFromDataTransfer,
  uploadFromFileList,
} from "../../lib/uploadService.ts";

function createDataTransfer(files: File[]): DataTransfer {
  return {
    items: { length: 0 },
    files,
  } as unknown as DataTransfer;
}

function createDataTransferWithNullEntries(files: File[]): DataTransfer {
  const items = files.map((file) => ({
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => null,
  }));
  return {
    items,
    files,
  } as unknown as DataTransfer;
}

test("upload scanning task can be shown and cancelled before transfers start", () => {
  const events: string[] = [];
  const scanningTask = startUploadScanningTask(
    {
      onScanningStart: (taskId) => events.push(`start:${taskId}`),
      onScanningEnd: (taskId) => events.push(`end:${taskId}`),
      onTaskCancelled: (taskId) => events.push(`cancel:${taskId}`),
    },
    "scan-folder-1",
  );

  assert.equal(scanningTask.isOpen(), true);
  scanningTask.cancel();
  scanningTask.complete();

  assert.equal(scanningTask.isOpen(), false);
  assert.deepEqual(events, ["start:scan-folder-1", "cancel:scan-folder-1"]);
});

test("clears the scanning placeholder when every dropped file is skipped by conflict resolution", async () => {
  const events: string[] = [];
  const file = new File(["local"], "conflict.txt", { lastModified: 1234 });

  const results = await uploadFromDataTransfer(
    createDataTransfer([file]),
    {
      targetPath: "/target",
      sftpId: null,
      isLocal: true,
      bridge: {
        mkdirSftp: async () => {},
        statLocal: async () => ({ type: "file", size: 10, lastModified: 1000 }),
        writeLocalFile: async () => {
          throw new Error("skipped conflicts should not upload");
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      callbacks: {
        onScanningStart: () => events.push("scan:start"),
        onScanningEnd: () => events.push("scan:end"),
        onTaskCreated: () => events.push("task:create"),
      },
      resolveConflict: async () => "skip",
    },
  );

  assert.deepEqual(results, [
    { fileName: "conflict.txt", success: false, cancelled: true },
  ]);
  assert.deepEqual(events, ["scan:start", "scan:end"]);
});

test("uploads DataTransfer files when entry extraction returns no entries", async () => {
  const file = new File(["picked"], "picked.txt", { lastModified: 1234 });
  const uploadedPaths: string[] = [];

  const results = await uploadFromDataTransfer(
    createDataTransferWithNullEntries([file]),
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        writeSftpBinary: async (_sftpId, path) => {
          uploadedPaths.push(path);
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
  );

  assert.deepEqual(uploadedPaths, ["/target/picked.txt"]);
  assert.deepEqual(results, [
    { fileName: "picked.txt", success: true },
  ]);
});

test("uploads picked folder files with their relative directory structure", async () => {
  const file = new File(["nested"], "file.txt", { lastModified: 1234 });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "folder/sub/file.txt",
  });
  const madeDirs: string[] = [];
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async (_sftpId, path) => {
          madeDirs.push(path);
        },
        writeSftpBinary: async (_sftpId, path) => {
          uploadedPaths.push(path);
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
  );

  assert.deepEqual(madeDirs, ["/target/folder", "/target/folder/sub"]);
  assert.deepEqual(uploadedPaths, ["/target/folder/sub/file.txt"]);
  assert.deepEqual(results, [
    { fileName: "folder/sub/file.txt", success: true },
  ]);
});

test("uploads path-backed clipboard files through stream transfer", async () => {
  const transfers: Array<{ sourcePath: string; targetPath: string; totalBytes?: number }> = [];
  const taskTotals: number[] = [];

  const results = await uploadEntriesDirect(
    [
      {
        file: null,
        localPath: "/Users/me/Desktop/report.txt",
        relativePath: "report.txt",
        isDirectory: false,
        size: 42,
      },
    ],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          transfers.push({
            sourcePath: payload.sourcePath,
            targetPath: payload.targetPath,
            totalBytes: payload.totalBytes,
          });
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      callbacks: {
        onTaskCreated: (task) => taskTotals.push(task.totalBytes),
      },
    },
  );

  assert.deepEqual(taskTotals, [42]);
  assert.deepEqual(transfers, [
    {
      sourcePath: "/Users/me/Desktop/report.txt",
      targetPath: "/target/report.txt",
      totalBytes: 42,
    },
  ]);
  assert.deepEqual(results, [
    { fileName: "report.txt", success: true },
  ]);
});

test("copies path-backed clipboard files into local panes through stream transfer", async () => {
  const transfers: Array<{ sourcePath: string; targetPath: string; targetType: string; totalBytes?: number }> = [];

  const results = await uploadEntriesDirect(
    [
      {
        file: null,
        localPath: "/Users/me/Desktop/report.txt",
        relativePath: "report.txt",
        isDirectory: false,
        size: 42,
      },
    ],
    {
      targetPath: "/target",
      sftpId: null,
      isLocal: true,
      bridge: {
        mkdirLocal: async () => {},
        startStreamTransfer: async (payload) => {
          transfers.push({
            sourcePath: payload.sourcePath,
            targetPath: payload.targetPath,
            targetType: payload.targetType,
            totalBytes: payload.totalBytes,
          });
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
  );

  assert.deepEqual(transfers, [
    {
      sourcePath: "/Users/me/Desktop/report.txt",
      targetPath: "/target/report.txt",
      targetType: "local",
      totalBytes: 42,
    },
  ]);
  assert.deepEqual(results, [
    { fileName: "report.txt", success: true },
  ]);
});

test("reports empty directory creation failures", async () => {
  const madeDirs: string[] = [];

  const results = await uploadEntriesDirect(
    [
      { file: null, relativePath: "folder", isDirectory: true },
      { file: null, relativePath: "folder/empty", isDirectory: true },
    ],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async (_sftpId, path) => {
          madeDirs.push(path);
          if (path.endsWith("/empty")) {
            throw new Error("permission denied");
          }
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
  );

  assert.deepEqual(madeDirs, ["/target/folder", "/target/folder/empty"]);
  assert.deepEqual(results, [
    { fileName: "folder/empty", success: false, error: "permission denied" },
  ]);
});

test("does not restart a direct upload that was already cancelled", async () => {
  const controller = new UploadController();
  await controller.cancel();
  let mkdirCalled = false;

  const results = await uploadEntriesDirect(
    [{ file: null, relativePath: "folder", isDirectory: true }],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {
          mkdirCalled = true;
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
    controller,
  );

  assert.equal(mkdirCalled, false);
  assert.deepEqual(results, [
    { fileName: "", success: false, cancelled: true },
  ]);
});
