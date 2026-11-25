"use strict";

async function handleZmodemDragDropUpload({ sessions, tempDirBridge, fs, path }, payload) {
  const { sessionId, files, uploadCommand } = payload || {};
  const session = sessions.get(sessionId);
  if (!session?.zmodemSentry?.queueDragDropUpload) {
    return { success: false, error: "ZMODEM upload is not available for this session" };
  }
  if (session.zmodemSentry.isActive?.()) {
    return { success: false, error: "ZMODEM transfer already in progress" };
  }

  const filePaths = [];
  const remoteNames = [];
  const tempPaths = [];

  for (const file of files || []) {
    if (!file?.name) continue;
    let localPath = file.path;
    if (!localPath && file.data) {
      localPath = tempDirBridge.getTempFilePath(file.name);
      await fs.promises.writeFile(localPath, Buffer.from(file.data));
      tempPaths.push(localPath);
    }
    if (!localPath) continue;
    try {
      await fs.promises.access(localPath);
    } catch {
      continue;
    }
    filePaths.push(localPath);
    remoteNames.push(file.remoteName || path.basename(localPath));
  }

  if (!filePaths.length) {
    for (const tempPath of tempPaths) {
      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
    }
    return { success: false, error: "No readable files to upload" };
  }

  try {
    session.zmodemSentry.queueDragDropUpload({
      filePaths,
      remoteNames,
      uploadCommand: uploadCommand || "rz -y\r",
      tempPaths,
    });
    return { success: true };
  } catch (err) {
    for (const tempPath of tempPaths) {
      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
    }
    return { success: false, error: err?.message || String(err) };
  }
}

module.exports = { handleZmodemDragDropUpload };
