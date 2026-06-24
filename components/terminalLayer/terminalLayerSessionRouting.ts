import type { TerminalSession } from "../../types";

type SessionRoutingProtocol = Pick<TerminalSession, "protocol">;

type DirectWriteSessionState = Pick<TerminalSession, "status"> & {
  restoreState?: TerminalSession["restoreState"];
};

export function resolveFallbackSessionProtocol(
  session: SessionRoutingProtocol,
): NonNullable<TerminalSession["protocol"]> {
  return session.protocol ?? "ssh";
}

export function canUseDirectSessionWriteFallback(session: DirectWriteSessionState): boolean {
  return session.restoreState !== "restored-disconnected";
}
