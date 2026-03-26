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
 */
export async function loadSpec(commandName: string): Promise<FigSpec | null> {
  if (specCache.has(commandName)) {
    return specCache.get(commandName) ?? null;
  }

  try {
    // Dynamic import of the specific spec file
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
}

/**
 * Check if a spec exists for a given command name (without loading it).
 */
export async function hasSpec(commandName: string): Promise<boolean> {
  if (specCache.has(commandName)) return specCache.get(commandName) !== null;
  const specs = await getAvailableSpecs();
  return specs.includes(commandName);
}

/**
 * Preload commonly used specs to avoid latency on first use.
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
  // Load in background without blocking
  for (const name of common) {
    loadSpec(name).catch(() => {});
  }
}

/**
 * Get normalized name variants (e.g., "git" from "git" or "/usr/bin/git").
 */
export function normalizeCommandName(rawCommand: string): string {
  // Strip path prefix
  const parts = rawCommand.split("/");
  let name = parts[parts.length - 1];

  // Strip common extensions
  name = name.replace(/\.(exe|cmd|bat|sh|bash|zsh|fish)$/i, "");

  // Handle env-prefixed commands like "sudo git"
  // This is handled at the caller level

  return name.toLowerCase();
}

/**
 * Resolve names from a Fig spec name field (which can be string or string[]).
 */
export function resolveNames(name: string | string[]): string[] {
  return Array.isArray(name) ? name : [name];
}

/**
 * Get the description from a Fig spec suggestion.
 */
export function resolveDescription(
  item: { description?: string },
): string | undefined {
  return item.description;
}
