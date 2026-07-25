import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("clipboard upload dialog closes before waiting for the transfer", () => {
  const source = readFileSync(
    new URL("./sftp/SftpClipboardUploadDialog.tsx", import.meta.url),
    "utf8",
  );
  const confirmHandler = source.slice(
    source.indexOf("const handleConfirm"),
    source.indexOf("\n  return ("),
  );
  const clearRequest = confirmHandler.indexOf("sftpClipboardUploadStore.clear(active)");
  const startUpload = confirmHandler.indexOf("void active.onConfirm()");

  assert.notEqual(clearRequest, -1);
  assert.notEqual(startUpload, -1);
  assert.ok(
    clearRequest < startUpload,
    "the modal request must be cleared before the upload starts in the background",
  );
  assert.equal(
    /await\s+request\.onConfirm\(/.test(confirmHandler),
    false,
    "confirm must not block the dialog lifecycle on the upload promise",
  );
});

test("clipboard upload pins the originating connection through confirm and upload", () => {
  const requestType = readFileSync(
    new URL("./sftp/clipboardUpload.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    requestType,
    /export interface SftpClipboardUploadRequest \{[\s\S]*connectionId: string;/,
  );

  const shortcuts = readFileSync(
    new URL("./sftp/hooks/useSftpKeyboardShortcuts.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    shortcuts,
    /uploadExternalEntries\(focusedSide, fileEntries, \{\s*targetPath,\s*connectionId,\s*\}\)/,
  );
  assert.match(
    shortcuts,
    /uploadExternalEntries\(focusedSide, entries, \{\s*targetPath,\s*connectionId,\s*\}\)/,
  );
  assert.match(
    shortcuts,
    /uploadExternalFolderPath\(\s*focusedSide,\s*file\.path,\s*targetPath,\s*\{\s*connectionId\s*\},\s*\)/,
  );

  const ops = readFileSync(
    new URL("../application/state/sftp/useSftpExternalOperations.ts", import.meta.url),
    "utf8",
  );
  const entriesFn = ops.slice(
    ops.indexOf("const uploadExternalEntries = useCallback"),
    ops.indexOf("const cancelExternalUpload = useCallback"),
  );
  assert.ok(entriesFn.includes("originatingTabId"));
  assert.ok(
    entriesFn.includes("getPaneByTabId(originatingTabId)"),
    "upload must re-resolve the originating tab after awaits (connection ids rotate on reconnect)",
  );
  assert.equal(
    entriesFn.includes("getActivePane(side) ?? pane"),
    false,
    "upload must not retarget to the newly active pane after session resolve",
  );

  const ensureWrapper = readFileSync(
    new URL("../application/state/useSftpState.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    ensureWrapper,
    /getPaneByTabId\(tabId\)/,
    "ensureRemoteSftpId must pin by stable tab id across reconnect",
  );
  assert.match(
    ensureWrapper,
    /tabId,/,
    "ensureRemoteSftpSession must receive the pinned tab id for connect()",
  );
});

test("external upload cancellation is keyed by transfer task id", () => {
  const ops = readFileSync(
    new URL("../application/state/sftp/useSftpExternalOperations.ts", import.meta.url),
    "utf8",
  );
  assert.match(ops, /uploadControllersByTaskRef/);
  assert.match(ops, /const cancelExternalUpload = useCallback\(async \(taskId\?: string\)/);

  const queue = readFileSync(
    new URL("./sftp/SftpTransferQueue.tsx", import.meta.url),
    "utf8",
  );
  assert.match(queue, /cancelExternalUpload\(task\.id\)/);
});

test("external upload conflict cancel is scoped to the cancelled controller", () => {
  const ops = readFileSync(
    new URL("../application/state/sftp/useSftpExternalOperations.ts", import.meta.url),
    "utf8",
  );
  assert.match(ops, /uploadConflictOwnersRef/);
  assert.match(ops, /createUploadConflictResolver = useCallback\(\(controller: UploadController\)/);
  assert.match(ops, /cancelPendingUploadConflicts\(controller\)/);

  const cancelFn = ops.slice(
    ops.indexOf("const cancelExternalUpload = useCallback"),
    ops.indexOf("const selectApplication = useCallback"),
  );
  // Task-scoped cancel must not fall through to the unscoped "cancel all conflicts" path.
  assert.match(cancelFn, /cancelPendingUploadConflicts\(controller\)/);
  assert.ok(
    cancelFn.indexOf("cancelPendingUploadConflicts(controller)")
      < cancelFn.indexOf("cancelPendingUploadConflicts()"),
    "scoped conflict cancel comes first; unscoped only for cancel-all",
  );
});

test("ensureRemoteSftpSession refuses a side-wide lastConnected host that belongs to another tab", () => {
  const source = readFileSync(
    new URL("../application/state/sftp/ensureRemoteSftpSession.ts", import.meta.url),
    "utf8",
  );
  const resolveHost = source.slice(
    source.indexOf("const resolveHost = (): Host =>"),
    source.indexOf("const readMappedId"),
  );
  assert.match(resolveHost, /lastHost\.id === hostId/);
  assert.ok(
    resolveHost.includes("resolveHostById"),
    "pane hostId must still fall back through vault lookup",
  );
});
