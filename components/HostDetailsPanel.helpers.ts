import type { GroupConfig } from "../domain/models";
import type { Host } from "../types";
import { LINUX_DISTRO_OPTIONS, NETWORK_DEVICE_OPTIONS } from "../domain/host";

export const parseOptionalPortInput = (value: string): number | undefined =>
  value ? Number(value) : undefined;

export const resolveDetailsTelnetPort = (
  host: Host,
  groupDefaults?: Partial<GroupConfig>,
): number => {
  if (host.telnetPort !== undefined && host.telnetPort !== null) return host.telnetPort;
  if (groupDefaults?.telnetPort !== undefined && groupDefaults.telnetPort !== null) {
    return groupDefaults.telnetPort;
  }
  if (host.protocol === "telnet") {
    if (host.port !== undefined && host.port !== null) return host.port;
    if (groupDefaults?.port !== undefined && groupDefaults.port !== null) return groupDefaults.port;
  }
  return 23;
};

export const resolveDetailsTelnetUsername = (
  host: Host,
  groupDefaults?: Partial<GroupConfig>,
): string =>
  host.telnetUsername !== undefined
    ? host.telnetUsername
    : groupDefaults?.telnetUsername !== undefined
      ? groupDefaults.telnetUsername
      : host.username ?? groupDefaults?.username ?? "";

export const resolveDetailsTelnetPassword = (
  host: Host,
  groupDefaults?: Partial<GroupConfig>,
): string =>
  host.telnetPassword !== undefined
    ? host.telnetPassword
    : groupDefaults?.telnetPassword !== undefined
      ? groupDefaults.telnetPassword
      : host.password ?? groupDefaults?.password ?? "";

export const LINUX_DISTRO_OPTION_IDS = [
  ...LINUX_DISTRO_OPTIONS,
  ...NETWORK_DEVICE_OPTIONS,
];
