import test from "node:test";
import assert from "node:assert/strict";

import {
  createDropEntriesFromClipboardFiles,
  getSftpClipboardSystemTextPaths,
  getSupportedClipboardUploadFiles,
  isSftpNativeClipboardPasteEnabled,
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

test("clipboard upload ignores directories until recursive paste is supported", () => {
  const files: ClipboardLocalFile[] = [
    { path: "/Users/me/Desktop/report.txt", name: "report.txt", isDirectory: false, size: 42 },
    { path: "/Users/me/Desktop/folder", name: "folder", isDirectory: true, size: 0 },
  ];

  assert.deepEqual(getSupportedClipboardUploadFiles(files), [
    { path: "/Users/me/Desktop/report.txt", name: "report.txt", isDirectory: false, size: 42 },
  ]);
});

test("SFTP paste keydown lets the native paste event handle OS clipboard files", () => {
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "Ctrl + V"), true);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "⌘ + V"), true);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "Ctrl + Shift + V"), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "Cmd + Shift + V"), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpPaste", "F9"), false);
  assert.equal(shouldLetNativePasteEventHandleSftpPaste("sftpCopy", "Ctrl + V"), false);
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
