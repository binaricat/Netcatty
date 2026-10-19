"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Reserve the name synchronously so simultaneous downloads cannot overwrite
// each other or a file already present in the user's Downloads directory.
function reserveDownloadFile(directory, suggestedName) {
  fs.mkdirSync(directory, { recursive: true });
  const basename = path.basename(String(suggestedName || "download").replace(/\\/g, "/"));
  const filename = !basename || basename === "." || basename === ".." ? "download" : basename;
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  for (let suffix = 0; ; suffix++) {
    const savePath = path.join(directory, suffix ? `${stem} (${suffix})${extension}` : filename);
    let descriptor;
    try { descriptor = fs.openSync(savePath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    const reserved = fs.fstatSync(descriptor);
    fs.closeSync(descriptor);
    return {
      savePath,
      cleanupEmpty() {
        try {
          const current = fs.lstatSync(savePath);
          if (current.isFile() && current.size === 0 && current.ino === reserved.ino && current.dev === reserved.dev) fs.unlinkSync(savePath);
        } catch { /* Chromium may already have removed a cancelled download. */ }
      },
    };
  }
}

module.exports = { reserveDownloadFile };
