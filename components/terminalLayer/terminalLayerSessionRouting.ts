import type { TerminalSession } from "../../types";
import { isRemoteDesktopProtocol } from "../../domain/remoteDesktop";

type SessionRoutingProtocol = Pick<TerminalSession, "protocol">;

type DirectWriteSessionState = Pick<TerminalSession, "status" | "protocol"> & {
  restoreState?: TerminalSession["restoreState"];
};

export function resolveFallbackSessionProtocol(
  session: SessionRoutingProtocol,
): NonNullable<TerminalSession["protocol"]> {
  return session.protocol ?? "ssh";
}

export function canUseDirectSessionWriteFallback(session: DirectWriteSessionState): boolean {
  if (isRemoteDesktopProtocol(session.protocol)) return false;
  return session.restoreState !== "restored-disconnected";
}
