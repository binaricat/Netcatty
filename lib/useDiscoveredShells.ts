import { useEffect, useState } from "react";
import { netcattyBridge } from "../infrastructure/services/netcattyBridge";

let shellCache: DiscoveredShell[] | null = null;
let shellPromise: Promise<DiscoveredShell[]> | null = null;

export function useDiscoveredShells(): DiscoveredShell[] {
  const [shells, setShells] = useState<DiscoveredShell[]>(shellCache ?? []);

  useEffect(() => {
    if (shellCache) {
      setShells(shellCache);
      return;
    }

    const bridge = netcattyBridge.get();
    if (!bridge?.discoverShells) return;

    if (!shellPromise) {
      shellPromise = bridge.discoverShells();
    }

    shellPromise.then((result) => {
      shellCache = result;
      setShells(result);
    }).catch((err) => {
      console.warn("Failed to discover shells:", err);
      // Clear the failed promise so the next mount can retry
      shellPromise = null;
    });
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
