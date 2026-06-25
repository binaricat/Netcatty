import { useCallback, useEffect, useState } from "react";
import type { KnownHost } from "../../domain/models";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import type { HostKeyInfo } from "../../components/terminal/TerminalHostKeyVerification";
import {
  createKnownHostFromPortForwardHostKeyInfo,
  enqueuePortForwardHostKeyVerification,
  removePortForwardHostKeyVerification,
  toPendingPortForwardHostKeyVerification,
  type PendingPortForwardHostKeyVerification,
  type PortForwardHostKeyRequest,
} from "../../components/port-forwarding/hostKeyVerification";

export interface PortForwardHostKeyVerificationState {
  hostKeyInfo: HostKeyInfo;
}

export const usePortForwardHostKeyVerification = (
  onAddKnownHost?: (knownHost: KnownHost) => void,
) => {
  const [pendingQueue, setPendingQueue] = useState<PendingPortForwardHostKeyVerification[]>([]);
  const pending = pendingQueue[0] ?? null;

  useEffect(() => {
    const dispose = netcattyBridge.get()?.onHostKeyVerification?.((request: PortForwardHostKeyRequest) => {
      const next = toPendingPortForwardHostKeyVerification(request);
      if (!next) return;
      setPendingQueue((queue) => enqueuePortForwardHostKeyVerification(queue, next));
    });

    return () => {
      dispose?.();
    };
  }, []);

  const respond = useCallback((accept: boolean, addToKnownHosts = false) => {
    if (!pending) return;
    if (accept && addToKnownHosts) {
      onAddKnownHost?.(createKnownHostFromPortForwardHostKeyInfo(pending.hostKeyInfo));
    }
    void netcattyBridge.get()?.respondHostKeyVerification?.(
      pending.requestId,
      accept,
      addToKnownHosts,
    );
    setPendingQueue((queue) => removePortForwardHostKeyVerification(queue, pending.requestId));
  }, [onAddKnownHost, pending]);

  return {
    hostKeyVerification: pending ? { hostKeyInfo: pending.hostKeyInfo } : null,
    rejectHostKeyVerification: () => respond(false),
    acceptHostKeyVerification: () => respond(true, false),
    acceptAndSaveHostKeyVerification: () => respond(true, true),
  };
};
