import type { KnownHost } from "../../domain/models";
import { toHostKeyInfo, type HostKeyVerificationRequest } from "../terminal/hostKeyVerification";
import type { HostKeyInfo } from "../terminal/TerminalHostKeyVerification";

export const isPortForwardHostKeySessionId = (sessionId?: string): boolean => {
  return typeof sessionId === "string" && sessionId.startsWith("pf-");
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
): KnownHost => ({
  id: hostKeyInfo.knownHostId || `kh-${now}-${idSuffix}`,
  hostname: hostKeyInfo.hostname,
  port: hostKeyInfo.port || 22,
  keyType: hostKeyInfo.keyType,
  publicKey: hostKeyInfo.publicKey || `SHA256:${hostKeyInfo.fingerprint}`,
  fingerprint: hostKeyInfo.fingerprint,
  discoveredAt: now,
});
