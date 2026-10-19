"use strict";
const { executeBoundedSshCommand } = require("../boundedSshExec.cjs");

const GPU_ASSIGNMENT = `gpustat=$(gpucsv=$(timeout -s KILL 2 nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>/dev/null) && printf '%s\\n' "$gpucsv" | awk -F', *' 'NF >= 4 {g++; if($1 ~ /^[0-9]+$/) {n++; u+=$1} if($2 ~ /^[0-9]+$/) {mu+=$2; uc++} if($3 ~ /^[0-9]+$/) {mt+=$3; tc++} if(name=="") name=$4} END{if(n>0) printf "%.0f %s %s %s", u/n, (uc==g ? sprintf("%.0f",mu) : "N/A"), (tc==g ? sprintf("%.0f",mt) : "N/A"), name}' 2>/dev/null || echo "")`;
const EMPTY_GPU = {
  gpu: null,
  gpuName: null,
  gpuMemUsed: null,
  gpuMemTotal: null,
};
const states = new WeakMap();
function stateFor(conn) {
  let state = states.get(conn);
  if (!state) {
    state = {
      stats: EMPTY_GPU,
      nextAt: 0,
      pending: null,
      controller: null,
      updatedAt: 0,
      disabled: false,
    };
    states.set(conn, state);
  }
  return state;
}
function updateGpuStats(state, next) {
  if (Object.keys(EMPTY_GPU).some((key) => state.stats[key] !== next[key])) {
    // Publication time is separate from CPU history and strictly advances even
    // when a fast GPU reply shares the CPU sample's millisecond.
    state.updatedAt = Math.max(Date.now() + 1, state.updatedAt + 1);
  }
  state.stats = next;
}
function monitorGpuUpdatedAt(conn) {
  return states.get(conn)?.updatedAt ?? 0;
}
function parseGpuStats(output) {
  const raw =
    String(output || "")
      .split("|")
      .find((part) => part.startsWith("GPU:"))
      ?.slice(4)
      .trim()
      .split(/\s+/) ?? [];
  const utilization = parseInt(raw[0], 10);
  if (!Number.isFinite(utilization)) return EMPTY_GPU;
  const number = (value) =>
    Number.isFinite(parseInt(value, 10)) ? parseInt(value, 10) : null;
  return {
    gpu: Math.max(0, Math.min(100, utilization)),
    gpuName: raw.slice(3).join(" ") || null,
    gpuMemUsed: number(raw[1]),
    gpuMemTotal: number(raw[2]),
  };
}
function withCachedMonitorGpu(conn, result) {
  const state = states.get(conn);
  return state && result?.success
    ? { ...result, stats: { ...result.stats, ...state.stats } }
    : result;
}
function cacheFullGpuStats(conn, stats) {
  const state = stateFor(conn);
  state.controller?.abort();
  updateGpuStats(
    state,
    Object.fromEntries(
      Object.keys(EMPTY_GPU).map((key) => [key, stats[key] ?? null]),
    ),
  );
  state.nextAt = Date.now() + 10000;
}
/** Optional GPU work never joins the CPU/memory sampler or its history clock. */
function startMonitorGpuProbe(conn, command, options = {}) {
  const state = stateFor(conn);
  if (state.disabled || state.pending || Date.now() < state.nextAt) return;
  const controller = new AbortController();
  state.controller = controller;
  state.nextAt = Date.now() + 30000;
  state.pending = Promise.resolve()
    .then(() =>
      executeBoundedSshCommand(conn, command, {
        ...options,
        signal: controller.signal,
        invalidateTransportOnAbort: false,
        invalidateOnOpenTimeout: false,
        openingTimeoutMs: 2500,
        runTimeoutMs: 2500,
        maxOutputBytes: 65536,
      }),
    )
    .then(({ stdout }) => {
      if (controller.signal.aborted) return;
      updateGpuStats(state, parseGpuStats(stdout));
      state.nextAt = Date.now() + (state.stats.gpu == null ? 30000 : 10000);
    })
    .catch((error) => {
      // A timed-out channel open cannot be withdrawn from ssh2's request FIFO.
      // Keep this optional probe from disconnecting SSH or piling up requests.
      if (error?.code === "SSH_EXEC_OPEN_TIMEOUT") state.disabled = true;
      if (!controller.signal.aborted) updateGpuStats(state, EMPTY_GPU);
    })
    .finally(() => {
      state.pending = null;
      if (state.controller === controller) state.controller = null;
    });
}
function cancelMonitorGpuProbe(conn) {
  states.get(conn)?.controller?.abort();
}
module.exports = {
  GPU_ASSIGNMENT,
  monitorGpuUpdatedAt,
  parseGpuStats,
  withCachedMonitorGpu,
  cacheFullGpuStats,
  startMonitorGpuProbe,
  cancelMonitorGpuProbe,
};
