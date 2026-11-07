"use strict";

// Main owns the packed-download lifecycle while the renderer owns admission
// and the worker owns the archive stream. Keeping the owner here lets another
// window cancel a queued or running job without impersonating its SFTP client.
function createPackedDownloadLifecycle({ broadcast, cancel }) {
  const entries = new Map();
  const owners = new Map();
  const emit = (entry, type, extra = {}) => {
    broadcast({
      ...entry.metadata, type, direction: "download", isDirectory: true,
      controlKind: "packed-download", origin: "manual", retryable: false,
      resumable: false, transferred: entry.bytes, ...extra,
    });
  };
  const detachOwner = (owner) => {
    owner.sender.removeListener?.("destroyed", owner.gone);
    owner.sender.removeListener?.("render-process-gone", owner.gone);
    owner.sender.removeListener?.("did-start-navigation", owner.navigate);
    if (owners.get(owner.sender.id) === owner) owners.delete(owner.sender.id);
  };
  const forget = (entry) => {
    if (entries.get(entry.metadata.transferId) !== entry) return;
    entries.delete(entry.metadata.transferId);
    const owner = entry.owner;
    owner?.entries.delete(entry);
    if (owner && owner.entries.size === 0) detachOwner(owner);
  };
  const terminal = (entry, type, extra = {}) => {
    if (entry.terminal) return;
    entry.terminal = type;
    emit(entry, type, { endedAt: Date.now(), ...extra });
  };
  const getOwner = (sender) => {
    let owner = owners.get(sender.id);
    if (owner) return owner;
    owner = { sender, entries: new Set(), closed: false };
    owner.gone = () => {
      if (owner.closed) return;
      owner.closed = true;
      detachOwner(owner);
      for (const entry of [...owner.entries]) {
        entry.cancelled = true;
        if (entry.operation) {
          // Publication may already have committed while its response is in
          // flight. As with normal cancellation, the actual result wins.
          void Promise.resolve().then(() => cancel({ sender }, entry.metadata.transferId)).catch(() => {});
        } else {
          terminal(entry, "cancelled");
          // No dead renderer finally block is needed to clean queued work.
          forget(entry);
        }
      }
    };
    owner.navigate = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) owner.gone();
    };
    sender.once?.("destroyed", owner.gone);
    sender.once?.("render-process-gone", owner.gone);
    sender.on?.("did-start-navigation", owner.navigate);
    owners.set(sender.id, owner);
    return owner;
  };
  const register = (event, metadata) => {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed?.()) return { success: false, reason: "Download window is no longer available" };
    if (!metadata || typeof metadata.transferId !== "string" || !metadata.transferId
      || typeof metadata.fileName !== "string" || typeof metadata.sourcePath !== "string"
      || typeof metadata.targetPath !== "string") throw new Error("Invalid packed download task");
    const previous = entries.get(metadata.transferId);
    if (previous) throw new Error("Packed download task already registered");
    const entry = {
      sender, bytes: 0, terminal: null, cancelled: false, operation: null,
      metadata: {
        transferId: metadata.transferId, fileName: metadata.fileName,
        sourcePath: metadata.sourcePath, targetPath: metadata.targetPath,
        sourceConnectionId: metadata.sourceConnectionId, sessionId: metadata.sourceConnectionId,
        sourceHostId: metadata.sourceHostId, sourceHostLabel: metadata.sourceHostLabel,
        packedTargetPaths: Array.isArray(metadata.packedTargetPaths) ? [...metadata.packedTargetPaths] : [],
        startedAt: Date.now(), totalBytes: 0,
      },
    };
    entries.set(metadata.transferId, entry);
    entry.owner = getOwner(sender);
    entry.owner.entries.add(entry);
    emit(entry, "queued");
    return { success: true };
  };
  const progress = (payload) => {
    const entry = entries.get(payload?.transferId);
    if (!entry?.operation || entry.terminal) return;
    entry.bytes = Math.max(entry.bytes, Number(payload.bytes) || 0);
    emit(entry, "progress", { phase: payload.phase === "extracting" ? "extracting" : "transferring" });
  };
  return {
    register,
    has: (transferId) => entries.has(transferId),
    progress,
    async run(event, payload, work) {
      let entry = entries.get(payload.transferId);
      // Preserve callers predating the queue-registration API (e.g. CLI tests).
      if (!entry) {
        const name = payload.names?.length === 1 ? payload.names[0] : "Packed download";
        const result = register(event, {
          transferId: payload.transferId, fileName: name,
          sourcePath: payload.remoteDirectory, targetPath: payload.localDirectory,
        });
        if (!result.success) return { status: "cancelled" };
        entry = entries.get(payload.transferId);
      }
      if (entry.sender.id !== event?.sender?.id) throw new Error("Packed download belongs to another window");
      if (entry.operation) throw new Error("Packed download is already running");
      if (entry.cancelled) { forget(entry); return { status: "cancelled" }; }
      // In the non-worker path, forward the existing per-origin callback too.
      const sender = {
        id: entry.sender.id, isDestroyed: () => entry.sender.isDestroyed?.() ?? false,
        send(channel, update) {
          if (channel === "netcatty:sftp:packedProgress") progress(update);
          if (!entry.sender.isDestroyed?.()) entry.sender.send?.(channel, update);
        },
      };
      entry.operation = Promise.resolve().then(() => entry.cancelled
        ? { status: "cancelled" }
        : work({ ...event, sender }, payload));
      emit(entry, "started", { phase: "transferring" });
      try {
        const result = await entry.operation;
        terminal(entry, result.status === "completed" ? "completed" : result.status === "fallback" ? "dismissed" : "cancelled",
          result.status === "completed" ? { totalBytes: entry.bytes } : {});
        return result;
      } catch (error) {
        terminal(entry, "failed", { error: error?.message || String(error) });
        throw error;
      } finally { forget(entry); }
    },
    async cancel(transferId) {
      const entry = entries.get(transferId);
      if (!entry) return { success: false, inactive: true };
      if (entry.terminal) return { success: true };
      entry.cancelled = true;
      if (!entry.operation) {
        // Keep this tombstone until run/finish so a queued renderer cannot
        // start the stream after another window cancelled it.
        terminal(entry, "cancelled");
      } else {
        await cancel({ sender: entry.sender }, transferId);
        // The real stream outcome wins a completion/cancel race, and cleanup
        // finishes before the caller marks the row settled.
        await entry.operation.catch(() => {});
      }
      return { success: true };
    },
    finish(event, { transferId, status, error }) {
      const entry = entries.get(transferId);
      if (!entry) return;
      if (entry.sender.id !== event?.sender?.id) throw new Error("Packed download belongs to another window");
      if (entry.operation) return;
      if (!["cancelled", "failed", "dismissed"].includes(status)) throw new Error("Invalid packed download outcome");
      terminal(entry, status, error ? { error } : {});
      forget(entry);
    },
    workerExited(error) {
      for (const entry of [...entries.values()]) {
        entry.cancelled = true;
        terminal(entry, "failed", { error: error?.message || "Transfer worker stopped" });
        // A renderer queue callback may still run after worker replacement.
        // Keep its no-start marker until that renderer acknowledges settlement.
        if (entry.operation) forget(entry);
      }
    },
  };
}

let registeredLifecycle = null;
function setPackedDownloadLifecycle(lifecycle) { registeredLifecycle = lifecycle; }
function getPackedDownloadLifecycle() { return registeredLifecycle; }

module.exports = { createPackedDownloadLifecycle, setPackedDownloadLifecycle, getPackedDownloadLifecycle };
