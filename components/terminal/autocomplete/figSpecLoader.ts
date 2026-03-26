/**
 * Loader for @withfig/autocomplete command specifications.
 * Lazily loads specs on demand and caches them in memory.
 * Provides a unified interface to query subcommands, options, and arguments.
 */

/** Minimal Fig spec types — mirrors @withfig/autocomplete-types */
export interface FigOption {
  name: string | string[];
  description?: string;
  args?: FigArg | FigArg[];
  isRequired?: boolean;
  isPersistent?: boolean;
  exclusiveOn?: string[];
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

// Cache loaded specs
const specCache = new Map<string, FigSpec | null>();

// In-flight loading promises to avoid duplicate imports
const inFlightLoads = new Map<string, Promise<FigSpec | null>>();

// All available spec names from @withfig/autocomplete
let availableSpecs: string[] | null = null;

/**
 * Get the list of all available command specs.
 */
export async function getAvailableSpecs(): Promise<string[]> {
  if (availableSpecs) return availableSpecs;

  try {
    const mod = await import("@withfig/autocomplete");
    availableSpecs = mod.default as string[];
    return availableSpecs;
  } catch {
    availableSpecs = [];
    return [];
  }
}

/**
 * Load a command specification by name.
 * Returns null if the spec doesn't exist.
 * Uses in-flight deduplication to avoid loading the same spec twice concurrently.
 */
export async function loadSpec(commandName: string): Promise<FigSpec | null> {
  // Check cache first
  if (specCache.has(commandName)) {
    return specCache.get(commandName) ?? null;
  }

  // Check if there's already an in-flight load for this spec
  const existing = inFlightLoads.get(commandName);
  if (existing) return existing;

  // Start loading and register in-flight
  const loadPromise = (async (): Promise<FigSpec | null> => {
    try {
      const mod = await import(
        /* @vite-ignore */
        `@withfig/autocomplete/build/${commandName}.js`
      );
      const spec = (mod.default?.default ?? mod.default ?? null) as FigSpec | null;
      specCache.set(commandName, spec);
      return spec;
    } catch {
      specCache.set(commandName, null);
      return null;
    } finally {
      inFlightLoads.delete(commandName);
    }
  })();

  inFlightLoads.set(commandName, loadPromise);
  return loadPromise;
}

/**
 * Check if a spec exists for a given command name (without loading it).
 * Returns synchronously when cache/availableSpecs are already populated.
 */
export async function hasSpec(commandName: string): Promise<boolean> {
  if (specCache.has(commandName)) return specCache.get(commandName) !== null;
  const specs = await getAvailableSpecs();
  return specs.includes(commandName);
}

/**
 * Preload commonly used specs in batches to avoid overwhelming the event loop.
 * Only call this when autocomplete is enabled.
 */
export function preloadCommonSpecs(): void {
  const common = [
    // Batch 1: highest frequency commands
    "git", "docker", "kubectl", "npm", "yarn", "pnpm",
    "ls", "cd", "cat", "grep", "find", "ssh", "scp",
    // Batch 2
    "curl", "wget", "tar", "zip", "unzip", "make",
    "python", "python3", "pip", "pip3", "node",
    // Batch 3
    "systemctl", "journalctl", "apt", "yum", "brew",
    "vim", "nano", "less", "head", "tail", "sort",
    "awk", "sed", "chmod", "chown", "cp", "mv", "rm", "mkdir",
  ];

  // Load in batches of 8 with idle-time scheduling
  const BATCH_SIZE = 8;
  let offset = 0;

  const loadBatch = () => {
    const batch = common.slice(offset, offset + BATCH_SIZE);
    if (batch.length === 0) return;

    for (const name of batch) {
      loadSpec(name).catch(() => {});
    }

    offset += BATCH_SIZE;
    if (offset < common.length) {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => loadBatch());
      } else {
        setTimeout(loadBatch, 100);
      }
    }
  };

  // Start first batch after a short delay to not interfere with initial render
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
