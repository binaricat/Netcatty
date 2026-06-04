import test from "node:test";
import assert from "node:assert/strict";

import {
  createDropEntriesFromClipboardFiles,
  resolveSftpClipboardUploadTarget,
  shouldLetNativePasteEventHandleSftpPaste,
  type ClipboardLocalFile,
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

test("SFTP paste keydown lets the native paste event handle OS clipboard files", () => {
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", false), true);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", true), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpCopy", false), false);
});
