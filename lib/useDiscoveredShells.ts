import { useEffect, useMemo, useState } from "react";
import { netcattyBridge } from "../infrastructure/services/netcattyBridge";
import type { ResolveDefaultLocalShellContext } from "../domain/localShellHost";

let shellCache: DiscoveredShell[] | null = null;
let shellPromise: Promise<DiscoveredShell[]> | null = null;

/**
 * Resolve discovered shells, awaiting the in-flight discovery when needed.
 * Safe to call from cold-start paths that must not create a session before
 * WSL/Git-Bash IDs can be classified and labeled.
 */
export async function ensureDiscoveredShells(): Promise<DiscoveredShell[]> {
  if (shellCache) return shellCache;

  const bridge = netcattyBridge.get();
  if (!bridge?.discoverShells) return [];

  if (!shellPromise) {
    shellPromise = bridge.discoverShells().then((result) => {
      shellCache = result;
      return result;
    }).catch((err) => {
      console.warn("Failed to discover shells:", err);
      shellPromise = null;
      throw err;
    });
  }

  try {
    return await shellPromise;
  } catch {
    return shellCache ?? [];
  }
}

export function useDiscoveredShells(): DiscoveredShell[] {
  const [shells, setShells] = useState<DiscoveredShell[]>(shellCache ?? []);

  useEffect(() => {
    if (shellCache) {
      setShells(shellCache);
      return;
    }

    let cancelled = false;
    void ensureDiscoveredShells().then((result) => {
      if (!cancelled) setShells(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return shells;
}

/**
 * Resolve a localShell setting value to shell command and args.
 * The value can be a discovered shell id (e.g., "wsl-ubuntu", "pwsh")
 * or a custom path/command (e.g., "/usr/local/bin/fish" or "fish").
 * `customArgs` are the user-configured launch args (e.g. ["--login", "-i"] for
 * msys2 bash). When present, they take precedence over discovered shell defaults
 * so custom commands like "bash" or "fish" can collide with discovered IDs
 * without losing the user's explicit args. Returns { command, args } or null
 * when discovery hasn't loaded yet and the value might be a shell ID that can't
 * be resolved yet.
 */
export function resolveShellSetting(
  localShell: string,
  discoveredShells: DiscoveredShell[],
  customArgs?: string[]
): { command: string; args?: string[] } | null {
  if (!localShell) return null;

  // Try to match as a discovered shell id. Discovered shells provide their own
  // args (e.g. WSL "-d Ubuntu"), unless the user explicitly configured custom
  // args for a command/path that happens to share the same value as an ID.
  const shell = discoveredShells.find(s => s.id === localShell);
  if (shell) {
    return { command: shell.command, args: customArgs?.length ? customArgs : shell.args };
  }

  // No ID match — treat as a custom shell path/command and pass through.
  // This handles both custom executables (e.g., "/usr/local/bin/fish", "pwsh-preview")
  // and stale/synced IDs that no longer exist on this machine (graceful fallback
  // to whatever the OS resolves the name to, or a spawn error the user can see).
  // Omit args when none are configured so the bridge's getLocalShellArgs fallback
  // (login flags, PowerShell -NoLogo) still applies — only override it when the
  // user has explicitly set launch args (#1221).
  return { command: localShell, args: customArgs?.length ? customArgs : undefined };
}

const CONFIGURED_LOCAL_SHELL_ID = "__configured-local-shell__";

function getShellBaseName(command: string | undefined): string {
  const parts = String(command || "").trim().split(/[\\/]/);
  return (parts[parts.length - 1] || "").toLowerCase();
}

function normalizeShellCommand(command: string | undefined): string {
  return String(command || "").trim().replace(/\\/g, "/").toLowerCase();
}

function getFriendlyCustomShell(shell: string): Pick<DiscoveredShell, "name" | "icon"> {
  const base = getShellBaseName(shell);
  const stem = base.endsWith(".exe") ? base.slice(0, -4) : base;
  switch (stem) {
    case "pwsh":
      return { name: "PowerShell 7", icon: "pwsh" };
    case "powershell":
      return { name: "Windows PowerShell", icon: "powershell" };
    case "cmd":
      return { name: "CMD", icon: "cmd" };
    case "bash":
      return { name: "Bash", icon: "bash" };
    case "zsh":
      return { name: "Zsh", icon: "zsh" };
    case "fish":
      return { name: "Fish", icon: "fish" };
    case "nu":
      return { name: "Nushell", icon: "nushell" };
    default:
      return { name: shell || "Local Terminal", icon: "terminal" };
  }
}

function findConfiguredShellTarget(
  discoveredShells: DiscoveredShell[],
  localShell: string,
  resolvedCommand: string,
): DiscoveredShell | undefined {
  const matchedById = discoveredShells.find((shell) => shell.id === localShell);
  if (matchedById) return matchedById;

  const configuredCommand = normalizeShellCommand(resolvedCommand || localShell);
  const matchedByCommand = discoveredShells.find((shell) => (
    normalizeShellCommand(shell.command) === configuredCommand
  ));
  if (matchedByCommand) return matchedByCommand;

  const configuredBase = getShellBaseName(resolvedCommand || localShell);
  if (configuredBase === "pwsh.exe" || configuredBase === "pwsh") {
    return (
      discoveredShells.find((shell) => shell.id === "pwsh") ??
      discoveredShells.find((shell) => shell.id === "powershell")
    );
  }

  if (configuredBase === "powershell.exe" || configuredBase === "powershell") {
    return (
      discoveredShells.find((shell) => shell.id === "powershell") ??
      discoveredShells.find((shell) => shell.id === "pwsh")
    );
  }

  return undefined;
}

export function buildQuickSwitcherShells(
  discoveredShells: DiscoveredShell[],
  localShell: string,
  customArgs?: string[],
): DiscoveredShell[] {
  const configured = resolveShellSetting(localShell, discoveredShells, customArgs);
  if (!configured) return discoveredShells;

  const target = findConfiguredShellTarget(discoveredShells, localShell, configured.command);
  const friendly = getFriendlyCustomShell(configured.command || localShell);
  const configuredShell: DiscoveredShell = {
    ...(target ?? {
      id: CONFIGURED_LOCAL_SHELL_ID,
      args: undefined,
    }),
    name: target && target.id === localShell ? target.name : friendly.name,
    command: configured.command,
    args: configured.args,
    icon: target && target.id === localShell ? target.icon : friendly.icon,
    isDefault: true,
  };

  if (!target) {
    return [
      configuredShell,
      ...discoveredShells.map((shell) => ({ ...shell, isDefault: false })),
    ];
  }

  return discoveredShells.map((shell) => (
    shell.id === target.id
      ? configuredShell
      : { ...shell, isDefault: false }
  ));
}

const DISTRO_ICONS = new Set([
  "ubuntu", "debian", "kali", "alpine", "opensuse",
  "fedora", "arch", "oracle", "linux",
]);

export function getShellIconPath(iconId: string): string {
  if (DISTRO_ICONS.has(iconId)) {
    return `/distro/${iconId}.svg`;
  }
  return `/shells/${iconId}.svg`;
}

/** Distro icons are monochrome black and need `dark:invert` in dark mode */
export function isMonochromeShellIcon(iconId: string): boolean {
  return DISTRO_ICONS.has(iconId);
}

/**
 * Build the context consumed by `resolveHostDefaultLocalShell` (Settings shell
 * + discovered shells + resolver) so every effective-host/session-creation
 * boundary can resolve saved local hosts saved with "System default shell".
 */
export function useDefaultLocalShellContext(
  terminalSettings?: { localShell?: string; localShellArgs?: string[] },
): ResolveDefaultLocalShellContext {
  const discoveredShells = useDiscoveredShells();
  return useMemo(
    () => ({ discoveredShells, resolveShellSetting, terminalSettings }),
    [discoveredShells, terminalSettings],
  );
}
