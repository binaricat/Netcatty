import type { Host } from "./models";
import { sanitizeCredentialValue } from "./credentials";

/** Thrown when a drop lands in `/root` but the host has no usable sudo password. */
export class TerminalDropNeedsSudoError extends Error {
  constructor() {
    super("Terminal drop needs saved sudo elevation");
    this.name = "TerminalDropNeedsSudoError";
  }
}

export function normalizePosixAbsolutePath(
  cwd: string | null | undefined,
): string | null {
  if (typeof cwd !== "string") return null;
  const trimmed = cwd.trim();
  if (!trimmed.startsWith("/")) return null;
  const collapsed = trimmed.replace(/\/+/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
}

export function posixPathNeedsLoginUserElevation(
  cwd: string | null | undefined,
  username: string | null | undefined,
): boolean {
  const user = username?.trim() ?? "";
  if (!user || user === "root") return false;
  const path = normalizePosixAbsolutePath(cwd);
  if (!path) return false;
  return path === "/root" || path.startsWith("/root/");
}

export function hasUsableSftpSudoPassword(
  password: string | undefined,
): boolean {
  const value = sanitizeCredentialValue(password);
  return typeof value === "string" && value.length > 0;
}

export function canElevateSftpForTerminalDrop(
  host: Pick<Host, "sftpSudo" | "sftpFileProtocol">,
  resolvedPassword?: string,
): boolean {
  if (host.sftpFileProtocol === "scp") return false;
  if (host.sftpSudo) return true;
  return hasUsableSftpSudoPassword(resolvedPassword);
}

export function resolveTerminalDropSftpHost<T extends Host>(
  host: T,
  cwd: string,
  resolved?: { password?: string; username?: string },
): T {
  if (!posixPathNeedsLoginUserElevation(cwd, resolved?.username ?? host.username)) return host;
  if (host.sftpSudo) return host;
  if (!canElevateSftpForTerminalDrop(host, resolved?.password)) {
    throw new TerminalDropNeedsSudoError();
  }
  return { ...host, sftpSudo: true };
}
