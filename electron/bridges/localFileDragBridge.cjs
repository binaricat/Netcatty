"use strict";

const fs = require("node:fs");
const path = require("node:path");

function validateDragPayload(payload, pathApi = path) {
  if (!payload || typeof payload.requestId !== "string" || !payload.requestId
      || payload.requestId.length > 128 || !Array.isArray(payload.paths)
      || payload.paths.length === 0 || payload.paths.length > 4096) {
    throw new Error("Invalid local file drag request");
  }
  const paths = payload.paths.map((value) => {
    if (typeof value !== "string" || value.includes("\0") || !pathApi.isAbsolute(value)) {
      throw new Error("Drag paths must be absolute filesystem paths");
    }
    if (pathApi.sep === "\\" && (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value)
        || /^[\\/]{2}[?.][\\/]/.test(value))) {
      throw new Error("Drag paths must identify a drive or a network share");
    }
    // Preserve spelling and symlinks; do not resolve to a different file.
    return pathApi.normalize(value);
  });
  return [...new Set(paths)];
}

function createLocalFileDragHandlers({ getWindows, nativeImage, getGesture, stat = fs.promises.stat }) {
  const pending = new Map();
  let icon;
  const authorized = (event) => {
    const sender = event?.sender;
    return !!sender && !sender.isDestroyed()
      && !!event.senderFrame && event.senderFrame === sender.mainFrame
      && getWindows().some((win) => !win.isDestroyed() && win.webContents === sender);
  };
  const cancel = (event, { requestId } = {}) => {
    if (!authorized(event)) return;
    if (pending.get(event.sender)?.requestId === requestId) pending.delete(event.sender);
  };
  const start = async (event, payload) => {
    let request;
    try {
      if (!authorized(event)) throw new Error("Unauthorized local file drag sender");
      const gesture = getGesture(event.sender);
      if (!gesture) throw new Error("Start a new mouse drag to share local files");
      const paths = validateDragPayload(payload);
      request = { requestId: payload.requestId };
      pending.set(event.sender, request);
      // Only metadata is inspected, including the target of a symlink. No
      // recursive traversal, content reads, temporary copies, or SFTP calls.
      for (const filePath of paths) {
        const info = await stat(filePath);
        if (!info.isFile() && !info.isDirectory()) {
          throw new Error("Only files and folders can be dragged");
        }
        if (pending.get(event.sender) !== request) return { started: false };
        if (getGesture(event.sender) !== gesture) {
          throw new Error("The drag ended before the files were ready. Please drag again.");
        }
      }
      if (!authorized(event) || pending.get(event.sender) !== request) return { started: false };
      // Native input is tracked in the main process, not via the synthetic
      // mouseup Chromium emits when the renderer cancels its HTML drag.
      if (getGesture(event.sender) !== gesture) {
        throw new Error("The drag ended before the files were ready. Please drag again.");
      }
      if (!icon) {
        const pixels = Buffer.alloc(16 * 16 * 4);
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = 220;
          pixels[i + 1] = 140;
          pixels[i + 2] = 40;
          pixels[i + 3] = 255;
        }
        icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
      }
      if (icon.isEmpty()) throw new Error("File drag icon is unavailable");
      event.sender.startDrag({ files: paths, icon });
      // startDrag returning does not mean the destination accepted the files.
      return { started: true };
    } catch (error) {
      return { started: false, error: error instanceof Error ? error.message : "Unable to drag files" };
    } finally {
      if (request && pending.get(event.sender) === request) pending.delete(event.sender);
    }
  };
  return { start, cancel };
}

function createGestureTracker() {
  const gestures = new WeakMap();
  const attached = new WeakSet();
  const attach = (sender) => {
    if (!sender || attached.has(sender)) return;
    attached.add(sender);
    sender.on("before-mouse-event", (_event, input) => {
      if (input.button !== "left") return;
      if (input.type === "mouseDown") gestures.set(sender, {});
      else if (input.type === "mouseUp") gestures.delete(sender);
    });
    sender.on("before-input-event", (_event, input) => {
      if (input.key === "Escape") gestures.delete(sender);
    });
    sender.on("destroyed", () => gestures.delete(sender));
  };
  return { attach, getGesture: (sender) => gestures.get(sender) };
}

function registerHandlers(ipcMain, dependencies) {
  const tracker = createGestureTracker();
  for (const win of dependencies.getWindows()) tracker.attach(win.webContents);
  dependencies.app?.on?.("web-contents-created", (_event, sender) => tracker.attach(sender));
  const handlers = createLocalFileDragHandlers({ ...dependencies, getGesture: tracker.getGesture });
  ipcMain.handle("netcatty:local:drag-start", handlers.start);
  ipcMain.on("netcatty:local:drag-cancel", handlers.cancel);
}

module.exports = { registerHandlers, createLocalFileDragHandlers, createGestureTracker, validateDragPayload };
