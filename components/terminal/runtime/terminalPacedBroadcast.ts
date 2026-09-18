import { getTerminalBootEpoch } from '../../../domain/terminalBootEpoch';

const inputVersions = new Map<string, number>();
let nextVersion = 0;

export function markTerminalBroadcastUserInput(sessionId: string): void {
  inputVersions.set(sessionId, ++nextVersion);
}

export function clearTerminalBroadcastUserInput(sessionId: string): void {
  inputVersions.delete(sessionId);
}

export function captureTerminalBroadcastInput(sessionId: string) {
  return { sessionId, inputVersion: inputVersions.get(sessionId), bootEpoch: getTerminalBootEpoch(sessionId) };
}

export type TerminalBroadcastInputSnapshot = ReturnType<typeof captureTerminalBroadcastInput>;
export type TerminalPacedBroadcast = { targets?: TerminalBroadcastInputSnapshot[] };

export function isTerminalBroadcastInputCurrent(snapshot: TerminalBroadcastInputSnapshot): boolean {
  return snapshot.inputVersion === inputVersions.get(snapshot.sessionId)
    && snapshot.bootEpoch === getTerminalBootEpoch(snapshot.sessionId);
}
