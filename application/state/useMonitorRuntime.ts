import { hostRestrictsExtraSshChannels } from "../../domain/host";
import { useEffect, useRef, useState } from "react";
import { buildHostConnectionTestPlan } from "../../domain/hostConnectionTest";
import { resolveEffectiveTerminalHost } from "../../domain/terminalHostResolution";
import { getEffectiveKnownHosts } from "../../infrastructure/syncHelpers";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  useAppLockChrome,
  useAppSettingsRuntime,
  useAppVaultRuntime,
} from "./appRuntimeBridge";
import { useMonitorPanels } from "./monitorPanelsStorage";
import {
  monitorActions,
  getMonitorHistoryCursor,
  isIdleMonitorSnapshot,
  publishMonitorSnapshot,
  publishMonitorUnavailable,
} from "./monitorRuntimeStore";
import type { MonitorPanelDemand } from "../../domain/monitorRuntime";

/** Root lifetime, independent of Vault navigation. No runtime state is persisted. */
export function useMonitorRuntime() {
  const panels = useMonitorPanels();
  const {
    hosts,
    keys,
    identities,
    groupConfigs,
    proxyProfiles,
    knownHosts,
    isInitialized,
  } = useAppVaultRuntime();
  const { terminalSettings } = useAppSettingsRuntime();
  const { locked } = useAppLockChrome();
  const [running, setRunning] = useState(() => new Map<string, string>());
  const [retryVersion, setRetryVersion] = useState(0);
  const epoch = useRef<number | null>(null);
  const runtimeId = useRef<string | null>(null);
  const credentials = useRef(
    new Map<string, { username: string; password: string }>(),
  );
  useEffect(() => {
    monitorActions.start = (id) =>
      setRunning((prev) => new Map(prev).set(id, crypto.randomUUID()));
    monitorActions.stop = (id) =>
      setRunning((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    monitorActions.stopAll = () => {
      credentials.current.clear();
      setRunning(new Map());
      void netcattyBridge.get()?.monitorStopAll?.();
    };
    monitorActions.retry = (id, override) => {
      if (override) credentials.current.set(id, override);
      void netcattyBridge
        .get()
        ?.monitorRetry?.(id)
        .then(() => setRetryVersion((v) => v + 1));
    };
    const offline = () => monitorActions.stopAll();
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("offline", offline);
      void netcattyBridge.get()?.monitorUpdate?.([]);
    };
  }, []);
  useEffect(() => {
    if (locked || !isInitialized) {
      credentials.current.clear();
      setRunning(new Map());
    }
  }, [locked, isInitialized]);
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.monitorUpdate) {
      publishMonitorUnavailable();
      return;
    }
    const demand: MonitorPanelDemand[] =
      locked || !isInitialized
        ? []
        : panels
            .filter((p) => running.has(p.id))
            .map((panel) => ({
              id: panel.id,
              runId: running.get(panel.id)!,
              interval: panel.interval,
              hosts: panel.hostIds.map((id) => {
                const host = hosts.find((h) => h.id === id);
                if (
                  !host ||
                  (host.protocol && host.protocol !== "ssh") ||
                  hostRestrictsExtraSshChannels(host)
                )
                  return { id };
                const effective = resolveEffectiveTerminalHost({
                  host,
                  groupConfigs,
                  proxyProfiles,
                });
                const plan = buildHostConnectionTestPlan({
                  host,
                  hosts,
                  keys,
                  identities,
                  groupConfigs,
                  proxyProfiles,
                  knownHosts: getEffectiveKnownHosts(knownHosts) ?? [],
                  terminalSettings,
                  sessionId: `monitor-${id}`,
                  bootEpoch: 0,
                  authOverride: credentials.current.has(id)
                    ? { ...credentials.current.get(id), authMethod: "password" }
                    : null,
                });
                if (!plan.ok) return { id, status: "error" as const };
                if (plan.needsCredentialReentry)
                  return { id, status: "login" as const };
                return {
                  id,
                  options: {
                    ...plan.options,
                    singleChannelSsh: hostRestrictsExtraSshChannels(effective),
                    sshAuthReadyTimeoutMs: 120000,
                    agentForwarding: effective.agentForwarding,
                  },
                };
              }),
            }));
    const activeHostIds = new Set(
      demand.flatMap((p) => p.hosts.map((h) => h.id)),
    );
    for (const id of credentials.current.keys())
      if (!activeHostIds.has(id)) credentials.current.delete(id);
    void bridge
      .monitorUpdate(demand)
      .then(publishMonitorSnapshot)
      .catch(() => {
        credentials.current.clear();
        setRunning((prev) => (prev.size ? new Map() : prev));
        publishMonitorUnavailable();
      });
  }, [
    panels,
    running,
    hosts,
    keys,
    identities,
    groupConfigs,
    proxyProfiles,
    knownHosts,
    terminalSettings,
    locked,
    isInitialized,
    retryVersion,
  ]);
  // Poll every second while anything is monitored (here or in another window);
  // otherwise only every 10 s to notice monitors started elsewhere. Pause
  // renderer polling while hidden and run an immediate catch-up poll on return
  // to visible (main-process sampling stays untouched).
  const hasRunningPanels = running.size > 0;
  useEffect(() => {
    const bridge = netcattyBridge.get();
    let disposed = false;
    let pending = false;
    let resyncOnIdle = false;
    let remoteRunning = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isHidden = () => {
      if (typeof document === "undefined") return false;
      if (typeof document.visibilityState === "string") {
        return document.visibilityState === "hidden";
      }
      return document.hidden === true;
    };
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const poll = async () => {
      if (disposed || pending || isHidden() || !bridge?.monitorSnapshot) return;
      pending = true;
      try {
        const snapshot = await bridge.monitorSnapshot(getMonitorHistoryCursor());
        if (disposed) return;
        remoteRunning = !isIdleMonitorSnapshot(snapshot);
        if (
          (epoch.current !== null && epoch.current !== snapshot.epoch) ||
          (runtimeId.current !== null &&
            runtimeId.current !== snapshot.runtimeId)
        ) {
          credentials.current.clear();
          setRunning(new Map());
        }
        epoch.current = snapshot.epoch;
        runtimeId.current = snapshot.runtimeId;
        publishMonitorSnapshot(snapshot);
      } catch {
        credentials.current.clear();
        setRunning((prev) => (prev.size ? new Map() : prev));
        publishMonitorUnavailable();
      } finally {
        pending = false;
      }
    };
    const schedule = () => {
      if (disposed || isHidden()) return;
      if (resyncOnIdle) {
        resyncOnIdle = false;
        void poll().finally(schedule);
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void poll().finally(schedule);
      }, hasRunningPanels || remoteRunning ? 1000 : 10_000);
    };
    const handleVisibilityChange = () => {
      if (disposed) return;
      if (isHidden()) {
        resyncOnIdle = false;
        clearTimer();
        return;
      }
      clearTimer();
      if (pending) {
        resyncOnIdle = true;
        return;
      }
      void poll().finally(schedule);
    };
    const doc = typeof document !== "undefined" ? document : null;
    doc?.addEventListener?.("visibilitychange", handleVisibilityChange);
    if (!isHidden()) {
      void poll().finally(schedule);
    }
    return () => {
      disposed = true;
      clearTimer();
      doc?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    };
  }, [hasRunningPanels]);
}
