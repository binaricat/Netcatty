import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmSftpClipboardUpload,
  createDropEntriesFromClipboardFiles,
  getSftpClipboardSystemTextPaths,
  getSupportedClipboardUploadFiles,
  isSftpNativeClipboardPasteEnabled,
  resolveSftpClipboardUploadTarget,
  shouldLetNativePasteEventHandleSftpPaste,
  shouldStartClipboardUploadConfirm,
  type ClipboardLocalFile,
  type SftpClipboardUploadRequest,
} from "./sftp/clipboardUpload.ts";
import type { SftpFileEntry } from "../types";

const file = (name: string, overrides: Partial<SftpFileEntry> = {}): SftpFileEntry => ({
  name,
  type: "file",
  size: 1,
  modified: new Date(0),
  permissions: "-rw-r--r--",
  owner: "",
  group: "",
  ...overrides,
});

test("clipboard upload targets the selected folder in the file list", () => {
  const target = resolveSftpClipboardUploadTarget({
    currentPath: "/home/app",
    selectedFileNames: ["logs"],
    files: [file("logs", { type: "directory" })],
    treeSelection: [],
  });

  assert.equal(target, "/home/app/logs");
});

test("clipboard upload targets the current directory without a concrete folder selection", () => {
  const target = resolveSftpClipboardUploadTarget({
    currentPath: "/home/app",
    selectedFileNames: [],
    files: [file("logs", { type: "directory" })],
    treeSelection: [],
  });

  assert.equal(target, "/home/app");
});

test("clipboard upload ignores selected regular files when resolving the target", () => {
  const target = resolveSftpClipboardUploadTarget({
    currentPath: "/home/app",
    selectedFileNames: ["readme.md"],
    files: [file("readme.md")],
    treeSelection: [],
  });

  assert.equal(target, "/home/app");
});

test("clipboard upload targets the selected folder in the tree", () => {
  const target = resolveSftpClipboardUploadTarget({
    currentPath: "/home/app",
    selectedFileNames: [],
    files: [],
    treeSelection: [{ name: "logs", path: "/var/logs", isDirectory: true }],
  });

  assert.equal(target, "/var/logs");
});

test("SFTP clipboard system text uses selected list paths", () => {
  assert.deepEqual(
    getSftpClipboardSystemTextPaths({
      currentPath: "/home/app",
      selectedFileNames: ["one.txt", "nested two.txt"],
      treeSelection: [],
    }),
    ["/home/app/one.txt", "/home/app/nested two.txt"],
  );
});

test("SFTP clipboard system text uses selected tree paths", () => {
  assert.deepEqual(
    getSftpClipboardSystemTextPaths({
      currentPath: "/home/app",
      selectedFileNames: ["ignored.txt"],
      treeSelection: [
        { name: "logs", path: "/var/logs", isDirectory: true },
        { name: "report.txt", path: "/var/report.txt", isDirectory: false },
      ],
    }),
    ["/var/logs", "/var/report.txt"],
  );
});

test("clipboard files become path-backed upload entries", () => {
  const files: ClipboardLocalFile[] = [
    { path: "/Users/me/Desktop/report.txt", name: "report.txt", isDirectory: false, size: 42 },
  ];

  assert.deepEqual(createDropEntriesFromClipboardFiles(files), [
    {
      file: null,
      localPath: "/Users/me/Desktop/report.txt",
      relativePath: "report.txt",
      isDirectory: false,
      size: 42,
    },
  ]);
});

test("clipboard upload keeps directories for recursive folder paste", () => {
  const files: ClipboardLocalFile[] = [
    { path: "/Users/me/Desktop/report.txt", name: "report.txt", isDirectory: false, size: 42 },
    { path: "/Users/me/Desktop/folder", name: "folder", isDirectory: true, size: 0 },
  ];

  assert.deepEqual(getSupportedClipboardUploadFiles(files), files);
});

test("SFTP paste keydown lets the native paste event handle OS clipboard files", () => {
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "Ctrl + V"), true);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "⌘ + V"), true);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "Ctrl + Shift + V"), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "Cmd + Shift + V"), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "F9"), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpCopy", "Ctrl + V"), false);
});

test("clipboard upload confirmation clears the dialog before awaiting transfer", async () => {
  const events: string[] = [];
  let resolveUpload: (() => void) | undefined;
  const uploadDone = new Promise<void>((resolve) => {
    resolveUpload = resolve;
  });

  const request: SftpClipboardUploadRequest = {
    scopeId: "pane-1",
    side: "left",
    targetPath: "/remote/inbox",
    files: [{ path: "/tmp/a.txt", name: "a.txt", isDirectory: false, size: 1 }],
    onConfirm: async () => {
      events.push("upload-start");
      await uploadDone;
      events.push("upload-end");
    },
  };

  const confirmPromise = confirmSftpClipboardUpload({
    request,
    clear: () => {
      events.push("clear");
    },
    onUploaded: (targetPath) => {
      events.push(`uploaded:${targetPath}`);
    },
  });

  // Dialog must already be cleared while the transfer is still in flight.
  // async function runs to its first await before returning the promise.
  assert.deepEqual(events, ["clear", "upload-start"]);

  resolveUpload?.();
  await confirmPromise;
  assert.deepEqual(events, ["clear", "upload-start", "upload-end", "uploaded:/remote/inbox"]);
});

test("clipboard upload confirmation skips onUploaded when transfer fails", async () => {
  const events: string[] = [];
  const request: SftpClipboardUploadRequest = {
    scopeId: "pane-1",
    side: "left",
    targetPath: "/remote/inbox",
    files: [{ path: "/tmp/a.txt", name: "a.txt", isDirectory: false, size: 1 }],
    onConfirm: async () => {
      events.push("upload-start");
      throw new Error("boom");
    },
  };

  await assert.rejects(
    () => confirmSftpClipboardUpload({
      request,
      clear: () => {
        events.push("clear");
      },
      onUploaded: () => {
        events.push("uploaded");
      },
    }),
    /boom/,
  );

  // Dialog is still cleared so the UI is not stuck; refresh callback is skipped.
  assert.deepEqual(events, ["clear", "upload-start"]);
});

test("clipboard upload confirm guard is per request, not a global lock", () => {
  const first: SftpClipboardUploadRequest = {
    scopeId: "pane-1",
    side: "left",
    targetPath: "/a",
    files: [{ path: "/tmp/a.txt", name: "a.txt", isDirectory: false, size: 1 }],
    onConfirm: async () => {},
  };
  const second: SftpClipboardUploadRequest = {
    scopeId: "pane-1",
    side: "left",
    targetPath: "/b",
    files: [{ path: "/tmp/b.txt", name: "b.txt", isDirectory: false, size: 1 }],
    onConfirm: async () => {},
  };

  assert.equal(shouldStartClipboardUploadConfirm(first, null), true);
  assert.equal(shouldStartClipboardUploadConfirm(first, first), false);
  // A later paste while the first transfer is still running must remain confirmable.
  assert.equal(shouldStartClipboardUploadConfirm(second, first), true);
  assert.equal(shouldStartClipboardUploadConfirm(null, first), false);
});

test("native clipboard paste follows SFTP paste shortcut availability", () => {
  assert.equal(
    isSftpNativeClipboardPasteEnabled("disabled", [
      { id: "sftp-paste", action: "sftpPaste", label: "Paste", mac: "⌘ + V", pc: "Ctrl + V", category: "sftp" },
    ]),
    false,
  );
  assert.equal(
    isSftpNativeClipboardPasteEnabled("pc", [
      { id: "sftp-paste", action: "sftpPaste", label: "Paste", mac: "⌘ + V", pc: "Disabled", category: "sftp" },
    ]),
    false,
  );
  assert.equal(
    isSftpNativeClipboardPasteEnabled("pc", [
      { id: "sftp-paste", action: "sftpPaste", label: "Paste", mac: "⌘ + V", pc: "F9", category: "sftp" },
    ]),
    false,
  );
  assert.equal(
    isSftpNativeClipboardPasteEnabled("pc", [
      { id: "sftp-paste", action: "sftpPaste", label: "Paste", mac: "⌘ + V", pc: "Ctrl + Shift + V", category: "sftp" },
    ]),
    false,
  );
  assert.equal(
    isSftpNativeClipboardPasteEnabled("pc", [
      { id: "sftp-paste", action: "sftpPaste", label: "Paste", mac: "⌘ + V", pc: "Ctrl + V", category: "sftp" },
    ]),
    true,
  );
});
