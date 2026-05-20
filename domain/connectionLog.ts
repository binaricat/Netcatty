import type { ConnectionLog } from "./models.ts";

interface TerminalDataCaptureTarget {
  sessionId: string;
  hostname?: string;
}

export const selectConnectionLogForTerminalDataCapture = (
  connectionLogs: ConnectionLog[],
  target: TerminalDataCaptureTarget,
): ConnectionLog | undefined => {
  const matchingOpenLog = connectionLogs
    .filter((log) => {
      if (log.endTime || log.terminalData) return false;
      if (log.sessionId) return log.sessionId === target.sessionId;
      return !!target.hostname && log.hostname === target.hostname;
    })
    .sort((a, b) => b.startTime - a.startTime)[0];

  if (matchingOpenLog) return matchingOpenLog;

  return connectionLogs
    .filter((log) => log.sessionId === target.sessionId)
    .sort((a, b) => b.startTime - a.startTime)[0];
};
