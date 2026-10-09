import type { Host } from './models';

/**
 * Vault-side "local shell" (CMD / PowerShell / WSL / custom shell) host entry.
 *
 * A vault host with protocol 'local' is grouped, sorted and connected exactly
 * like any other saved host: clicking it opens a terminal session whose boot
 * path resolves the host's stored shell (see `startLocal` in
 * `createTerminalSessionStarters` and the bridge resolution of discovered
 * shell ids).
 */

export type LocalShellHostOs = 'linux' | 'windows' | 'macos';

export interface LocalShellHostInput {
  id?: string;
  os?: LocalShellHostOs;
  label?: string;
  /** Discovered shell id (e.g. "wsl-ubuntu") or a custom shell path/command. Empty = system default. */
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  startDir?: string;
  group?: string;
  tags?: string[];
  notes?: string;
}

export const LOCAL_SHELL_HOST_TAG = 'local';

export const createLocalShellHost = (input: LocalShellHostInput): Host => ({
  id: input.id ?? `local-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
  label: input.label?.trim() || input.shellName?.trim() || 'Local Shell',
  hostname: 'localhost',
  username: '',
  tags: input.tags ?? [LOCAL_SHELL_HOST_TAG],
  group: input.group?.trim() || '',
  os: input.os ?? 'linux',
  protocol: 'local',
  createdAt: Date.now(),
  notes: input.notes?.trim() || undefined,
  localShell: input.shell?.trim() || undefined,
  localShellArgs: input.shellArgs?.length ? input.shellArgs : undefined,
  localShellName: input.shellName?.trim() || undefined,
  localShellIcon: input.shellIcon?.trim() || undefined,
  localStartDir: input.startDir?.trim() || undefined,
});

/** What an existing vault host shows as its local-shell display name. */
export const getLocalShellHostSubtitle = (
  host: Pick<Host, 'protocol' | 'localShellName'>,
  fallback = 'Local Shell',
): string => host.localShellName?.trim() || fallback;

export interface VaultHostRowSubtitleOptions {
  /** Translated fallback shown for default-shell local hosts. */
  localFallback?: string;
}

/** Row subtitle shared by the vault tree rows and host cards. */
export const getVaultHostRowSubtitle = (
  host: Pick<Host, 'protocol' | 'localShellName' | 'username' | 'hostname'>,
  options?: VaultHostRowSubtitleOptions,
): string => (
  host.protocol === 'local'
    ? getLocalShellHostSubtitle(host, options?.localFallback)
    : `${host.username ?? ''}@${host.hostname ?? ''}`
);
