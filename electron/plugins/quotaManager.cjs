"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const DEFAULT_QUOTAS = Object.freeze({
  messageBurst: 1024,
  messagesPerSecond: 512,
  concurrentCapabilities: 64,
  capabilityBurst: 240,
  capabilitiesPerMinute: 2400,
  logWritesPerMinute: 240,
  bytesPerMinute: 128 * 1024 * 1024,
  streamBytesPerMinute: 512 * 1024 * 1024,
  memoryBytes: 256 * 1024 * 1024,
  cpuPercent: 80,
  sustainedCpuSamples: 3,
  sampleIntervalMs: 5_000,
});

function quotaError(message) {
  return new PluginRpcError(RPC_ERRORS.resourceExhausted, message, {
    pluginCode: "resource_exhausted",
  });
}

class TokenBucket {
  constructor(capacity, refillPerMs, clock) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.clock = clock;
    this.tokens = capacity;
    this.updatedAt = clock();
  }

  consume(amount = 1) {
    const now = this.clock();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) * this.refillPerMs));
    this.updatedAt = now;
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}

class PluginQuotaManager {
  constructor(options = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.quotas = Object.freeze({
      ...DEFAULT_QUOTAS,
      ...(options.quotas ?? {}),
      streamBytesPerMinute: options.quotas?.streamBytesPerMinute
        ?? (options.quotas?.bytesPerMinute ?? DEFAULT_QUOTAS.streamBytesPerMinute),
    });
    this.getProcessMetrics = options.getProcessMetrics ?? null;
    this.onViolation = options.onViolation ?? (() => {});
    this.setInterval = options.setInterval ?? setInterval;
    this.clearInterval = options.clearInterval ?? clearInterval;
    this.messageBuckets = new Map();
    this.capabilityBuckets = new Map();
    this.logBuckets = new Map();
    this.concurrent = new Map();
    this.byteWindows = new Map();
    this.monitors = new Map();
  }

  setViolationHandler(handler) {
    if (typeof handler !== "function") throw new TypeError("Plugin quota violation handler must be a function");
    this.onViolation = handler;
  }

  #bucket(collection, key, capacity, refillPerMs) {
    let bucket = collection.get(key);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillPerMs, this.clock);
      collection.set(key, bucket);
    }
    return bucket;
  }

  guardMessage(identity) {
    const bucket = this.#bucket(
      this.messageBuckets,
      identity.runtimeId,
      this.quotas.messageBurst,
      this.quotas.messagesPerSecond / 1_000,
    );
    if (!bucket.consume()) throw quotaError("Plugin runtime message rate exceeded");
  }

  createMiddleware() {
    return async (context, next) => {
      const runtimeId = context.runtimeId;
      const current = this.concurrent.get(runtimeId) ?? 0;
      if (current >= this.quotas.concurrentCapabilities) {
        throw quotaError("Plugin concurrent capability limit exceeded");
      }
      const capabilityBucket = this.#bucket(
        this.capabilityBuckets,
        runtimeId,
        this.quotas.capabilityBurst,
        this.quotas.capabilitiesPerMinute / 60_000,
      );
      if (!capabilityBucket.consume()) throw quotaError("Plugin capability request rate exceeded");
      if (context.method === "log.write") {
        const logBucket = this.#bucket(
          this.logBuckets,
          runtimeId,
          this.quotas.logWritesPerMinute,
          this.quotas.logWritesPerMinute / 60_000,
        );
        if (!logBucket.consume()) throw quotaError("Plugin log rate exceeded");
      }
      this.concurrent.set(runtimeId, current + 1);
      try { return await next(); }
      finally {
        const remaining = (this.concurrent.get(runtimeId) ?? 1) - 1;
        if (remaining <= 0) this.concurrent.delete(runtimeId);
        else this.concurrent.set(runtimeId, remaining);
      }
    };
  }

  chargeBytes(runtimeId, category, byteLength) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new TypeError("Plugin quota bytes are invalid");
    const key = `${runtimeId}\0${category}`;
    const now = this.clock();
    let window = this.byteWindows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, bytes: 0 };
      this.byteWindows.set(key, window);
    }
    window.bytes += byteLength;
    const limit = category === "network.stream"
      ? this.quotas.streamBytesPerMinute
      : this.quotas.bytesPerMinute;
    if (window.bytes > limit) {
      throw quotaError(`Plugin ${category} byte quota exceeded`);
    }
  }

  trackRuntime(identity, runtime) {
    return this.trackProcess(identity.runtimeId, identity, runtime);
  }

  trackProcess(resourceId, identity, processHandle) {
    this.releaseProcess(resourceId);
    if (!this.getProcessMetrics || typeof processHandle.getProcessId !== "function") {
      return Object.freeze({ dispose() {} });
    }
    let disposed = false;
    let sampling = false;
    let sustainedCpu = 0;
    const sample = async () => {
      if (disposed || sampling) return;
      sampling = true;
      try {
        const pid = processHandle.getProcessId();
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        const metrics = await this.getProcessMetrics(pid);
        if (!metrics) return;
        if (metrics.memoryBytes > this.quotas.memoryBytes) {
          disposed = true;
          this.clearInterval(timer);
          await this.onViolation(identity, quotaError("Plugin memory quota exceeded"));
          return;
        }
        sustainedCpu = metrics.cpuPercent > this.quotas.cpuPercent ? sustainedCpu + 1 : 0;
        if (sustainedCpu >= this.quotas.sustainedCpuSamples) {
          disposed = true;
          this.clearInterval(timer);
          await this.onViolation(identity, quotaError("Plugin sustained CPU quota exceeded"));
        }
      } catch {
        // Metrics are advisory. Capability and transport quotas remain fail-closed.
      } finally {
        sampling = false;
      }
    };
    const timer = this.setInterval(sample, this.quotas.sampleIntervalMs);
    timer.unref?.();
    const monitor = Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.clearInterval(timer);
      },
    });
    this.monitors.set(resourceId, monitor);
    void sample();
    return monitor;
  }

  releaseProcess(resourceId) {
    this.monitors.get(resourceId)?.dispose();
    this.monitors.delete(resourceId);
  }

  releaseRuntime(runtimeId) {
    for (const resourceId of [...this.monitors.keys()]) {
      if (resourceId === runtimeId || resourceId.startsWith(`${runtimeId}\0`)) {
        this.releaseProcess(resourceId);
      }
    }
    this.messageBuckets.delete(runtimeId);
    this.capabilityBuckets.delete(runtimeId);
    this.logBuckets.delete(runtimeId);
    this.concurrent.delete(runtimeId);
    for (const key of [...this.byteWindows.keys()]) {
      if (key.startsWith(`${runtimeId}\0`)) this.byteWindows.delete(key);
    }
  }

  shutdown() {
    for (const monitor of this.monitors.values()) monitor.dispose();
    this.monitors.clear();
    this.messageBuckets.clear();
    this.capabilityBuckets.clear();
    this.logBuckets.clear();
    this.concurrent.clear();
    this.byteWindows.clear();
  }
}

module.exports = { DEFAULT_QUOTAS, PluginQuotaManager, TokenBucket, quotaError };
