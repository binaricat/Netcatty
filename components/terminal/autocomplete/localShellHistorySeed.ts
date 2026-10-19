/**
 * Seed autocomplete command history from the local machine's shell histfiles.
 *
 * Local Terminal sessions previously used a per-session hostId (`local-${sessionId}`),
 * so Netcatty's autocomplete history never accumulated across opens. Even with a
 * stable hostId, a fresh install / new machine has an empty store until the user
 * types commands inside Netcatty — while Ghostty (and similar terminals) surface
 * suggestions from ~/.zsh_history / ~/.bash_history immediately.
 *
 * This module imports those histfiles once per hostId into commandHistoryStore
 * so prefix autocomplete can match them.
 */

import {
  isNetcattyAiHistoryCommand,
  isNetcattyManagedStartupHistoryCommand,
  mergeRemoteHistory,
  parseBashHistory,
  parseFishHistory,
  parseZshHistory,
} from "../../../domain/remoteHistory";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import {
  flushCommandHistoryStore,
  getCommandHistoryClearGeneration,
  hasCommandHistoryBeenCleared,
  recordCommand,
} from "../../../application/state/commandHistoryStore";

const SEED_FLAG_PREFIX = "netcatty:localHistSeeded:";
const MAX_SEED_COMMANDS = 500;
/** Cap histfile reads so a multi-MB history does not stall Local Terminal mount. */
const MAX_HISTFILE_BYTES = 512 * 1024;

type LocalFsBridge = {
  getHomeDir?: () => Promise<string>;
  readLocalFile?: (
    path: string,
    options?: { maxBytes?: number },
  ) => Promise<ArrayBuffer | Buffer | Uint8Array | string>;
};

const inFlightSeeds = new Map<string, Promise<number>>();

function getBridge(): LocalFsBridge | undefined {
  return (window as Window & { netcatty?: LocalFsBridge }).netcatty;
}

function joinHomePath(home: string, relativeUnix: string): string {
  const normalizedHome = home.replace(/[/\\]+$/, "");
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const relative = sep === "\\" ? relativeUnix.replace(/\//g, "\\") : relativeUnix;
  return `${normalizedHome}${sep}${relative}`;
}

function decodeHistfileBytes(bytes: Uint8Array): string {
  // Main-process reads already return at most MAX_HISTFILE_BYTES. A buffer that
  // fills the budget is treated as a truncated tail, so drop the first
  // (possibly partial) line before parsing.
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (bytes.byteLength >= MAX_HISTFILE_BYTES) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  }
  return text;
}

async function readTextFile(bridge: LocalFsBridge, path: string): Promise<string | null> {
  if (!bridge.readLocalFile) return null;
  try {
    // Ask the main process to return only the trailing bytes so multi-MB
    // histfiles never cross the IPC boundary in full.
    const raw = await bridge.readLocalFile(path, { maxBytes: MAX_HISTFILE_BYTES });
    if (typeof raw === "string") {
      // Bridge returned a string (tests / alternate adapters). Cap by UTF-8
      // byte length so this path matches the binary branch.
      const encoded = new TextEncoder().encode(raw);
      return decodeHistfileBytes(encoded);
    }
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return decodeHistfileBytes(bytes);
  } catch {
    return null;
  }
}

function alreadySeeded(hostId: string): boolean {
  return localStorageAdapter.readBoolean(`${SEED_FLAG_PREFIX}${hostId}`) === true;
}

function markSeeded(hostId: string): void {
  localStorageAdapter.writeBoolean(`${SEED_FLAG_PREFIX}${hostId}`, true);
}

async function seedLocalShellHistoryFromHistfilesOnce(
  hostId: string,
  os: "linux" | "windows" | "macos",
): Promise<number> {
  if (!hostId || alreadySeeded(hostId)) return 0;

  // A clear is a user decision to delete locally recorded history. Never
  // re-import histfiles for a host that was not seeded before that clear, or
  // the deleted commands would reappear on the next Local Terminal open.
  if (hasCommandHistoryBeenCleared()) {
    markSeeded(hostId);
    return 0;
  }

  // Capture the clear generation before the bridge reads so a clear that lands
  // while they are in flight can be detected afterwards.
  const startClearGeneration = getCommandHistoryClearGeneration();

  const bridge = getBridge();
  if (!bridge?.getHomeDir || !bridge.readLocalFile) return 0;

  let home: string;
  try {
    home = await bridge.getHomeDir();
  } catch {
    return 0;
  }
  if (!home) return 0;

  const [zshText, bashText, fishText, fishAltText] = await Promise.all([
    readTextFile(bridge, joinHomePath(home, ".zsh_history")),
    readTextFile(bridge, joinHomePath(home, ".bash_history")),
    readTextFile(bridge, joinHomePath(home, ".local/share/fish/fish_history")),
    readTextFile(bridge, joinHomePath(home, ".config/fish/fish_history")),
  ]);

  // The user cleared history while the histfile reads were in flight. Discard
  // the import and mark this host seeded so a later Local Terminal open cannot
  // resurrect the commands that were just deleted.
  if (
    hasCommandHistoryBeenCleared()
    || getCommandHistoryClearGeneration() !== startClearGeneration
  ) {
    markSeeded(hostId);
    return 0;
  }

  const lists = [
    zshText ? parseZshHistory(zshText) : [],
    bashText ? parseBashHistory(bashText) : [],
    fishText ? parseFishHistory(fishText) : [],
    !fishText && fishAltText ? parseFishHistory(fishAltText) : [],
  ];

  const merged = mergeRemoteHistory(lists, MAX_SEED_COMMANDS);
  let recorded = 0;
  // mergeRemoteHistory returns newest-first; record oldest-first so frequency /
  // lastUsedAt ordering stays sensible if the same command appears later.
  for (const entry of [...merged].reverse()) {
    const command = entry.command.trim();
    if (!command) continue;
    if (isNetcattyAiHistoryCommand(command)) continue;
    if (isNetcattyManagedStartupHistoryCommand(command)) continue;
    recordCommand(command, hostId, os);
    recorded += 1;
  }

  // Only persist the seeded flag after we actually imported commands and
  // flushed the store. An empty/missing histfile must remain retryable so a
  // later Local Terminal open can pick up history once it exists (#2037).
  if (recorded > 0 && flushCommandHistoryStore()) {
    markSeeded(hostId);
  }
  return recorded;
}

/**
 * Import local shell histfiles into the autocomplete history store for `hostId`.
 * Returns the number of commands newly recorded. No-ops when already seeded for
 * this hostId, when the local FS bridge is unavailable, or when histfiles are
 * empty/missing (those cases stay retryable on the next Local Terminal open).
 */
export async function seedLocalShellHistoryFromHistfiles(
  hostId: string,
  os: "linux" | "windows" | "macos" = "macos",
): Promise<number> {
  if (!hostId || alreadySeeded(hostId)) return 0;

  const existing = inFlightSeeds.get(hostId);
  if (existing) return existing;

  const pending = seedLocalShellHistoryFromHistfilesOnce(hostId, os).finally(() => {
    inFlightSeeds.delete(hostId);
  });
  inFlightSeeds.set(hostId, pending);
  return pending;
}
