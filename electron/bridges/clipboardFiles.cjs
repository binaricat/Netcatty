"use strict";

const path = require("node:path");
const fs = require("node:fs");

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

function decodeFileUri(value) {
  if (!value.startsWith("file://")) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
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
    .filter((line) => line && !line.startsWith("#"))
    .map(decodeFileUri);
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

    if (formats.includes("FileNameW") && typeof clipboard.readBuffer === "function") {
      const files = collectExistingFiles(decodeWindowsFileNameW(clipboard.readBuffer("FileNameW")), options);
      if (files.length > 0) return files;
    }

    if (formats.includes("FileName") && typeof clipboard.readBuffer === "function") {
      const files = collectExistingFiles(decodeWindowsFileName(clipboard.readBuffer("FileName")), options);
      if (files.length > 0) return files;
    }

    if (typeof clipboard.readText === "function") {
      return parseClipboardTextFilePaths(clipboard.readText(), options);
    }
  } catch {
    return [];
  }

  return [];
}

module.exports = {
  decodeWindowsFileNameW,
  parseClipboardTextFilePaths,
  readClipboardFiles,
};
