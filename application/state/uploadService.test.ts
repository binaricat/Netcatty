import test, { type TestContext } from "node:test";
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

function installCompressedUploadBridge(
  t: TestContext,
  options: {
    supported?: boolean;
    onStart?: (payload: {
      compressionId: string;
      folderPath: string;
      targetPath: string;
      folderName: string;
    }) => void;
  } = {},
) {
  const previousWindow = globalThis.window;
  const previousNetcatty = previousWindow?.netcatty;
  const nextWindow = previousWindow ?? ({} as Window & typeof globalThis);
  nextWindow.netcatty = {
    ...previousNetcatty,
    getPathForFile: (file: File) => (file as File & { path?: string }).path,
    checkCompressedUploadSupport: async () => ({
      supported: options.supported !== false,
      localTar: true,
      remoteTar: options.supported !== false,
    }),
    startCompressedUpload: async (payload) => {
      options.onStart?.(payload);
      return { compressionId: payload.compressionId, success: true };
    },
  } as NetcattyBridge;
  Object.defineProperty(globalThis, "window", {
    value: nextWindow,
    writable: true,
    configurable: true,
  });
  t.after(() => {
    if (previousWindow) {
      previousWindow.netcatty = previousNetcatty;
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        writable: true,
        configurable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });
}

function createPickedFolderFile(): File {
  const file = new File(["folder payload"], "file.txt", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/docs/file.txt", writable: true });
  Object.defineProperty(file, "webkitRelativePath", { value: "docs/file.txt" });
  return file;
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
  Object.defineProperty(file, "path", { value: "/tmp/picked.txt" });
  const uploadedPaths: string[] = [];

  const results = await uploadFromDataTransfer(
    createDataTransferWithNullEntries([file]),
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async ({ targetPath }) => {
          uploadedPaths.push(targetPath);
          return { transferId: "picked-transfer" };
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
  Object.defineProperty(file, "path", { value: "/tmp/folder/sub/file.txt" });
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
        startStreamTransfer: async ({ targetPath }) => {
          uploadedPaths.push(targetPath);
          return { transferId: "folder-transfer" };
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

test("compression remains enabled for DataTransfer folder uploads that have a conflict resolver", async (t) => {
  const starts: string[] = [];
  installCompressedUploadBridge(t, {
    onStart: (payload) => starts.push(`${payload.folderName}:${payload.folderPath}`),
  });
  let conflictCalls = 0;
  let streamCalls = 0;
  const file = createPickedFolderFile();

  const results = await uploadFromDataTransfer(
    createDataTransferWithNullEntries([file]),
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async () => null,
        startStreamTransfer: async (payload) => {
          streamCalls += 1;
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      useCompressedUpload: true,
      resolveConflict: async () => {
        conflictCalls += 1;
        return "merge";
      },
    },
  );

  assert.deepEqual(starts, ["docs:/local/docs"]);
  assert.equal(conflictCalls, 0);
  assert.equal(streamCalls, 0);
  assert.deepEqual(results, [{ fileName: "docs", success: true }]);
});

test("compression remains enabled for picked-folder uploads that have a conflict resolver", async (t) => {
  let compressedStarts = 0;
  installCompressedUploadBridge(t, {
    onStart: () => { compressedStarts += 1; },
  });
  let streamCalls = 0;
  const results = await uploadFromFileList(
    [createPickedFolderFile()],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async () => null,
        startStreamTransfer: async (payload) => {
          streamCalls += 1;
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      useCompressedUpload: true,
      resolveConflict: async () => "merge",
    },
  );

  assert.equal(compressedStarts, 1);
  assert.equal(streamCalls, 0);
  assert.deepEqual(results, [{ fileName: "docs", success: true }]);
});

test("compressed folder conflict decisions preserve merge, replace, and fallback semantics", async (t) => {
  let supported = true;
  let compressedStarts = 0;
  installCompressedUploadBridge(t, {
    get supported() { return supported; },
    onStart: () => { compressedStarts += 1; },
  });
  const entry = {
    file: createPickedFolderFile(),
    relativePath: "docs/file.txt",
    isDirectory: false,
  };

  let conflictCalls = 0;
  const merged = await uploadEntriesDirect(
    [entry],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async () => ({ type: "directory", size: 0, lastModified: 1000 }),
      },
      joinPath: (base, name) => `${base}/${name}`,
      useCompressedUpload: true,
      resolveConflict: async () => {
        conflictCalls += 1;
        return "merge";
      },
    },
  );
  assert.equal(compressedStarts, 1, "directory merge should retain atomic compressed upload");
  assert.equal(conflictCalls, 1);
  assert.deepEqual(merged, [{ fileName: "docs", success: true }]);

  let exists = true;
  let deletes = 0;
  let streams = 0;
  conflictCalls = 0;
  const replaced = await uploadEntriesDirect(
    [entry],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async (_sftpId, path) => (
          path === "/remote/docs" && exists
            ? { type: "directory", size: 0, lastModified: 1000 }
            : null
        ),
        deleteSftp: async () => { exists = false; deletes += 1; },
        startStreamTransfer: async (payload) => {
          streams += 1;
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      useCompressedUpload: true,
      resolveConflict: async () => {
        conflictCalls += 1;
        return "replace";
      },
    },
  );
  assert.equal(compressedStarts, 1, "replace stays on the regular path");
  assert.equal(conflictCalls, 1, "a pre-resolved conflict must not prompt twice");
  assert.equal(deletes, 1);
  assert.equal(streams, 1);
  assert.equal(replaced[0]?.success, true);

  supported = false;
  conflictCalls = 0;
  streams = 0;
  const fallback = await uploadEntriesDirect(
    [entry],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async () => ({ type: "directory", size: 0, lastModified: 1000 }),
        startStreamTransfer: async (payload) => {
          streams += 1;
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      useCompressedUpload: true,
      resolveConflict: async () => {
        conflictCalls += 1;
        return "merge";
      },
    },
  );
  assert.equal(conflictCalls, 1, "compression fallback must replay the selected action without another prompt");
  assert.equal(streams, 1);
  assert.equal(fallback[0]?.success, true);
});

test("remote upload without a local path never buffers the whole File into renderer memory", async () => {
  let arrayBufferCalls = 0;
  let stagedFiles = 0;
  let streamTransfers = 0;
  const deleted: string[] = [];
  const file = new File(["payload"], "memory-only.bin") as File & {
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => {
      arrayBufferCalls += 1;
      return new ArrayBuffer(7);
    },
  });

  const results = await uploadEntriesDirect(
    [{ file, relativePath: "memory-only.bin", isDirectory: false }],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        stageUploadFile: async (stagedFile) => {
          assert.equal(stagedFile, file);
          stagedFiles += 1;
          return "/netcatty-temp/memory-only.bin";
        },
        deleteTempFile: async (localPath) => { deleted.push(localPath); },
        startStreamTransfer: async (payload) => {
          assert.equal(payload.sourcePath, "/netcatty-temp/memory-only.bin");
          streamTransfers += 1;
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
  );

  assert.equal(arrayBufferCalls, 0);
  assert.equal(stagedFiles, 1);
  assert.equal(streamTransfers, 1);
  assert.deepEqual(deleted, ["/netcatty-temp/memory-only.bin"]);
  assert.equal(results[0]?.success, true);
});

test("cancelling while a pathless file is being staged aborts before stream transfer", async () => {
  const controller = new UploadController();
  let rejectStage: ((error: Error) => void) | undefined;
  let streamTransfers = 0;
  const file = new File(["large payload"], "large.bin");
  const uploading = uploadEntriesDirect(
    [{ file, relativePath: "large.bin", isDirectory: false }],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        stageUploadFile: async () => new Promise<string>((_resolve, reject) => {
          rejectStage = reject;
        }),
        cancelStagedUploadFile: async () => {
          rejectStage?.(new Error("Upload staging cancelled"));
        },
        deleteTempFile: async () => {},
        cancelTransfer: async () => {},
        startStreamTransfer: async (payload) => {
          streamTransfers += 1;
          return { transferId: payload.transferId };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
    controller,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await controller.cancel();
  const results = await uploading;
  assert.equal(streamTransfers, 0);
  assert.equal(results.some((result) => result.cancelled), true);
});

test("does not replace an existing directory when uploading a same-named file", async () => {
  const file = new File(["local"], "dddd", { lastModified: 1234 });
  const deletedPaths: string[] = [];
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async (_sftpId, path) =>
          path === "/target/dddd"
            ? { type: "directory", size: 0, lastModified: 1000 }
            : null,
        deleteSftp: async (_sftpId, path) => {
          deletedPaths.push(path);
        },
        startStreamTransfer: async ({ targetPath: path }) => {
          uploadedPaths.push(path);
          return { transferId: "must-not-run" };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "replace",
    },
  );

  assert.deepEqual(deletedPaths, []);
  assert.deepEqual(uploadedPaths, []);
  assert.equal(results.length, 1);
  assert.equal(results[0].fileName, "dddd");
  assert.equal(results[0].success, false);
  assert.match(results[0].error ?? "", /directory/i);
});

test("file replace leaves the remote destination so upload can restore mode bits", async () => {
  // Deleting before overwrite recreates the inode with umask defaults and drops
  // bits like +x (#2954). Keep the target so stage+rename can restore mode.
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/tool.sh" });
  const deletedPaths: string[] = [];
  const deletedTypes: Array<string | undefined> = [];
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/usr/local/bin",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async (_sftpId, path) =>
          path === "/usr/local/bin/tool.sh"
            ? { type: "file", size: 9, lastModified: 1000 }
            : null,
        deleteSftp: async (_sftpId, path, expectedType) => {
          deletedPaths.push(path);
          deletedTypes.push(expectedType);
        },
        startStreamTransfer: async ({ targetPath: path }) => {
          uploadedPaths.push(path);
          return { transferId: "upload-1" };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "replace",
    },
  );

  assert.deepEqual(deletedPaths, [], "file replace must not delete before upload");
  assert.deepEqual(uploadedPaths, ["/usr/local/bin/tool.sh"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

test("file replace unlinks an existing symlink before upload", async () => {
  // Leaving the symlink would let in-place upload follow it and overwrite the
  // link target outside the displayed directory.
  // Conflict checks use lstatSftp so Replace unlinks the link first.
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/tool.sh" });
  const deletedPaths: string[] = [];
  const deletedTypes: Array<string | undefined> = [];
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/usr/local/bin",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        // Followed stat would report type "file" and skip pre-delete.
        statSftp: async () => ({ type: "file", size: 4096, lastModified: 1000 }),
        lstatSftp: async (_sftpId, path) =>
          path === "/usr/local/bin/tool.sh"
            ? { type: "symlink", size: 12, lastModified: 1000 }
            : null,
        deleteSftp: async (_sftpId, path, expectedType) => {
          deletedPaths.push(path);
          deletedTypes.push(expectedType);
        },
        startStreamTransfer: async ({ targetPath: path }) => {
          uploadedPaths.push(path);
          return { transferId: "upload-1" };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "replace",
    },
  );

  assert.deepEqual(deletedPaths, ["/usr/local/bin/tool.sh"]);
  assert.deepEqual(deletedTypes, ["symlink"]);
  assert.deepEqual(uploadedPaths, ["/usr/local/bin/tool.sh"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

test("LSTAT ENOTSUP is not treated as an absent destination during conflict check", async () => {
  // If unsupported LSTAT is swallowed as "missing", upload skips Replace and may
  // write through an existing symlink to a target outside the displayed dir.
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/tool.sh" });
  let uploaded = 0;
  let conflictPrompts = 0;

  await assert.rejects(
    () => uploadFromFileList(
      [file],
      {
        targetPath: "/usr/local/bin",
        sftpId: "sftp-1",
        isLocal: false,
        bridge: {
          mkdirSftp: async () => {},
          lstatSftp: async () => {
            const error = new Error(
              "Remote server does not support LSTAT; cannot classify path without following symlinks",
            ) as Error & { code: string; lstatUnavailable: boolean };
            error.code = "ENOTSUP";
            error.lstatUnavailable = true;
            throw error;
          },
          startStreamTransfer: async () => {
            uploaded += 1;
            return { transferId: "upload-1" };
          },
        },
        joinPath: (base, name) => `${base}/${name}`,
        resolveConflict: async () => {
          conflictPrompts += 1;
          return "replace";
        },
      },
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "ENOTSUP");
      assert.match(String(error.message), /does not support LSTAT/i);
      return true;
    },
  );

  assert.equal(uploaded, 0, "must not upload when destination type is unknown");
  assert.equal(conflictPrompts, 0, "must not pretend destination is missing");
});

test("ENOENT from lstat still means absent destination for conflict check", async () => {
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/tool.sh" });
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/usr/local/bin",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        lstatSftp: async () => {
          const error = new Error("No such file") as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        },
        startStreamTransfer: async ({ targetPath: path }) => {
          uploadedPaths.push(path);
          return { transferId: "upload-1" };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => {
        throw new Error("absent destination must not prompt for conflict");
      },
    },
  );

  assert.deepEqual(uploadedPaths, ["/usr/local/bin/tool.sh"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

test("Electron-wrapped lstat absence still means absent destination", async () => {
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/tool.sh" });
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/usr/local/bin",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        lstatSftp: async () => {
          throw new Error("Error invoking remote method 'netcatty:sftp:lstat': Error: No such file");
        },
        startStreamTransfer: async ({ targetPath: path }) => {
          uploadedPaths.push(path);
          return { transferId: "upload-1" };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => {
        throw new Error("absent destination must not prompt for conflict");
      },
    },
  );

  assert.deepEqual(uploadedPaths, ["/usr/local/bin/tool.sh"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

test("compressed-upload LSTAT ENOTSUP is not treated as an absent destination", async (t) => {
  let compressedStarts = 0;
  installCompressedUploadBridge(t, {
    onStart: () => { compressedStarts += 1; },
  });
  let streamCalls = 0;

  await assert.rejects(
    () => uploadFromFileList(
      [createPickedFolderFile()],
      {
        targetPath: "/remote",
        sftpId: "sftp-1",
        isLocal: false,
        bridge: {
          mkdirSftp: async () => {},
          lstatSftp: async () => {
            const error = new Error(
              "Remote server does not support LSTAT; cannot classify path without following symlinks",
            ) as Error & { code: string; lstatUnavailable: boolean };
            error.code = "ENOTSUP";
            error.lstatUnavailable = true;
            throw error;
          },
          startStreamTransfer: async (payload) => {
            streamCalls += 1;
            return { transferId: payload.transferId };
          },
        },
        joinPath: (base, name) => `${base}/${name}`,
        useCompressedUpload: true,
        resolveConflict: async () => "merge",
      },
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "ENOTSUP");
      return true;
    },
  );

  assert.equal(compressedStarts, 0);
  assert.equal(streamCalls, 0);
});

test("directory replace unlinks an existing symlink before mkdir", async () => {
  // No-follow lstat reports symlink; Replace must unlink then create the dir
  // (followed stat used to classify symlink-to-dir as directory and succeed).
  const file = new File(["nested"], "file.txt", { lastModified: 1234 });
  Object.defineProperty(file, "path", { value: "/local/docs/file.txt" });
  Object.defineProperty(file, "webkitRelativePath", { value: "docs/file.txt" });
  const deletedPaths: string[] = [];
  const deletedTypes: Array<string | undefined> = [];
  const madeDirs: string[] = [];
  const uploadedPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async (_sftpId, path) => {
          madeDirs.push(path);
        },
        lstatSftp: async (_sftpId, path) =>
          path === "/remote/docs"
            ? { type: "symlink", size: 8, lastModified: 1000 }
            : null,
        deleteSftp: async (_sftpId, path, expectedType) => {
          deletedPaths.push(path);
          deletedTypes.push(expectedType);
        },
        startStreamTransfer: async ({ targetPath: path }) => {
          uploadedPaths.push(path);
          return { transferId: "upload-dir-1" };
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "replace",
    },
  );

  assert.deepEqual(deletedPaths, ["/remote/docs"]);
  assert.deepEqual(deletedTypes, ["symlink"]);
  assert.ok(madeDirs.includes("/remote/docs"), `expected mkdir after unlink, got ${JSON.stringify(madeDirs)}`);
  assert.deepEqual(uploadedPaths, ["/remote/docs/file.txt"]);
  assert.equal(results.some((r) => r.success), true);
});

test("local file replace unlinks an existing symlink before writeLocalFile", async () => {
  // Pathless File uploads fall back to writeLocalFile, which follows symlinks.
  // Conflict checks use lstatLocal so Replace unlinks the link first.
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  const deletedPaths: string[] = [];
  const deletedTypes: Array<string | undefined> = [];
  const writtenPaths: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/Users/me/bin",
      sftpId: null,
      isLocal: true,
      bridge: {
        mkdirSftp: async () => {},
        lstatLocal: async (path) =>
          path === "/Users/me/bin/tool.sh"
            ? { type: "symlink", size: 12, lastModified: 1000 }
            : null,
        deleteLocalFile: async (path, expectedType) => {
          deletedPaths.push(path);
          deletedTypes.push(expectedType);
        },
        writeLocalFile: async (path) => {
          writtenPaths.push(path);
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "replace",
    },
  );

  assert.deepEqual(deletedPaths, ["/Users/me/bin/tool.sh"]);
  assert.deepEqual(deletedTypes, ["symlink"]);
  assert.deepEqual(writtenPaths, ["/Users/me/bin/tool.sh"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

test("local file replace unlinks a regular file before writeLocalFile", async () => {
  const file = new File(["new-bytes"], "tool.sh", { lastModified: 1234 });
  const operations: string[] = [];

  const results = await uploadFromFileList(
    [file],
    {
      targetPath: "/Users/me/bin",
      sftpId: null,
      isLocal: true,
      bridge: {
        mkdirSftp: async () => {},
        lstatLocal: async (path) =>
          path === "/Users/me/bin/tool.sh"
            ? { type: "file", size: 12, lastModified: 1000 }
            : null,
        deleteLocalFile: async (path, expectedType) => {
          operations.push(`delete:${path}:${expectedType}`);
        },
        writeLocalFile: async (path) => {
          operations.push(`write:${path}`);
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "replace",
    },
  );

  assert.deepEqual(operations, [
    "delete:/Users/me/bin/tool.sh:file",
    "write:/Users/me/bin/tool.sh",
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

test("counts apply-to-all upload conflicts by incoming and existing type", async () => {
  const files = [
    new File(["local"], "existing-file", { lastModified: 1234 }),
    new File(["local"], "existing-directory", { lastModified: 1234 }),
  ];
  const conflictCounts: number[] = [];

  const results = await uploadFromFileList(
    files,
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async (_sftpId, path) => {
          if (path === "/target/existing-file") {
            return { type: "file", size: 2, lastModified: 1000 };
          }
          if (path === "/target/existing-directory") {
            return { type: "directory", size: 0, lastModified: 1000 };
          }
          return null;
        },
        startStreamTransfer: async () => {
          throw new Error("skipped conflicts should not upload");
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async (conflict) => {
        conflictCounts.push(conflict.applyToAllCount);
        return "skip";
      },
    },
  );

  assert.deepEqual(conflictCounts, [1, 1]);
  assert.deepEqual(results, [
    { fileName: "existing-file", success: false, cancelled: true },
    { fileName: "existing-directory", success: false, cancelled: true },
  ]);
});

test("folder drag-drop creates a bundle task with a resolved local source path", async () => {
  const created: Array<{ fileName: string; sourcePath?: string; isDirectory?: boolean }> = [];
  const fileA = { size: 10, path: "/Users/me/Desktop/docs/a.txt" } as File & { path?: string };
  const fileB = { size: 20, path: "/Users/me/Desktop/docs/b.txt" } as File & { path?: string };

  const results = await uploadEntriesDirect(
    [
      {
        file: fileA,
        relativePath: "docs/a.txt",
        isDirectory: false,
      },
      {
        file: fileB,
        relativePath: "docs/b.txt",
        isDirectory: false,
      },
    ],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => ({ transferId: payload.transferId }),
      },
      joinPath: (base, name) => `${base}/${name}`,
      callbacks: {
        onTaskCreated: (task) => {
          created.push({
            fileName: task.fileName,
            sourcePath: task.sourcePath,
            isDirectory: task.isDirectory,
          });
        },
      },
    },
  );

  assert.equal(results.every((result) => result.success), true);
  assert.ok(
    created.some((task) => task.fileName === "docs" && task.isDirectory === true && task.sourcePath === "/Users/me/Desktop/docs"),
    `expected folder bundle task with local source path, got ${JSON.stringify(created)}`,
  );
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

test("unified transfer events are the sole writer of file completion", async () => {
  const created: string[] = [];
  const completed: string[] = [];
  const results = await uploadEntriesDirect(
    [{
      file: null,
      localPath: "/Users/me/Desktop/report.txt",
      relativePath: "report.txt",
      isDirectory: false,
      size: 42,
    }],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        managesTransferLifecycle: true,
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => ({ transferId: payload.transferId }),
      },
      joinPath: (base, name) => `${base}/${name}`,
      callbacks: {
        onTaskCreated: (task) => created.push(task.id),
        onTaskCompleted: (taskId) => completed.push(taskId),
      },
    },
  );

  assert.equal(results[0].success, true);
  assert.equal(created.length, 1);
  assert.deepEqual(completed, []);
});

test("a failed unified SFTP upload has no secondary upload path", async () => {
  const file = new File(["payload"], "payload.txt");
  Object.defineProperty(file, "path", { value: "/tmp/payload.txt" });
  const results = await uploadEntriesDirect(
    [{ file, relativePath: "payload.txt", isDirectory: false }],
    {
      targetPath: "/target",
      sftpId: "sftp-1",
      isLocal: false,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async () => ({ transferId: "stream", error: "stream failed" }),
      },
      joinPath: (base, name) => `${base}/${name}`,
    },
  );

  assert.deepEqual(results, [{ fileName: "payload.txt", success: false, error: "stream failed" }]);
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
