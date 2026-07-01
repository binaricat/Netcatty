import { FLOW_CHAR_COUNT_ACK_SIZE } from "./terminalFlowConstants";

export type FlowAckBuffer = {
  ack: (charCount: number) => void;
  flush: () => void;
};

/** Mirrors VS Code `AckDataBufferer` in `terminalProcessManager.ts`. */
export function createFlowAckBuffer(
  callback: (charCount: number) => void,
  ackSize = FLOW_CHAR_COUNT_ACK_SIZE,
): FlowAckBuffer {
  let unsentCharCount = 0;

  const emitBatchedAcks = (): void => {
    while (unsentCharCount > ackSize) {
      unsentCharCount -= ackSize;
      callback(ackSize);
    }
  };

  return {
    ack(charCount: number): void {
      if (charCount <= 0) return;
      unsentCharCount += charCount;
      emitBatchedAcks();
    },
    flush(): void {
      if (unsentCharCount <= 0) return;
      const remainder = unsentCharCount;
      unsentCharCount = 0;
      callback(remainder);
    },
  };
}

type FlowAckBackend = {
  ackSessionFlow?: (sessionId: string, bytes: number) => void;
};

const sessionAckBuffers = new Map<string, FlowAckBuffer>();

const getOrCreateSessionAckBuffer = (
  backend: FlowAckBackend,
  sessionId: string,
): FlowAckBuffer | undefined => {
  if (!backend.ackSessionFlow) return undefined;
  let buffer = sessionAckBuffers.get(sessionId);
  if (!buffer) {
    buffer = createFlowAckBuffer((bytes) => backend.ackSessionFlow!(sessionId, bytes));
    sessionAckBuffers.set(sessionId, buffer);
  }
  return buffer;
};

/** Queue IPC flow ACK bytes; emits in VS Code-sized batches. */
export const ackTerminalSessionFlow = (
  backend: FlowAckBackend,
  sessionId: string | null | undefined,
  bytes: number,
): void => {
  if (!sessionId || bytes <= 0) return;
  getOrCreateSessionAckBuffer(backend, sessionId)?.ack(bytes);
};

export const flushTerminalSessionFlowAck = (sessionId: string | null | undefined): void => {
  if (!sessionId) return;
  sessionAckBuffers.get(sessionId)?.flush();
};

export const clearTerminalSessionFlowAck = (sessionId: string | null | undefined): void => {
  if (!sessionId) return;
  sessionAckBuffers.delete(sessionId);
};