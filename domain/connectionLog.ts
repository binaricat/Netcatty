import type { ConnectionLog } from "./models.ts";

interface TerminalDataCaptureTarget {
  sessionId: string;
  hostname?: string;
}

export const selectConnectionLogForTerminalDataCapture = (
  connectionLogs: ConnectionLog[],
  target: TerminalDataCaptureTarget,
): ConnectionLog | undefined => {
  if (target.sessionId) {
    const sessionMatches = connectionLogs
      .filter((log) => log.sessionId === target.sessionId)
      .sort((a, b) => b.startTime - a.startTime);

    const openLog = sessionMatches.find((log) => !log.endTime && !log.terminalData);
    if (openLog) return openLog;

    return sessionMatches[0];
  }

  // Legacy logs created without sessionId (e.g. old hotkey local terminals).
  return connectionLogs
    .filter((log) => {
      if (log.endTime || log.terminalData || log.sessionId) return false;
      return !!target.hostname && log.hostname === target.hostname;
    })
    .sort((a, b) => b.startTime - a.startTime)[0];
};
