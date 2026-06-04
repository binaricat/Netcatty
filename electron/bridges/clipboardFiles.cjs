"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");

const HDROP_FORMATS = ["CF_HDROP", "FileDrop"];
const URI_LIST_FORMATS = ["text/uri-list", "text/x-moz-url"];

function decodeWindowsFileNameW(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  return buffer
    .toString("utf16le")
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function decodeWindowsFileName(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  return buffer
    .toString("utf8")
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function decodeWindowsHDrop(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return [];
  const filesOffset = buffer.readUInt32LE(0);
  if (filesOffset <= 0 || filesOffset >= buffer.length) return [];
  const isWide = buffer.readUInt32LE(16) !== 0;
  const payload = buffer.subarray(filesOffset);
  const text = payload.toString(isWide ? "utf16le" : "utf8");
  return text
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function decodeFileUri(value, { windows = process.platform === "win32" } = {}) {
  if (!value.startsWith("file://")) return value;
  try {
    return fileURLToPath(value, { windows });
  } catch {
    return value;
  }
}

function toClipboardFile(filePath, { fsImpl = fs, pathImpl = path } = {}) {
  if (!filePath || !fsImpl.existsSync(filePath)) return null;

  try {
    const stat = fsImpl.statSync(filePath);
    const isDirectory = stat.isDirectory();
    if (!isDirectory && !stat.isFile()) return null;
    const name = filePath.includes("\\")
      ? path.win32.basename(filePath)
      : pathImpl.basename(filePath);
    return {
      path: filePath,
      name,
      isDirectory,
      size: isDirectory ? 0 : stat.size,
    };
  } catch {
    return null;
  }
}

function collectExistingFiles(paths, options = {}) {
  const seen = new Set();
  const files = [];
  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const file = toClipboardFile(candidate, options);
    if (file) files.push(file);
  }
  return files;
}

function parseClipboardTextFilePaths(text, options = {}) {
  if (!text) return [];
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.startsWith("file://"))
    .map((line) => decodeFileUri(line, options));
  return collectExistingFiles(candidates, options);
}

function readClipboardFiles({
  clipboard,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (!clipboard) return [];

  const options = { fsImpl, pathImpl };
  try {
    const formats = typeof clipboard.availableFormats === "function"
      ? clipboard.availableFormats()
      : [];

    if (typeof clipboard.readBuffer === "function") {
      for (const format of HDROP_FORMATS) {
        if (!formats.includes(format)) continue;
        const files = collectExistingFiles(decodeWindowsHDrop(clipboard.readBuffer(format)), options);
        if (files.length > 0) return files;
      }
    }

    if (formats.includes("FileNameW") && typeof clipboard.readBuffer === "function") {
      const files = collectExistingFiles(decodeWindowsFileNameW(clipboard.readBuffer("FileNameW")), options);
      if (files.length > 0) return files;
    }

    if (formats.includes("FileName") && typeof clipboard.readBuffer === "function") {
      const files = collectExistingFiles(decodeWindowsFileName(clipboard.readBuffer("FileName")), options);
      if (files.length > 0) return files;
    }

    if (
      typeof clipboard.readText === "function" &&
      formats.some((format) => URI_LIST_FORMATS.includes(format))
    ) {
      return parseClipboardTextFilePaths(clipboard.readText(), options);
    }
  } catch {
    return [];
  }

  return [];
}

module.exports = {
  decodeWindowsHDrop,
  decodeWindowsFileNameW,
  parseClipboardTextFilePaths,
  readClipboardFiles,
};
