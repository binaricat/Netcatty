"use strict";
// One in-memory sampler per physical authenticated transport. No persistence/logging.
const { withCachedMonitorGpu, cancelMonitorGpuProbe, monitorGpuUpdatedAt } = require("./monitorGpuStats.cjs");
const { buildEndpointKey } = require("../sshConnectionPool.cjs");
let states = new WeakMap();
const identities = new Map();
const MAX_SAMPLERS = 512;
function prune() {
  const now = Date.now();
  for (const [key, history] of identities) {
    history.points = history.points.filter((p) => now - p.at <= 30 * 60000);
    if (now - history.at > 30 * 60000) identities.delete(key);
  }
}
const cleanupTimer = setInterval(prune, 60000);
cleanupTimer.unref?.();
function stateFor(conn, endpoint) {
  const key = endpoint ? buildEndpointKey(endpoint) : null;
  let state = states.get(conn);
  const history = (key ? identities.get(key) : null) || state?.history || {
    latest: null,
    at: 0,
    points: [],
    latestFull: false,
    fullResult: null,
    fullAt: 0,
    sequence: 0,
  };
  if (!state) {
    state = {
      context: { conn: null },
      pending: null,
      controller: null,
      pendingFull: false,
      history,
    };
    states.set(conn, state);
  } else if (key && !state.pending && !state.history.latest) {
    // A panel may read a snapshot before its first sample supplies the endpoint.
    // Attach that empty runtime to the existing history without moving live work.
    state.history = history;
  }
  // Share measurements/history by identity, but in-flight requests, abort
  // controllers and CPU/network baselines belong to the physical transport.
  // A reconnect must never join (or cancel) work on an older connection.
  if (key) {
    identities.delete(key);
    identities.set(key, state.history);
    if (identities.size > MAX_SAMPLERS) {
      const oldKey = identities.keys().next().value;
      identities.delete(oldKey);
    }
  }
  return state;
}
function appendPoint(state, result, now, freshAfter = 0) {
  if (
    !result.success ||
    !result.stats ||
    (now - (state.history.points.at(-1)?.at ?? 0) < 1000 && (state.history.points.at(-1)?.at ?? 0) > freshAfter)
  )
    return;
  const s = result.stats;
  state.history.points.push({
    at: now,
    cpu: s.cpu,
    memory:
      s.memTotal > 0 && Number.isFinite(s.memUsed)
        ? (s.memUsed / s.memTotal) * 100
        : null,
    disk: s.diskPercent,
    rx: s.networkReady ? s.netRxSpeed : null,
    tx: s.networkReady ? s.netTxSpeed : null,
  });
  state.history.points = state.history.points
    .filter((p) => now - p.at <= 30 * 60000)
    .slice(-1800);
}
async function sampleSharedStats(session, collect, now = Date.now()) {
  const conn = session.conn || session.moshStatsConn || session.etStatsConn;
  if (!conn) {
    const result = await collect(session);
    const companion = session.moshStatsConn || session.etStatsConn;
    if (companion && result.success) {
      const state = stateFor(companion);
      state.context.prevDiskIo = session.prevDiskIo;
      state.context.prevPartitionIo = session.prevPartitionIo;
      state.context.prevNetStats = session.prevNetStats;
      state.context.prevCpuStats = session.prevCpuStats;
      state.history.latest = result;
      state.history.at = Date.now();
      state.history.latestFull = true;
      state.history.fullResult = result;
      state.history.fullAt = state.history.at;
    }
    return result;
  }
  const state = stateFor(conn, session._reuseEndpoint);
  const full = !session._monitorStats;
  const cacheMs = full ? 4000 : Math.min(4000, session._monitorIntervalMs ?? 5000);
  if (full && state.history.fullResult?.success && now - state.history.fullAt < 4000)
    return state.history.fullResult;
  if (state.pending) {
    if (full) state.terminalJoined = true;
    if (!full || state.pendingFull) {
      const result = await state.pending;
      // A reset can join a terminal query that began before the new boundary.
      if (!full && state.history.at > session._monitorFreshAfter)
        appendPoint(state, result, state.history.at, session._monitorFreshAfter);
      return result;
    }
    // A terminal needs process and GPU fields omitted from a monitor-only query.
    // Finish the shared lightweight query, then upgrade once for all full readers.
    await state.pending;
    return sampleSharedStats(session, collect);
  }
  if (
    state.history.latest?.success &&
    now - state.history.at < cacheMs &&
    (full || state.history.at > (session._monitorFreshAfter ?? 0)) &&
    (!full || state.history.latestFull)
  )
    return state.history.latest;
  const collectFull = full;
  // Keep transport capabilities on the collection context; baseline is independent of a terminal.
  const companion = !session.conn;
  Object.assign(state.context, {
    conn: companion ? null : conn,
    moshStatsConn: session.moshStatsConn,
    etStatsConn: session.etStatsConn,
    type: session.type,
    singleChannelSsh: session.singleChannelSsh,
    hostname: session.hostname,
    _monitorStats: !collectFull,
  });
  // Starting a replacement retires older samples even if the new attempt fails.
  const sequence = ++state.history.sequence;
  state.controller = new AbortController();
  state.terminalJoined = full;
  state.pendingFull = collectFull;
  state.context.statsSignal = state.controller.signal;
  state.pending = Promise.resolve(collect(state.context))
    .then((result) => {
      if (!state.controller.signal.aborted && result.success && sequence === state.history.sequence) {
        state.history.latest = result;
        state.history.latestFull = collectFull;
        state.history.at = Date.now();
        if (collectFull) {
          state.history.fullResult = result;
          state.history.fullAt = state.history.at;
        }
        appendPoint(state, result, state.history.at, session._monitorFreshAfter);
      }
      return result;
    })
    .finally(() => {
      state.pending = null;
      state.controller = null;
      // The cache retains measurements and baselines, never a live connection.
      state.context.conn = null;
      state.context.moshStatsConn = null;
      state.context.etStatsConn = null;
    });
  return state.pending;
}
function readSharedStats(conn) {
  const state = stateFor(conn);
  if (state.history.points[0] && Date.now() - state.history.points[0].at > 30 * 60000)
    state.history.points = state.history.points.filter((p) => Date.now() - p.at <= 30 * 60000);
  return { result: state.history.latestFull ? state.history.latest : withCachedMonitorGpu(conn, state.history.latest), at: state.history.at, statsAt: Math.max(state.history.at, monitorGpuUpdatedAt(conn)), points: state.history.points };
}
function cancelSharedStats(conn) {
  cancelMonitorGpuProbe(conn);
  const state = states.get(conn);
  if (state && !state.terminalJoined) state.controller?.abort();
}
module.exports = {
  sampleSharedStats,
  readSharedStats,
  cancelSharedStats,
  resetSharedStatsForTests() {
    identities.clear();
    states = new WeakMap();
  },
};
