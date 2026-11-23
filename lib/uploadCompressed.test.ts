import assert from "node:assert/strict";
import test from "node:test";

import { uploadFoldersCompressed } from "./uploadCompressed";
import type { DropEntry } from "./sftpFileUtils";

test("compressed folder uploads use reconstructed drop-entry paths", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        checkCompressedUploadSupport: async () => ({
          supported: false,
          localTar: false,
          remoteTar: false,
        }),
      },
    },
  });

  try {
    const entry: DropEntry = {
      file: { name: "child.txt", size: 1 } as File,
      localPath: "/tmp/example-folder/child.txt",
      relativePath: "example-folder/child.txt",
      isDirectory: false,
    };
    const results = await uploadFoldersCompressed(
      [["example-folder", [entry]]],
      "/remote",
      "sftp-1",
    );

    assert.deepEqual(results, [{
      fileName: "example-folder",
      success: false,
      error: "Compressed upload not supported - fallback needed",
    }]);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
});

test("compressed folder totals exclude directory entries", async () => {
  const previousWindow = globalThis.window;
  const started: Array<{ totalBytes: number; folderPath: string }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        checkCompressedUploadSupport: async () => ({
          supported: true,
          localTar: true,
          remoteTar: true,
        }),
        startCompressedUpload: async (options: { totalBytes: number; folderPath: string; compressionId: string }) => {
          started.push({ totalBytes: options.totalBytes, folderPath: options.folderPath });
          return { compressionId: options.compressionId, success: true };
        },
      },
    },
  });

  try {
    const results = await uploadFoldersCompressed(
      [["docs", [
        { file: null, localPath: "/tmp/docs", relativePath: "docs", isDirectory: true, size: 4096 },
        { file: null, localPath: "/tmp/docs/sub", relativePath: "docs/sub", isDirectory: true, size: 4096 },
        { file: null, localPath: "/tmp/docs/a.txt", relativePath: "docs/a.txt", isDirectory: false, size: 10 },
      ]]],
      "/remote",
      "sftp-1",
    );

    assert.deepEqual(results, [{ fileName: "docs", success: true }]);
    assert.deepEqual(started, [{ totalBytes: 10, folderPath: "/tmp/docs" }]);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
});

test("non-ASCII folder names fall back to per-file upload on Windows", async () => {
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let supportChecks = 0;
  const createdTasks: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Win32" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        checkCompressedUploadSupport: async () => {
          supportChecks += 1;
          return { supported: true, localTar: true, remoteTar: true };
        },
        startCompressedUpload: async (options: { compressionId: string }) => (
          { compressionId: options.compressionId, success: true }
        ),
      },
    },
  });

  try {
    const results = await uploadFoldersCompressed(
      [
        ["前端", [{ file: null, localPath: "C:\\Users\\me\\前端\\a.txt", relativePath: "前端/a.txt", isDirectory: false, size: 1 }]],
        ["mpr", [{ file: null, localPath: "C:\\Users\\me\\等10个文件\\mpr\\a.txt", relativePath: "mpr/a.txt", isDirectory: false, size: 1 }]],
      ],
      "/remote",
      "sftp-1",
      { onTaskCreated: (task) => createdTasks.push(task.fileName) },
    );

    assert.deepEqual(results, [
      { fileName: "前端", success: false, error: "Compressed upload not supported - fallback needed" },
      { fileName: "mpr", success: true },
    ]);
    assert.equal(supportChecks, 1, "the non-ASCII folder must not probe compressed upload support");
    assert.deepEqual(createdTasks, ["mpr"], "no compressed task is created for the fallback folder");
  } finally {
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
});
