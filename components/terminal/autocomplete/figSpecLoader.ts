/**
 * Loader for @withfig/autocomplete command specifications.
 * Lazily loads specs on demand and caches them in memory.
 *
 * Specs are copied to public/fig-specs/ at build time (scripts/copy-fig-specs.cjs)
 * and served as static assets. This ensures they work in both dev and production
 * (Electron's app:// protocol only serves from dist/).
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
let availableSpecsSet: Set<string> | null = null;

/**
 * Resolve the base URL for fig-specs static assets.
 * Works in both dev (Vite dev server) and production (Electron app://).
 */
function getFigSpecBaseUrl(): string {
  // In Electron production: app://./fig-specs/
  // In Vite dev: /fig-specs/ (served from public/)
  return `${window.location.origin}/fig-specs`;
}

/**
 * Get the list of all available command specs.
 * Loads the index module which exports the list of spec names.
 */
export async function getAvailableSpecs(): Promise<string[]> {
  if (availableSpecs) return availableSpecs;

  try {
    // Try importing from static assets (works in both dev and production)
    const baseUrl = getFigSpecBaseUrl();
    const mod = await import(/* @vite-ignore */ `${baseUrl}/index.js`);
    availableSpecs = mod.default as string[];
    availableSpecsSet = new Set(availableSpecs);
    return availableSpecs;
  } catch {
    // Fallback: try node_modules import (works in Vite dev mode)
    try {
      const mod = await import("@withfig/autocomplete");
      availableSpecs = mod.default as string[];
      availableSpecsSet = new Set(availableSpecs);
      return availableSpecs;
    } catch {
      availableSpecs = [];
      availableSpecsSet = new Set();
      return [];
    }
  }
}

/**
 * Load a command specification by name.
 * Fetches the spec JS file from static assets and evaluates it.
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
      // Dynamic import with full URL — works in both dev (http://localhost:5173)
      // and production (app:// protocol) since files are in public/fig-specs/
      const baseUrl = getFigSpecBaseUrl();
      const mod = await import(/* @vite-ignore */ `${baseUrl}/${commandName}.js`);
      const spec = (mod.default?.default ?? mod.default ?? null) as FigSpec | null;
      specCache.set(commandName, spec);
      return spec;
    } catch {
      // Fallback: try node_modules import (works in Vite dev mode)
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
      }
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
  if (specCache.has(commandName)) return specCache.get(commandName) !== null;
  await getAvailableSpecs();
  return availableSpecsSet?.has(commandName) ?? false;
}

/**
 * Preload commonly used specs in batches to avoid overwhelming the event loop.
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
