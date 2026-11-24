import type { TerminalSettings } from "../../domain/models";
import { normalizeSshAutoReconnectInterval } from "../../domain/models/terminal";
import type { TerminalSessionExitEvent } from "./resolveTerminalSessionExitIntent";

export const TERMINAL_AUTO_RECONNECT_DELAY_MS = 5000;

export function getTerminalAutoReconnectDelayMs(
  settings?: Partial<Pick<TerminalSettings, "sshAutoReconnectInterval">> | null,
): number {
  return normalizeSshAutoReconnectInterval(settings?.sshAutoReconnectInterval) * 1000;
}

type AutoReconnectHost = {
  protocol?: "ssh" | "telnet" | "local" | "serial" | "mosh" | "et";
  hostname?: string;
  moshEnabled?: boolean;
  etEnabled?: boolean;
};

type AutoReconnectSettings = Pick<TerminalSettings, "sshAutoReconnectEnabled"> | undefined | null;

export function isTerminalAutoReconnectEnabled(settings: AutoReconnectSettings): boolean {
  return settings?.sshAutoReconnectEnabled === true;
}

export function isAutoReconnectableSshHost(host: AutoReconnectHost): boolean {
  const protocol = host.protocol ?? "ssh";
  return (
    protocol === "ssh" &&
    host.hostname !== "localhost" &&
    host.moshEnabled !== true &&
    host.etEnabled !== true
  );
}

export function shouldAutoReconnectAfterExit({
  evt,
  host,
  terminalSettings,
  hasEverConnected,
}: {
  evt: TerminalSessionExitEvent;
  host: AutoReconnectHost;
  terminalSettings?: AutoReconnectSettings;
  hasEverConnected: boolean;
}): boolean {
  if (!hasEverConnected) return false;
  if (!isTerminalAutoReconnectEnabled(terminalSettings)) return false;
  if (!isAutoReconnectableSshHost(host)) return false;
  // "exited" is a shell exit. "timeout" is an administrative idle/TMOUT logout
  // (or a connect timeout). "signaled" — or a plumbed exit-signal on an
  // otherwise "closed" end — is a server kick (idle policy, SIGHUP, SIGTERM).
  // Reconnecting would fight that policy. Transport "error" and bare "closed"
  // still retry.
  if (evt.reason === "error") return true;
  if (evt.reason === "exited" || evt.reason === "timeout" || evt.reason === "signaled") {
    return false;
  }
  return typeof evt.exitSignal !== "string" || evt.exitSignal.trim().length === 0;
}

export function shouldContinueAutoReconnectAfterFailure({
  host,
  terminalSettings,
  loopActive,
}: {
  host: AutoReconnectHost;
  terminalSettings?: AutoReconnectSettings;
  loopActive: boolean;
}): boolean {
  return loopActive && isTerminalAutoReconnectEnabled(terminalSettings) && isAutoReconnectableSshHost(host);
}

export function canAttemptTerminalAutoReconnect({
  hasTerminalRuntime,
  isHibernated,
}: {
  hasTerminalRuntime: boolean;
  isHibernated: boolean;
}): boolean {
  return hasTerminalRuntime || isHibernated;
}
