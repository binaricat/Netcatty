/**
 * Loader for @withfig/autocomplete command specifications.
 * Loads specs via Electron main process IPC (Node.js require),
 * which reliably accesses node_modules in both dev and production.
 */

/** Minimal Fig spec types — mirrors @withfig/autocomplete-types */
export interface FigOption {
  name: string | string[];
  description?: string;
  args?: FigArg | FigArg[];
  isRequired?: boolean;
  isPersistent?: boolean;
  exclusiveOn?: string[];
  /** Local extension: optional short values attach directly; long values use '='. */
  netcattyOptionalArgAttached?: boolean;
}

export interface FigArg {
  name?: string;
  description?: string;
  suggestions?: (string | FigSuggestion)[];
  template?: string | string[];
  isOptional?: boolean;
  isVariadic?: boolean;
  generators?: unknown;
}

export interface FigSuggestion {
  name: string | string[];
  description?: string;
  icon?: string;
  type?: string;
  priority?: number;
}

export interface FigSubcommand {
  name: string | string[];
  description?: string;
  subcommands?: FigSubcommand[];
  options?: FigOption[];
  args?: FigArg | FigArg[];
}

export interface FigSpec extends FigSubcommand {
  // Top-level spec may include additional metadata
}

export type FigHostOs = "linux" | "windows" | "macos";

// Bridge type augmentation
interface FigSpecBridge {
  listFigSpecs?: (hostOs?: FigHostOs) => Promise<string[]>;
  loadFigSpec?: (commandName: string, hostOs?: FigHostOs) => Promise<FigSpec | null>;
}

function getBridge(): FigSpecBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { netcatty?: FigSpecBridge }).netcatty;
}

// Cache by command and target OS: one renderer can contain both Linux and
// macOS sessions, whose option names and meanings can differ.
const specCache = new Map<string, FigSpec>();

// In-flight loading promises to avoid duplicate loads for the same target OS.
const inFlightLoads = new Map<string, Promise<FigSpec | null>>();

function specCacheKey(commandName: string, hostOs?: FigHostOs): string {
  return JSON.stringify([commandName, hostOs ?? null]);
}

// Spec names and successfully loaded commands, both scoped by target OS so a
// macOS-only command never reports as available to a Linux session.
const availableSpecs = new Map<string, { names: string[]; set: Set<string> }>();
const loadedSpecNames = new Map<string, Set<string>>();

function hostKey(hostOs?: FigHostOs): string {
  return hostOs ?? "";
}

function rememberLoadedSpecName(commandName: string, hostOs?: FigHostOs): void {
  const key = hostKey(hostOs);
  const loaded = loadedSpecNames.get(key);
  if (loaded) loaded.add(commandName);
  else loadedSpecNames.set(key, new Set([commandName]));
}

/**
 * Get the list of all command specs available for one target OS via IPC.
 */
export async function getAvailableSpecs(hostOs?: FigHostOs): Promise<string[]> {
  const key = hostKey(hostOs);
  // Only return cache if it has actual specs (not an empty failure)
  const cached = availableSpecs.get(key);
  if (cached && cached.names.length > 0) return cached.names;

  try {
    const bridge = getBridge();
    if (bridge?.listFigSpecs) {
      const specs = await bridge.listFigSpecs(hostOs);
      if (Array.isArray(specs) && specs.length > 0) {
        availableSpecs.set(key, { names: specs, set: new Set(specs) });
        return specs;
      }
    }
  } catch (err) {
    console.warn("[Autocomplete] figspec bridge error:", err);
  }

  // Don't cache empty — allow retry on next call
  return [];
}

/**
 * Load a command specification by name via IPC.
 * Uses in-flight deduplication to avoid loading the same spec twice concurrently.
 */
export async function loadSpec(commandName: string, hostOs?: FigHostOs): Promise<FigSpec | null> {
  const cacheKey = specCacheKey(commandName, hostOs);
  const cached = specCache.get(cacheKey);
  if (cached) return cached;

  const existing = inFlightLoads.get(cacheKey);
  if (existing) return existing;

  // Defer the bridge lookup so even a missing bridge or synchronous throw
  // clears the in-flight entry after it has been registered.
  const loadPromise = Promise.resolve().then(async (): Promise<FigSpec | null> => {
    try {
      const bridge = getBridge();
      if (!bridge?.loadFigSpec) {
        // Don't cache — bridge may not be ready yet (dev reload, non-Electron preview)
        return null;
      }

      const spec = await bridge.loadFigSpec(commandName, hostOs);
      if (spec) {
        specCache.set(cacheKey, spec);
        rememberLoadedSpecName(commandName, hostOs);
      }
      // Don't cache null — the load may have failed transiently (bridge not ready, etc.)
      return spec;
    } catch {
      // Don't cache failures — allow retry on next request
      return null;
    } finally {
      inFlightLoads.delete(cacheKey);
    }
  });

  inFlightLoads.set(cacheKey, loadPromise);
  return loadPromise;
}

/**
 * Check if a spec exists for a given command name and target OS.
 */
export async function hasSpec(commandName: string, hostOs?: FigHostOs): Promise<boolean> {
  if (loadedSpecNames.get(hostKey(hostOs))?.has(commandName)) return true;

  await getAvailableSpecs(hostOs);
  return availableSpecs.get(hostKey(hostOs))?.set.has(commandName) ?? false;
}

/**
 * Common shell commands preloaded when autocomplete is enabled.
 * Includes local overrides under electron/specs/ (e.g. yum, dnf, awk).
 */
export const COMMON_FIG_SPECS = [
  "git", "docker", "kubectl", "npm", "yarn", "pnpm",
  "ls", "cd", "cat", "grep", "find", "ssh", "scp",
  "curl", "wget", "tar", "zip", "unzip", "make",
  "python", "python3", "pip", "pip3", "node",
  "systemctl", "journalctl", "apt", "yum", "dnf", "brew",
  "vim", "nano", "less", "head", "tail", "sort",
  "awk", "sed", "chmod", "chown", "cp", "mv", "rm", "mkdir",
  "ln", "stat", "wc", "cut", "uniq", "tee", "xargs",
  "echo", "which", "pwd", "clear", "su", "crontab", "env",
  "uname", "base64", "date", "id", "split", "seq", "join",
  "dig", "dd", "htop", "basename", "dirname", "readlink", "more", "paste",
] as const;

/**
 * Preload commonly used specs in batches to avoid overwhelming IPC.
 * Only call this when autocomplete is enabled.
 */
export function preloadCommonSpecs(hostOs?: FigHostOs): void {
  const BATCH_SIZE = 8;
  let offset = 0;

  const loadBatch = () => {
    const batch = COMMON_FIG_SPECS.slice(offset, offset + BATCH_SIZE);
    if (batch.length === 0) return;

    for (const name of batch) {
      loadSpec(name, hostOs).catch(() => {});
    }

    offset += BATCH_SIZE;
    if (offset < COMMON_FIG_SPECS.length) {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => loadBatch());
      } else {
        setTimeout(loadBatch, 100);
      }
    }
  };

  setTimeout(loadBatch, 200);
}

/**
 * Get normalized name variants (e.g., "git" from "/usr/bin/git").
 */
export function normalizeCommandName(rawCommand: string): string {
  const parts = rawCommand.split("/");
  let name = parts[parts.length - 1];
  name = name.replace(/\.(exe|cmd|bat|sh|bash|zsh|fish)$/i, "");
  return name.toLowerCase();
}

/**
 * Resolve names from a Fig spec name field (which can be string or string[]).
 */
export function resolveNames(name: string | string[]): string[] {
  return Array.isArray(name) ? name : [name];
}
