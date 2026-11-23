import {
  classifyDistroId,
  detectVendorFromSshVersion,
  type DeviceClass,
} from "./host";
import type { Host, TerminalSession } from "./models";

export const TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS = [
  "sftp",
  "browser",
  "scripts",
  "history",
  "theme",
  "system",
  "notes",
  "ai",
] as const;

export type TerminalSidePanelAutoOpenTab = typeof TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS[number];

export const DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_ENABLED = false;
export const DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB: TerminalSidePanelAutoOpenTab = "scripts";

export type AutoOpenSftpHost = Partial<Pick<Host, "deviceType" | "distro" | "autoOpenSftpPanel">> & {
  os?: string;
};

export interface AutoOpenSftpHostOptions {
  explicitAutoOpen?: boolean;
  remoteSshVersion?: string;
  deviceClass?: DeviceClass;
}

export function isNetworkDeviceAutoOpenTarget(
  host: AutoOpenSftpHost | null | undefined,
  options?: Pick<AutoOpenSftpHostOptions, "remoteSshVersion" | "deviceClass">,
): boolean {
  if (host?.deviceType === "network") return true;
  if (typeof host?.os === "string" && host.os.toLowerCase().trim() === "network") return true;
  if (options?.deviceClass === "network-device") return true;
  if (classifyDistroId(host?.distro) === "network-device") return true;
  if (
    options?.remoteSshVersion
    && classifyDistroId(detectVendorFromSshVersion(options.remoteSshVersion)) === "network-device"
  ) {
    return true;
  }
  return false;
}

/**
 * Guard default SFTP auto-open for network devices (switches/routers/firewalls)
 * that typically do not run an SFTP subsystem, while preserving explicit
 * per-host / deep-link opt-ins (e.g. `host.autoOpenSftpPanel === true`).
 */
export function shouldAutoOpenSftpForHost(
  host: AutoOpenSftpHost | null | undefined,
  options?: AutoOpenSftpHostOptions,
): boolean {
  if (options?.explicitAutoOpen === true || host?.autoOpenSftpPanel === true) {
    return true;
  }
  return !isNetworkDeviceAutoOpenTarget(host, options);
}

export function isTerminalSidePanelAutoOpenTab(
  value: unknown,
): value is TerminalSidePanelAutoOpenTab {
  return typeof value === "string"
    && TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS.includes(value as TerminalSidePanelAutoOpenTab);
}

export function resolveTerminalSidePanelAutoOpen({
  enabled,
  selectedTab,
  sftpAvailable,
  browserAvailable = sftpAvailable,
}: {
  enabled: boolean;
  selectedTab: TerminalSidePanelAutoOpenTab;
  sftpAvailable: boolean;
  browserAvailable?: boolean;
}): TerminalSidePanelAutoOpenTab | null {
  if (!enabled) return null;
  if (selectedTab === "sftp" && !sftpAvailable) return null;
  if (selectedTab === "browser" && !browserAvailable) return null;
  return selectedTab;
}

/** Resolve local preferences separately; legacy SFTP auto-open remains remote-only. */
export function resolveSessionSidePanelAutoOpen({
  session,
  host,
  remoteSshVersion,
  deviceClass,
  terminalEnabled,
  terminalTab,
  localEnabled,
  localTab,
  legacySftpEnabled,
}: {
  session: Pick<TerminalSession, "protocol" | "autoOpenSidePanel">;
  host?: AutoOpenSftpHost | null;
  remoteSshVersion?: string;
  deviceClass?: DeviceClass;
  terminalEnabled: boolean;
  terminalTab: TerminalSidePanelAutoOpenTab;
  localEnabled: boolean;
  localTab: TerminalSidePanelAutoOpenTab;
  legacySftpEnabled: boolean;
}): TerminalSidePanelAutoOpenTab | null {
  const protocol = session.protocol ?? "ssh";
  const isLocal = protocol === "local";
  const sftpTransportAvailable = isLocal || protocol === "ssh" || protocol === "mosh";
  const explicitSftp = session.autoOpenSidePanel === "sftp" || host?.autoOpenSftpPanel === true;
  if (explicitSftp && sftpTransportAvailable) return "sftp";
  const sftpAutoOpenAvailable = sftpTransportAvailable && (
    isLocal || shouldAutoOpenSftpForHost(host, { remoteSshVersion, deviceClass })
  );
  return resolveTerminalSidePanelAutoOpen({
    enabled: isLocal ? localEnabled : terminalEnabled,
    selectedTab: isLocal ? localTab : terminalTab,
    sftpAvailable: sftpAutoOpenAvailable,
    browserAvailable: sftpTransportAvailable,
  }) ?? (legacySftpEnabled && !isLocal && sftpAutoOpenAvailable ? "sftp" : null);
}
