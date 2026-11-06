"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHmac, randomBytes } = require("node:crypto");
const { PluginLogger, PluginLogSink } = require("./pluginLogger.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

const bounded = (value, length = 128) => typeof value === "string"
  ? value.slice(0, length).replace(/[^a-zA-Z0-9._:@/-]/gu, "_") : null;
const sourceKey = (value) => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value) ? value : null;
const ownerKey = (value) => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,256}$/u.test(value) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

class PluginLogService {
  constructor(options) {
    this.directory = path.join(options.paths.logs, "host-v1");
    this.preferencesPath = path.join(options.paths.root, "local-logging.json");
    this.resolveProvenance = options.resolveProvenance ?? (() => null);
    this.electron = options.electron;
    this.provenanceChecks = new WeakMap();
    this.salt = randomBytes(32);
    this.sink = new PluginLogSink({ directory: this.directory, ...options.limits });
    this.settings = { saveToDisk: false, verbose: false };
    this.management = Promise.resolve();
    try {
      if (fs.statSync(this.preferencesPath).size <= 1024) {
        const saved = JSON.parse(fs.readFileSync(this.preferencesPath, "utf8"));
        this.settings.saveToDisk = saved.saveToDisk === true;
        // Free-form diagnostics always require fresh consent after app restart.
      }
    } catch {}
    this.ready = this.sink.setEnabled(this.settings.saveToDisk).then(async () => {
      if (!this.sink.enabled && fs.existsSync(this.directory)) await this.sink.prune();
    }).catch(() => {
      this.sink.writeErrors++;
      this.settings.saveToDisk = false;
      this.sink.enabled = false;
    });
    this.retentionTimer = setInterval(() => {
      if (!fs.existsSync(this.directory) || this.sink.closed) return;
      this.sink.queue = this.sink.queue.then(() => this.sink.prune()).catch(() => { this.sink.writeErrors++; });
    }, 60 * 60 * 1000);
    this.retentionTimer.unref?.();
  }

  status() {
    return { ...this.settings, ...this.sink.status(), maxBytes: this.sink.maxBytes * this.sink.maxFiles,
      retentionDays: this.sink.retentionMs / 86400000 };
  }
  async configure(request) {
    if (!request || typeof request.saveToDisk !== "boolean" || typeof request.verbose !== "boolean") throw new TypeError("Invalid plugin log settings");
    return this.#manage(async () => {
      if (this.sink.closed) throw new Error("Plugin logging is closed");
      const settings = { saveToDisk: request.saveToDisk, verbose: request.saveToDisk && request.verbose };
      // Stop ingress before changing preferences. Failure leaves persistence off.
      this.settings = { saveToDisk: false, verbose: false };
      await this.sink.setEnabled(false);
      await fsp.mkdir(path.dirname(this.preferencesPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.preferencesPath}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify({ saveToDisk: settings.saveToDisk }), { mode: 0o600 });
      await fsp.rename(temporary, this.preferencesPath);
      await this.sink.setEnabled(settings.saveToDisk);
      this.settings = settings;
      return this.status();
    });
  }
  #manage(action) {
    const result = this.management.then(() => this.ready).then(action);
    this.management = result.catch(() => {});
    return result;
  }
  identity(identity, plugin) {
    // Only the injected HOST resolver may assign source and namespace identity.
    let source = null;
    try { source = this.resolveProvenance(Object.freeze({ pluginId: identity.pluginId, pluginVersion: identity.pluginVersion,
      archiveSha256: plugin?.archiveSha256 ?? null, securityPrincipal: identity.securityPrincipal })); } catch {}
    const metadata = Object.freeze({ pluginId: bounded(identity.pluginId), pluginVersion: bounded(identity.pluginVersion),
      runtimeId: bounded(identity.runtimeId), runtimeKind: bounded(identity.runtimeKind),
      archiveSha256: /^[a-f0-9]{64}$/u.test(plugin?.archiveSha256 ?? "") ? plugin.archiveSha256 : null,
      sourceId: sourceKey(source?.sourceId), sourceKind: sourceKey(source?.sourceKind), namespace: ownerKey(source?.namespace) });
    if (source?.isCurrent && typeof source.isCurrent === "function") {
      this.provenanceChecks.set(metadata, () => source.isCurrent() === true);
    }
    return metadata;
  }
  createLogger(identity, plugin) {
    const provenance = this.identity(identity, plugin);
    return new PluginLogger({ sink: this.sink, identity: provenance, verbose: () => this.settings.verbose, isCurrent: this.provenanceChecks.get(provenance), audit: (event) => this.audit(provenance, event) });
  }
  audit(identity, event) {
    if (!this.sink.enabled) return;
    // An allowlist, never spread request/response/error objects into an audit.
    const resources = Array.isArray(event.resources) ? event.resources.slice(0, 16) : [];
    this.sink.enqueue({ timestamp: new Date().toISOString(), recordType: "host-audit", trust: "host-observed",
      ...identity, operation: bounded(event.operation, 256),
      targetIds: resources.filter((item) => typeof item === "string").map((item) =>
        createHmac("sha256", this.salt).update(item.slice(0, 8192)).digest("hex")),
      authorization: ["allowed", "denied", "not-required", "not-reached", "unknown"].includes(event.authorization) ? event.authorization : "unknown",
      result: event.result === "ok" ? "ok" : "error",
      errorCode: Object.values(RPC_ERRORS).includes(event.errorCode) ? event.errorCode : event.result === "ok" ? null : RPC_ERRORS.internal,
      durationMs: count(event.durationMs), inputBytes: count(event.inputBytes), outputBytes: count(event.outputBytes) }, this.provenanceChecks.get(identity));
  }
  async openFolder() {
    return this.#manage(async () => {
      await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const error = await this.electron.shell.openPath(this.directory);
      if (error) throw new Error("Could not open plugin log folder");
      return this.status();
    });
  }
  async exportLogs() {
    return this.#manage(async () => {
      const result = await this.electron.dialog.showSaveDialog({ title: "Export local plugin logs", defaultPath: "netcatty-plugin-logs.jsonl" });
      if (result.canceled || !result.filePath) return this.status();
      if (path.resolve(result.filePath).startsWith(path.resolve(this.directory) + path.sep)) throw new Error("Choose a destination outside the log folder");
      const task = this.sink.queue.then(async () => {
        const chunks = [];
        for (let index = this.sink.maxFiles - 1; index >= 0; index--) {
          try {
            const stats = await fsp.lstat(this.sink.file(index));
            if (!stats.isFile() || stats.isSymbolicLink() || stats.size > this.sink.maxBytes) throw new Error("Unsafe plugin log file");
            if (await this.sink.retained(this.sink.file(index))) chunks.push(await fsp.readFile(this.sink.file(index)));
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        await fsp.writeFile(result.filePath, Buffer.concat(chunks), { mode: 0o600 });
      });
      this.sink.queue = task.catch(() => {});
      await task;
      return this.status();
    });
  }
  async clear() {
    return this.#manage(async () => {
      const result = await this.electron.dialog.showMessageBox({ type: "warning", title: "Clear local plugin logs?",
        message: "Delete the saved local audit and diagnostic files? The bounded security history in plugin permissions is kept.",
        buttons: ["Cancel", "Clear logs"], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response === 1) await this.sink.clear();
      return this.status();
    });
  }
  async close() {
    clearInterval(this.retentionTimer);
    await this.management;
    await this.ready;
    await this.sink.close();
  }
}
module.exports = { PluginLogService };
