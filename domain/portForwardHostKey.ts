import type { KnownHost } from "./models";
import { createKnownHostFromHostKeyInfo } from "./knownHosts";
import {
  toHostKeyInfo,
  type HostKeyInfo,
  type HostKeyVerificationRequest,
} from "./hostKey";

export type { HostKeyInfo, HostKeyVerificationRequest };

export const isPortForwardHostKeySessionId = (sessionId?: string): boolean => {
  return typeof sessionId === "string" && (sessionId.startsWith("pf-") || sessionId.startsWith("plugin-stream-"));
};

export type PortForwardHostKeyRequest = HostKeyVerificationRequest & {
  requestId: string;
  sessionId?: string;
};

export interface PendingPortForwardHostKeyVerification {
  requestId: string;
  hostKeyInfo: HostKeyInfo;
}

export const toPendingPortForwardHostKeyVerification = (
  request: PortForwardHostKeyRequest,
): PendingPortForwardHostKeyVerification | null => {
  if (!isPortForwardHostKeySessionId(request.sessionId)) return null;
  return {
    requestId: request.requestId,
    hostKeyInfo: toHostKeyInfo(request),
  };
};

export const enqueuePortForwardHostKeyVerification = (
  queue: PendingPortForwardHostKeyVerification[],
  pending: PendingPortForwardHostKeyVerification,
): PendingPortForwardHostKeyVerification[] => [...queue, pending];

export const removePortForwardHostKeyVerification = (
  queue: PendingPortForwardHostKeyVerification[],
  requestId: string,
): PendingPortForwardHostKeyVerification[] => {
  if (queue[0]?.requestId === requestId) {
    return queue.slice(1);
  }
  return queue.filter((pending) => pending.requestId !== requestId);
};

export const createKnownHostFromPortForwardHostKeyInfo = (
  hostKeyInfo: HostKeyInfo,
  now = Date.now(),
  idSuffix = Math.random().toString(36).slice(2, 11),
): KnownHost => createKnownHostFromHostKeyInfo(hostKeyInfo, { now, idSuffix });
