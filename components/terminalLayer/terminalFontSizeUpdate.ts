import { isSavedVaultHost } from "../../domain/ephemeralHosts";
import type { Host, TerminalSession } from "../../types";

export type TerminalFontSizeUpdateTarget =
  | { kind: "none" }
  | { kind: "global" }
  | { kind: "session" }
  | { kind: "host"; host: Host };

export function resolveTerminalFontSizeUpdateTarget({
  session,
  sessionHost,
  rawHost,
}: {
  session?: TerminalSession;
  sessionHost?: Host | null;
  rawHost?: Host | null;
}): TerminalFontSizeUpdateTarget {
  if (session?.workspaceId || session?.ephemeralHost) return { kind: "session" };
  if (!sessionHost) return { kind: "none" };

  const usesGlobalFontSize =
    sessionHost.protocol === "local"
    || sessionHost.id?.startsWith("local-")
    || !rawHost;
  if (usesGlobalFontSize) return { kind: "global" };

  if (!isSavedVaultHost(rawHost)) return { kind: "session" };
  return { kind: "host", host: rawHost };
}
