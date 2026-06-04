"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decodeWindowsHDrop,
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
  const buffer = Buffer.from("C:\\Users\\me\\a.txt\0\0", "utf16le");

  assert.deepEqual(decodeWindowsFileNameW(buffer), [
    "C:\\Users\\me\\a.txt",
  ]);
});

test("decodes Windows CF_HDROP clipboard buffers", () => {
  const paths = "C:\\Users\\me\\a.txt\0D:\\b.txt\0\0";
  const filesOffset = 20;
  const header = Buffer.alloc(filesOffset);
  header.writeUInt32LE(filesOffset, 0);
  header.writeUInt32LE(1, 16);
  const buffer = Buffer.concat([header, Buffer.from(paths, "utf16le")]);

  assert.deepEqual(decodeWindowsHDrop(buffer), [
    "C:\\Users\\me\\a.txt",
    "D:\\b.txt",
  ]);
});

test("parses text and uri-list clipboard file urls", () => {
  const fsImpl = createFs({
    "/Users/me/a.txt": "file",
    "/Users/me/folder": "directory",
  });

  const files = parseClipboardTextFilePaths(
    "file:///Users/me/a.txt\nfile:///Users/me/folder\n/Users/me/missing.txt",
    { fsImpl, pathImpl: require("node:path") },
  );

  assert.deepEqual(files, [
    { path: "/Users/me/a.txt", name: "a.txt", isDirectory: false, size: 42 },
    { path: "/Users/me/folder", name: "folder", isDirectory: true, size: 0 },
  ]);
});

test("parses Windows file urls with drive letters and UNC paths", () => {
  const fsImpl = createFs({
    "C:\\Users\\me\\a file.txt": "file",
    "\\\\server\\share\\b.txt": "file",
  });

  const files = parseClipboardTextFilePaths(
    "file:///C:/Users/me/a%20file.txt\nfile://server/share/b.txt",
    { fsImpl, pathImpl: require("node:path"), windows: true },
  );

  assert.deepEqual(files, [
    { path: "C:\\Users\\me\\a file.txt", name: "a file.txt", isDirectory: false, size: 42 },
    { path: "\\\\server\\share\\b.txt", name: "b.txt", isDirectory: false, size: 42 },
  ]);
});

test("ignores plain text paths without file uri formats", () => {
  const fsImpl = createFs({ "/Users/me/a.txt": "file" });

  assert.deepEqual(parseClipboardTextFilePaths("/Users/me/a.txt", { fsImpl, pathImpl: require("node:path") }), []);
});

test("reads CF_HDROP before falling back to FileNameW", () => {
  const filesOffset = 20;
  const header = Buffer.alloc(filesOffset);
  header.writeUInt32LE(filesOffset, 0);
  header.writeUInt32LE(1, 16);
  const hdropBuffer = Buffer.concat([
    header,
    Buffer.from("C:\\Users\\me\\a.txt\0D:\\b.txt\0\0", "utf16le"),
  ]);
  const buffer = Buffer.from("C:\\Users\\me\\a.txt\0\0", "utf16le");
  const fsImpl = createFs({ "C:\\Users\\me\\a.txt": "file", "D:\\b.txt": "file" });
  const clipboard = {
    availableFormats: () => ["CF_HDROP", "FileNameW", "text/plain"],
    readBuffer: (format) => {
      if (format === "CF_HDROP") return hdropBuffer;
      if (format === "FileNameW") return buffer;
      return Buffer.alloc(0);
    },
    readText: () => "file:///fallback.txt",
  };

  assert.deepEqual(readClipboardFiles({ clipboard, fsImpl, pathImpl: require("node:path") }), [
    { path: "C:\\Users\\me\\a.txt", name: "a.txt", isDirectory: false, size: 42 },
    { path: "D:\\b.txt", name: "b.txt", isDirectory: false, size: 42 },
  ]);
});
