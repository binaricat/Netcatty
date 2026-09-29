export const isSessionError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("session not found") ||
    msg.includes("sftp session") ||
    msg.includes("session lost") ||
    msg.includes("channel not ready") ||
    msg.includes("readdir is not a function") ||
    msg.includes("channel closed") ||
    msg.includes("connection closed") ||
    msg.includes("connection reset") ||
    msg.includes("write after end") ||
    msg.includes("no response") ||
    msg.includes("not connected") ||
    msg.includes("client disconnected") ||
    msg.includes("timed out")
  );
};

const SFTP_IPC_ERROR_PREFIX = /^Error invoking remote method 'netcatty:[^']+':\s*/i;

/** Drop Electron IPC wrapper so dialogs can show the server error. */
export function unwrapSftpIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const unwrapped = raw.replace(SFTP_IPC_ERROR_PREFIX, "").replace(/^Error:\s*/, "").trim();
  return unwrapped || raw;
}

export { isMissingStatError } from "../../../domain/sftpStatError";
