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

async function readClipboardFilesAsync(clipboard, options) {
  try {
    const items = await clipboard.read();
    if (!Array.isArray(items) || items.length === 0) return [];

    for (const item of items) {
      const types = Array.isArray(item?.types) ? item.types : [];
      if (typeof item?.getType !== "function") continue;

      // Electron 44+ maps native file references (CF_HDROP on Windows,
      // NSFilenamesPboardType on macOS, text/uri-list on Linux) to text/uri-list.
      for (const mime of URI_LIST_FORMATS) {
        if (!types.includes(mime)) continue;
        const blob = await item.getType(mime);
        const text = typeof blob?.text === "function" ? await blob.text() : "";
        const files = parseClipboardTextFilePaths(text, options);
        if (files.length > 0) return files;
      }

      for (const rawFormat of HDROP_FORMATS) {
        const osMime = `electron application/osclipboard;format="${rawFormat}"`;
        if (!types.includes(osMime)) continue;
        const blob = await item.getType(osMime);
        if (typeof blob?.arrayBuffer !== "function") continue;
        const files = collectExistingFiles(
          decodeWindowsHDrop(Buffer.from(await blob.arrayBuffer())),
          options,
        );
        if (files.length > 0) return files;
      }

      const fileNameWMime = 'electron application/osclipboard;format="FileNameW"';
      if (types.includes(fileNameWMime)) {
        const blob = await item.getType(fileNameWMime);
        if (typeof blob?.arrayBuffer === "function") {
          const files = collectExistingFiles(
            decodeWindowsFileNameW(Buffer.from(await blob.arrayBuffer())),
            options,
          );
          if (files.length > 0) return files;
        }
      }

      const fileNameMime = 'electron application/osclipboard;format="FileName"';
      if (types.includes(fileNameMime)) {
        const blob = await item.getType(fileNameMime);
        if (typeof blob?.arrayBuffer === "function") {
          const files = collectExistingFiles(
            decodeWindowsFileName(Buffer.from(await blob.arrayBuffer())),
            options,
          );
          if (files.length > 0) return files;
        }
      }
    }
  } catch {
    return [];
  }
  return [];
}

function readClipboardFiles({
  clipboard,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (!clipboard) return [];

  const options = { fsImpl, pathImpl };
  // Electron 44+ removed availableFormats/readBuffer and replaced clipboard.read
  // with the async W3C ClipboardItem[] API.
  if (typeof clipboard.availableFormats !== "function" && typeof clipboard.read === "function") {
    return readClipboardFilesAsync(clipboard, options);
  }

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

    if (typeof clipboard.read === "function") {
      for (const format of ["NSFilenamesPboardType", "public.file-url"]) {
        if (!formats.includes(format)) continue;
        const raw = clipboard.read(format);
        if (typeof raw !== "string" || raw.trim().length === 0) continue;
        if (raw.includes("file://")) {
          const files = parseClipboardTextFilePaths(raw, options);
          if (files.length > 0) return files;
        }
        const files = collectExistingFiles(
          raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
          options,
        );
        if (files.length > 0) return files;
      }
    }
  } catch {
    return [];
  }

  return [];
}

function formatClipboardImageTimestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function createClipboardImageFileName(date = new Date()) {
  return `netcatty-paste-${formatClipboardImageTimestamp(date)}.png`;
}

async function readClipboardImage({
  clipboard,
  fsImpl = fs,
  tempDirBridge,
  nativeImageImpl = null,
  now = () => new Date(),
} = {}) {
  if (!clipboard || !tempDirBridge?.getTempFilePath) {
    return null;
  }

  try {
    let content = null;
    if (typeof clipboard.readImage === "function") {
      const image = clipboard.readImage();
      if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) return null;
      if (typeof image.toPNG !== "function") return null;
      content = image.toPNG();
    } else if (typeof clipboard.read === "function") {
      const items = await clipboard.read();
      if (!Array.isArray(items) || items.length === 0) return null;
      let matchedItem = null;
      let matchedType = null;
      for (const item of items) {
        const types = Array.isArray(item?.types) ? item.types : [];
        if (types.includes("image/png")) {
          matchedItem = item;
          matchedType = "image/png";
          break;
        }
        const fallbackType = types.find((type) => typeof type === "string" && type.startsWith("image/"));
        if (fallbackType && !matchedItem) {
          matchedItem = item;
          matchedType = fallbackType;
        }
      }
      if (!matchedItem || !matchedType || typeof matchedItem.getType !== "function") return null;
      const blob = await matchedItem.getType(matchedType);
      if (typeof blob?.arrayBuffer !== "function") return null;
      const rawBuffer = Buffer.from(await blob.arrayBuffer());
      if (rawBuffer.length === 0) return null;
      if (matchedType === "image/png") {
        content = rawBuffer;
      } else {
        const ni = nativeImageImpl || (() => {
          try { return require("electron").nativeImage; } catch { return null; }
        })();
        if (ni && typeof ni.createFromBuffer === "function") {
          const img = ni.createFromBuffer(rawBuffer);
          if (!img || (typeof img.isEmpty === "function" && img.isEmpty())) return null;
          content = img.toPNG();
        } else {
          content = rawBuffer;
        }
      }
    } else {
      return null;
    }

    if (!Buffer.isBuffer(content) || content.length === 0) return null;

    const name = createClipboardImageFileName(now());
    const imagePath = tempDirBridge.getTempFilePath(name);
    await fsImpl.promises.writeFile(imagePath, content);
    return {
      path: imagePath,
      name,
      mediaType: "image/png",
      size: content.length,
    };
  } catch {
    return null;
  }
}

async function hasClipboardImageAsync(clipboard) {
  try {
    if (typeof clipboard.read === "function") {
      const items = await clipboard.read();
      if (Array.isArray(items)) {
        return items.some(
          (item) => Array.isArray(item?.types)
            && item.types.some((type) => typeof type === "string" && type.startsWith("image/")),
        );
      }
    }
    if (typeof clipboard.has === "function") {
      if (await clipboard.has("image/png")) return true;
      if (await clipboard.has("image/jpeg")) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Peek whether the OS clipboard currently holds an image without writing a
 * temp file. Used by local terminal paste to decide whether to forward Ctrl+V
 * to nested TUIs (e.g. Claude Code image paste) after Electron's Edit>Paste
 * turns the chord into a clipboard paste event.
 */
function hasClipboardImage({ clipboard } = {}) {
  if (!clipboard) return false;
  if (typeof clipboard.readImage !== "function") {
    if (typeof clipboard.read === "function" || typeof clipboard.has === "function") {
      return hasClipboardImageAsync(clipboard);
    }
    return false;
  }
  try {
    if (typeof clipboard.availableFormats === "function") {
      try {
        const formats = clipboard.availableFormats();
        if (Array.isArray(formats) && formats.some((format) => typeof format === "string" && format.startsWith("image/"))) {
          return true;
        }
      } catch {
        // Fall through to readImage when format probing fails.
      }
    }
    const image = clipboard.readImage();
    if (!image) return false;
    if (typeof image.isEmpty === "function" && image.isEmpty()) return false;
    if (typeof image.getSize === "function") {
      const size = image.getSize();
      return Boolean(size && size.width > 0 && size.height > 0);
    }
    if (typeof image.toPNG !== "function") return false;
    const content = image.toPNG();
    return Buffer.isBuffer(content) && content.length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  createClipboardImageFileName,
  decodeWindowsHDrop,
  decodeWindowsFileNameW,
  hasClipboardImage,
  parseClipboardTextFilePaths,
  readClipboardFiles,
  readClipboardImage,
};
