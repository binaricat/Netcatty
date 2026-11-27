"use strict";

async function stageRendererFileToTemp(file, localPath, fsImpl, signal = null) {
  if (!file || typeof file.stream !== "function") {
    throw new Error("Upload file streaming is unavailable");
  }
  let handle = null;
  let reader = null;
  let stagedBytes = 0;
  const cancellationError = () => (
    signal?.reason instanceof Error ? signal.reason : new Error("Upload staging cancelled")
  );
  const onAbort = () => {
    void Promise.resolve(reader?.cancel?.(cancellationError())).catch(() => {});
    void handle?.close?.().catch(() => {});
  };
  try {
    handle = await fsImpl.promises.open(localPath, "wx", 0o600);
    // Stream/getReader can throw synchronously (revoked File, renderer teardown,
    // or a malformed provider). Initialize them inside the cleanup boundary so
    // the just-created file handle is never stranded.
    reader = file.stream().getReader();
    if (signal?.aborted) throw cancellationError();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    while (true) {
      if (signal?.aborted) throw cancellationError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw cancellationError();
      if (done) break;
      if (!value) continue;
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let chunkOffset = 0;
      while (chunkOffset < chunk.length) {
        if (signal?.aborted) throw cancellationError();
        const remaining = chunk.length - chunkOffset;
        let result;
        try {
          result = await handle.write(chunk, chunkOffset, remaining, stagedBytes);
        } catch (error) {
          if (signal?.aborted) throw cancellationError();
          throw error;
        }
        if (signal?.aborted) throw cancellationError();
        const bytesWritten = result?.bytesWritten;
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
          throw new Error("Unable to stage the complete upload file");
        }
        chunkOffset += bytesWritten;
        stagedBytes += bytesWritten;
      }
    }
    return localPath;
  } catch (error) {
    await handle?.close?.().catch(() => {});
    await fsImpl.promises.unlink(localPath).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    reader?.releaseLock?.();
    await handle?.close?.().catch(() => {});
  }
}

const IPC_UPLOAD_CHUNK_BYTES = 512 * 1024;

async function stageRendererFileViaIpc(file, ipcRenderer, { transferId, fileName }, signal = null) {
  if (!file || typeof file.stream !== "function") {
    throw new Error("Upload file streaming is unavailable");
  }
  let stageId = null;
  let localPath = null;
  let reader = null;
  const cancellationError = () => (
    signal?.reason instanceof Error ? signal.reason : new Error("Upload staging cancelled")
  );
  const onAbort = () => {
    void Promise.resolve(reader?.cancel?.(cancellationError())).catch(() => {});
  };
  try {
    if (signal?.aborted) throw cancellationError();
    const opened = await ipcRenderer.invoke("netcatty:tempdir:stageUploadOpen", {
      transferId,
      fileName,
    });
    stageId = opened?.stageId ?? null;
    localPath = opened?.localPath ?? null;
    if (!stageId || !localPath) {
      throw new Error("Unable to allocate upload staging file");
    }
    reader = file.stream().getReader();
    if (signal?.aborted) throw cancellationError();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    while (true) {
      if (signal?.aborted) throw cancellationError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw cancellationError();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const bytes = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength);
      for (let offset = 0; offset < bytes.byteLength; offset += IPC_UPLOAD_CHUNK_BYTES) {
        if (signal?.aborted) throw cancellationError();
        const slice = offset === 0 && bytes.byteLength <= IPC_UPLOAD_CHUNK_BYTES
          ? bytes
          : bytes.subarray(offset, Math.min(bytes.byteLength, offset + IPC_UPLOAD_CHUNK_BYTES));
        await ipcRenderer.invoke("netcatty:tempdir:stageUploadWrite", {
          stageId,
          chunk: slice,
        });
      }
    }
    if (signal?.aborted) throw cancellationError();
    const closed = await ipcRenderer.invoke("netcatty:tempdir:stageUploadClose", { stageId });
    stageId = null;
    return closed?.localPath || localPath;
  } catch (error) {
    if (stageId) {
      await ipcRenderer.invoke("netcatty:tempdir:stageUploadAbort", { stageId }).catch(() => {});
      stageId = null;
    } else if (localPath) {
      await ipcRenderer.invoke("netcatty:deleteTempFile", { filePath: localPath }).catch(() => {});
    }
    throw error;
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    reader?.releaseLock?.();
  }
}

module.exports = { stageRendererFileToTemp, stageRendererFileViaIpc };
