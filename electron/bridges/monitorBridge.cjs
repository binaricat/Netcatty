"use strict";
const { randomUUID } = require("node:crypto");
const pool = require("./sshConnectionPool.cjs");
const {
  readSharedStats,
  cancelSharedStats,
} = require("./sshBridge/sharedStats.cjs");

/** Worker-owned volatile demand graph. The SSH registry remains the only connection pool. */
function createMonitorService({
  startConnection,
  cancelConnection,
  getStats,
  prepareOptions,
  now = Date.now,
  timers = globalThis,
}) {
  const panels = new Map();
  const entries = new Map();
  const revisions = new Map();
  const retries = new Map();
  let dialTail = Promise.resolve();
  let disposed = false;
  let epoch = 0;
  const runtimeId = randomUUID();
  function keyFor(options) {
    return pool.buildEndpointKey(pool.buildConnectionReuseEndpoint(options));
  }
  function publishState(entry, status) {
    entry.status = status;
  }
  function release(entry) {
    entry.cancelled = true;
    entry.controller.abort();
    if (entry.timer) timers.clearTimeout(entry.timer);
    if (entry.connecting) cancelConnection(entry.sessionId);
    if (entry.transport) {
      const identity = pool.buildEndpointKey(entry.transport.endpoint);
      const stillNeeded = [...entries.values()].some(
        (other) =>
          other !== entry &&
          !other.cancelled &&
          other.transport &&
          (other.transport.conn === entry.transport.conn ||
            pool.buildEndpointKey(other.transport.endpoint) === identity),
      );
      if (!stillNeeded) cancelSharedStats(entry.transport.conn);
      pool.returnTransport(entry.holder);
    }
    entries.delete(entry.key);
  }
  function intervalFor(entry) {
    return Math.min(
      ...[...panels.values()]
        .filter((p) => p.keys.includes(entry.key))
        .map((p) => p.interval),
    );
  }
  async function collect(entry) {
    if (entry.cancelled || !entry.transport || entry.sampling) return;
    entry.sampling = true;
    if (
      entry.transport.state === "dead" ||
      entry.transport.state === "closing"
    ) {
      entry.sampling = false;
      publishState(entry, "disconnected");
      return;
    }
    try {
      const result = await getStats({
        conn: entry.transport.conn,
        hostname: entry.hostname,
        _monitorStats: true,
        _monitorIntervalMs: intervalFor(entry) * 1000,
        _monitorFreshAfter: Math.max(...[...panels.values()].filter((panel) => panel.keys.includes(entry.key)).map((panel) => panel.startedAt)),
        _reuseEndpoint: entry.transport.endpoint,
      });
      if (entry.cancelled) return;
      if (result.success) {
        entry.failures = 0;
        publishState(entry, "live");
      } else {
        entry.failures++;
        publishState(
          entry,
          /not supported|unsupported|parse/i.test(result.error ?? "")
            ? "unsupported"
            : "error",
        );
      }
    } catch {
      if (!entry.cancelled) {
        entry.failures++;
        publishState(entry, "error");
      }
    }
    entry.sampling = false;
    if (!entry.cancelled && entry.status !== "unsupported") {
      const delay =
        intervalFor(entry) * 1000 * Math.min(6, 2 ** entry.failures);
      entry.due = now() + delay;
      entry.timer = timers.setTimeout(() => {
        entry.timer = null;
        void collect(entry);
      }, delay);
      entry.timer?.unref?.();
    }
  }
  async function attachTransport(entry, transport) {
    if (entry.cancelled || disposed) {
      const holder = {};
      pool.borrowTransport(transport, {
        kind: pool.LEASE_KINDS.monitor,
        holder,
      });
      pool.returnTransport(holder);
      return;
    }
    // Borrow before awaiting module loading: stop can always find this lease.
    entry.transport = transport;
    pool.borrowTransport(transport, {
      kind: pool.LEASE_KINDS.monitor,
      holder: entry.holder,
    });
    entry.connecting = false;
    const { detectVendorFromSshVersion } =
      await import("../../domain/sshServerVendor.mjs");
    if (entry.cancelled || disposed) return;
    if (
      detectVendorFromSshVersion(transport.conn?._remoteVer) ||
      require("../../domain/singleChannelSshBanner.shared.cjs").remoteSoftwareRequiresSingleChannel(
        transport.conn?._remoteVer,
      )
    ) {
      pool.returnTransport(entry.holder);
      entry.transport = null;
      publishState(entry, "unsupported");
      return;
    }
    entry.ready = true;
    void collect(entry);
  }
  function connect(entry, event, options) {
    const reusable = pool.findTransportByEndpoint(
      pool.buildConnectionReuseEndpoint(options),
    );
    if (reusable) {
      void attachTransport(entry, reusable).catch(() => {
        if (!entry.cancelled) publishState(entry, "error");
      });
      return;
    }
    // All new authentications are serialized. Shared transports need no prompt.
    dialTail = dialTail
      .catch(() => {})
      .then(async () => {
        if (entry.cancelled || disposed) return;
        let coordination;
        try {
          publishState(entry, "connecting");
          entry.connecting = true;
          coordination = pool.beginTransportDial(
            pool.buildConnectionReuseEndpoint(options),
            { kind: "channel" },
          );
          let transport;
          if (coordination.role === "reuse") transport = coordination.transport;
          else if (coordination.role === "join")
            transport = await pool.waitForTransportDial(coordination, {
              signal: entry.controller.signal,
            });
          else {
            const result = await startConnection(event, {
              ...options,
              sessionId: entry.sessionId,
              reuseTransport: false,
              _monitorMode: true,
              sshDebugLogEnabled: false,
              _passphraseSignal: entry.controller.signal,
            });
            transport = result.transport;
            if (!transport)
              throw new Error(
                "Monitor authentication did not produce a transport",
              );
            pool.completeTransportDial(coordination, transport);
          }
          await attachTransport(entry, transport);
        } catch (error) {
          if (coordination?.role === "leader")
            pool.failTransportDial(coordination, error);
          entry.connecting = false;
          if (!entry.cancelled) publishState(entry, "login");
        }
      });
  }
  function reconcile(event, input) {
    if (!prepareOptions) return reconcilePrepared(event, input);
    const owner = event.sender.id;
    const revision = (revisions.get(owner) ?? 0) + 1;
    revisions.set(owner, revision);
    return Promise.all(
      input.map(async (panel) => ({
        ...panel,
        hosts: await Promise.all(
          panel.hosts.map(async (host) => ({
            ...host,
            options: host.options
              ? await prepareOptions(host.options)
              : undefined,
          })),
        ),
      })),
    ).then((prepared) => {
      if (revisions.get(owner) !== revision) return snapshot(event);
      return reconcilePrepared(event, prepared);
    });
  }
  function reconcilePrepared(event, input) {
    if (!Array.isArray(input)) throw new Error("Invalid monitor configuration");
    const owner = event.sender.id;
    const wanted = new Set();
    const freshKeys = new Set();
    for (const panel of input) {
      if (typeof panel.id !== "string" || !Array.isArray(panel.hosts)) continue;
      const id = `${owner}:${panel.id}`;
      wanted.add(id);
      const keys = [];
      const hosts = [];
      for (const host of panel.hosts) {
        if (typeof host.id !== "string") continue;
        const options = host.options;
        if (!options || options.singleChannelSsh || !options.hostname) {
          hosts.push({
            id: host.id,
            status:
              host.status === "login" || host.status === "error"
                ? host.status
                : "unsupported",
          });
          continue;
        }
        const key = keyFor(options);
        if (!key) {
          hosts.push({ id: host.id, status: "unsupported" });
          continue;
        }
        keys.push(key);
        hosts.push({ id: host.id, key });
        hosts[hosts.length - 1].options = options;
      }
      const interval = [1, 2, 3, 5, 10, 30, 60].includes(panel.interval) ? panel.interval : 5;
      const previous = panels.get(id);
      const fresh = !previous || previous.interval !== interval || previous.runId !== panel.runId;
      if (fresh) for (const key of keys) freshKeys.add(key);
      panels.set(id, {
        event,
        owner,
        id: panel.id,
        keys,
        hosts,
        interval,
        runId: panel.runId,
        startedAt: fresh ? now() : previous.startedAt,
      });
    }
    for (const [id, panel] of panels)
      if (panel.owner === owner && !wanted.has(id)) panels.delete(id);
    const needed = new Set([...panels.values()].flatMap((p) => p.keys));
    const ownKeys = new Set(
      [...panels.values()]
        .filter((p) => p.owner === owner)
        .flatMap((p) => p.keys),
    );
    const retryKeys = retries.get(owner) ?? new Set();
    retries.delete(owner);
    // Release obsolete demand before applying the limit. A credential-changing
    // retry keeps other windows' old identity available in its existing state.
    for (const entry of entries.values())
      if (
        !needed.has(entry.key) ||
        (!entry.transport &&
          entry.owner === owner &&
          !ownKeys.has(entry.key)) ||
        (ownKeys.has(entry.key) && retryKeys.has(entry.key))
      )
        release(entry);
    admitEntries(owner);
    for (const entry of entries.values()) {
      if (freshKeys.has(entry.key) && entry.ready && entry.transport && !entry.sampling) {
        if (entry.timer) timers.clearTimeout(entry.timer);
        entry.timer = null;
        void collect(entry);
        continue;
      }
      if (entry.timer && entry.due - now() > intervalFor(entry) * 1000) {
        timers.clearTimeout(entry.timer);
        entry.due = now() + intervalFor(entry) * 1000;
        entry.timer = timers.setTimeout(
          () => {
            entry.timer = null;
            void collect(entry);
          },
          intervalFor(entry) * 1000,
        );
        entry.timer?.unref?.();
      }
    }
    return snapshot(event);
  }
  function admitEntries(preferredOwner) {
    const candidates = [...panels.values()].sort(
      (a, b) =>
        Number(b.owner === preferredOwner) - Number(a.owner === preferredOwner),
    );
    for (const panel of candidates)
      for (const host of panel.hosts) {
        if (!host.key || entries.has(host.key) || entries.size >= 256) continue;
        const entry = {
          key: host.key,
          historyId: randomUUID(),
          hostname: host.options.hostname,
          sessionId: `monitor-${randomUUID()}`,
          holder: {},
          owner: panel.owner,
          status: "queued",
          failures: 0,
          ready: false,
          transport: null,
          timer: null,
          cancelled: false,
          controller: new AbortController(),
        };
        entries.set(host.key, entry);
        connect(entry, panel.event, host.options);
      }
  }
  function snapshot(event, cursor) {
    const own = [...panels.values()].filter((p) => p.owner === event.sender.id);
    const append = cursor?.runtimeId === runtimeId && cursor.epoch === epoch;
    const hosts = {};
    for (const panel of own)
      for (const host of panel.hosts) {
        const entry = entries.get(host.key);
        const shared = entry?.transport
          ? readSharedStats(entry.transport.conn)
          : null;
        const historyId = entry?.historyId ?? "";
        const last = cursor?.after?.[host.id];
        hosts[host.id] = {
          historyId,
          status: entry?.status ?? host.status ?? "limit",
          at: shared?.at ?? 0,
          statsAt: shared?.statsAt ?? shared?.at ?? 0,
          ...(append && last?.historyId === historyId && last.statsAt === (shared?.statsAt ?? shared?.at ?? 0)
            ? {}
            : { stats: shared?.result?.success ? shared.result.stats : null }),
          points: append && last?.historyId === historyId
            ? (shared?.points ?? []).filter((point) => point.at > last.at)
            : shared?.points ?? [],
        };
      }
    return {
      epoch,
      historyMode: append ? "append" : "replace",
      runtimeId,
      takenAt: now(),
      activeSessions: [
        ...new Set(
          own
            .flatMap((p) => p.keys)
            .map((key) => entries.get(key))
            .filter((entry) => entry && !entry.cancelled)
            .map((entry) => entry.sessionId),
        ),
      ],
      running: own.map((p) => p.id),
      startedAt: Object.fromEntries(own.map((p) => [p.id, p.startedAt])),
      count: panels.size,
      hostCount: entries.size,
      hosts,
    };
  }
  function removeOwner(owner) {
    retries.delete(owner);
    revisions.set(owner, (revisions.get(owner) ?? 0) + 1);
    for (const [id, p] of panels) if (p.owner === owner) panels.delete(id);
    const needed = new Set([...panels.values()].flatMap((p) => p.keys));
    for (const entry of entries.values()) {
      if (!needed.has(entry.key)) release(entry);
      else if (!entry.transport && entry.owner === owner) release(entry);
    }
    admitEntries();
  }

  function stopAll() {
    epoch++;
    for (const [owner, revision] of revisions)
      revisions.set(owner, revision + 1);
    panels.clear();
    retries.clear();
    for (const entry of entries.values()) release(entry);
  }
  function retry(event, hostId) {
    const keys = retries.get(event.sender.id) ?? new Set();
    for (const p of panels.values())
      if (p.owner === event.sender.id)
        for (const host of p.hosts) {
          const entry = entries.get(host.key);
          if (
            host.id === hostId &&
            entry &&
            ["login", "error", "unsupported", "disconnected"].includes(
              entry.status,
            )
          )
            keys.add(host.key);
        }
    retries.set(event.sender.id, keys);
  }

  return {
    reconcile,
    snapshot,
    removeOwner,
    stopAll,
    retry,
    dispose() {
      disposed = true;
      stopAll();
    },
  };
}
module.exports = { createMonitorService };
