"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decodeWindowsFileNameW,
  parseClipboardTextFilePaths,
  readClipboardFiles,
} = require("./clipboardFiles.cjs");

const createFs = (entries) => ({
  existsSync: (filePath) => filePath in entries,
  statSync: (filePath) => ({
    isDirectory: () => entries[filePath] === "directory",
    isFile: () => entries[filePath] === "file",
    size: entries[filePath] === "file" ? 42 : 0,
  }),
});

test("decodes Windows FileNameW clipboard buffers", () => {
  const buffer = Buffer.from("C:\\Users\\me\\a.txt\0D:\\b.txt\0\0", "utf16le");

  assert.deepEqual(decodeWindowsFileNameW(buffer), [
    "C:\\Users\\me\\a.txt",
    "D:\\b.txt",
  ]);
});

test("parses text and uri-list clipboard file paths", () => {
  const fsImpl = createFs({
    "/Users/me/a.txt": "file",
    "/Users/me/folder": "directory",
  });

  const files = parseClipboardTextFilePaths(
    "file:///Users/me/a.txt\n/Users/me/folder\n/Users/me/missing.txt",
    { fsImpl, pathImpl: require("node:path") },
  );

  assert.deepEqual(files, [
    { path: "/Users/me/a.txt", name: "a.txt", isDirectory: false, size: 42 },
    { path: "/Users/me/folder", name: "folder", isDirectory: true, size: 0 },
  ]);
});

test("reads FileNameW before falling back to clipboard text", () => {
  const buffer = Buffer.from("C:\\Users\\me\\a.txt\0\0", "utf16le");
  const fsImpl = createFs({ "C:\\Users\\me\\a.txt": "file" });
  const clipboard = {
    availableFormats: () => ["FileNameW", "text/plain"],
    readBuffer: (format) => format === "FileNameW" ? buffer : Buffer.alloc(0),
    readText: () => "/fallback.txt",
  };

  assert.deepEqual(readClipboardFiles({ clipboard, fsImpl, pathImpl: require("node:path") }), [
    { path: "C:\\Users\\me\\a.txt", name: "a.txt", isDirectory: false, size: 42 },
  ]);
});
