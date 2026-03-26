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

// Bridge type augmentation
interface FigSpecBridge {
  listFigSpecs?: () => Promise<string[]>;
  loadFigSpec?: (commandName: string) => Promise<FigSpec | null>;
}

function getBridge(): FigSpecBridge | undefined {
  return (window as Window & { netcatty?: FigSpecBridge }).netcatty;
}

// Cache loaded specs
const specCache = new Map<string, FigSpec | null>();

// In-flight loading promises to avoid duplicate loads
const inFlightLoads = new Map<string, Promise<FigSpec | null>>();

// All available spec names
let availableSpecs: string[] | null = null;
let availableSpecsSet: Set<string> | null = null;

/**
 * Get the list of all available command specs via IPC.
 */
export async function getAvailableSpecs(): Promise<string[]> {
  // Only return cache if it has actual specs (not an empty failure)
  if (availableSpecs && availableSpecs.length > 0) return availableSpecs;

  try {
    const bridge = getBridge();
    if (bridge?.listFigSpecs) {
      const specs = await bridge.listFigSpecs();
      if (Array.isArray(specs) && specs.length > 0) {
        availableSpecs = specs;
        availableSpecsSet = new Set(specs);
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
export async function loadSpec(commandName: string): Promise<FigSpec | null> {
  if (specCache.has(commandName)) {
    return specCache.get(commandName) ?? null;
  }

  const existing = inFlightLoads.get(commandName);
  if (existing) return existing;

  const loadPromise = (async (): Promise<FigSpec | null> => {
    try {
      const bridge = getBridge();
      if (!bridge?.loadFigSpec) {
        // Don't cache — bridge may not be ready yet (dev reload, non-Electron preview)
        return null;
      }

      const spec = await bridge.loadFigSpec(commandName);
      if (spec) {
        specCache.set(commandName, spec);
      }
      // Don't cache null — the load may have failed transiently (bridge not ready, etc.)
      // Only cache null when we're confident the spec doesn't exist (hasSpec returned false)
      return spec;
    } catch {
      // Don't cache failures — allow retry on next request
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
 */
export async function hasSpec(commandName: string): Promise<boolean> {
  // Only trust positive cache hits (spec loaded successfully).
  // Null entries may be stale failures from preload — ignore them.
  const cached = specCache.get(commandName);
  if (cached) return true;

  await getAvailableSpecs();
  return availableSpecsSet?.has(commandName) ?? false;
}

/**
 * Preload commonly used specs in batches to avoid overwhelming IPC.
 * Only call this when autocomplete is enabled.
 */
export function preloadCommonSpecs(): void {
  const common = [
    "git", "docker", "kubectl", "npm", "yarn", "pnpm",
    "ls", "cd", "cat", "grep", "find", "ssh", "scp",
    "curl", "wget", "tar", "zip", "unzip", "make",
    "python", "python3", "pip", "pip3", "node",
    "systemctl", "journalctl", "apt", "yum", "brew",
    "vim", "nano", "less", "head", "tail", "sort",
    "awk", "sed", "chmod", "chown", "cp", "mv", "rm", "mkdir",
  ];

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
