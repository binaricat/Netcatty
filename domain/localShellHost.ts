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

export interface ResolveDefaultLocalShellContext {
  discoveredShells?: DiscoveredShell[];
  terminalSettings?: { localShell?: string; localShellArgs?: string[] };
  resolveShellSetting?: (
    localShell: string,
    discoveredShells: DiscoveredShell[],
    customArgs?: string[],
  ) => { command: string; args?: string[] } | null;
}

/**
 * Saved local-shell hosts created with "System default shell" carry no
 * `localShell`. Resolve the Settings → Terminal shell for them so every save
 * path that materializes effective hosts (host connect, tray/dock open,
 * workspace creation/append, ...) launches the configured shell instead of
 * silently falling back to the backend OS default. A no-op for non-local
 * hosts and for hosts that already specify a shell.
 */
export const resolveHostDefaultLocalShell = (
  host: Host,
  ctx: ResolveDefaultLocalShellContext,
): Host => {
  if (host.protocol !== 'local' || host.localShell) return host;
  const configuredShell = ctx.terminalSettings?.localShell ?? '';
  const resolved = ctx.resolveShellSetting?.(
    configuredShell,
    ctx.discoveredShells ?? [],
    ctx.terminalSettings?.localShellArgs,
  );
  if (!resolved?.command) return host;
  const matchedShell = ctx.discoveredShells?.find((s) => s.id === configuredShell);
  return {
    ...host,
    localShell: resolved.command,
    localShellArgs: resolved.args,
    localShellName: matchedShell?.name,
    localShellIcon: matchedShell?.icon,
  };
};
