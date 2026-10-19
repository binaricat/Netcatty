import { useEffect, useRef, useState } from "react";
import { useAppVaultRuntime } from "./appRuntimeBridge";
import { useMonitorSnapshot } from "./monitorRuntimeStore";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  createKnownHostFromHostKeyInfo,
  upsertKnownHost,
} from "../../domain/knownHosts";
import { toHostKeyInfo } from "../../domain/hostKey";
type Request = Parameters<
  Parameters<NonNullable<NetcattyBridge["onHostKeyVerification"]>>[0]
>[0];
export function useMonitorHostKeyVerification() {
  const { knownHosts, updateKnownHosts } = useAppVaultRuntime();
  const [request, setRequest] = useState<Request | null>(null);
  const snapshot = useMonitorSnapshot();
  const receivedAt = useRef(0);
  useEffect(
    () =>
      netcattyBridge.get()?.onHostKeyVerification?.((r) => {
        if (r.sessionId?.startsWith("monitor-")) {
          receivedAt.current = Date.now();
          setRequest(r);
        }
      }),
    [],
  );
  const respond = (accept: boolean, save = false) => {
    if (!request) return;
    if (accept && save)
      updateKnownHosts(
        upsertKnownHost(
          knownHosts,
          createKnownHostFromHostKeyInfo(toHostKeyInfo(request)),
        ),
      );
    void netcattyBridge
      .get()
      ?.respondHostKeyVerification?.(request.requestId, accept, save);
    setRequest(null);
  };
  useEffect(() => {
    if (
      request &&
      snapshot.takenAt >= receivedAt.current &&
      (!snapshot.running.length ||
        !snapshot.activeSessions.includes(request.sessionId ?? ""))
    ) {
      void netcattyBridge
        .get()
        ?.respondHostKeyVerification?.(request.requestId, false, false);
      setRequest(null);
    }
  }, [
    request,
    snapshot.running.length,
    snapshot.takenAt,
    snapshot.activeSessions,
  ]);
  return { request, respond };
}
