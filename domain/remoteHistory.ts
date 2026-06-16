import { RemoteHistoryEntry, RemoteHistorySource } from './models';

/** Marker prefix Netcatty AI uses when executing commands via the PTY bridge. */
export const NETCATTY_AI_HISTORY_MARKER = '__NCMCP_';

/** True when a shell history line came from Netcatty AI PTY exec, not the user. */
export function isNetcattyAiHistoryCommand(command: string): boolean {
  return command.includes(NETCATTY_AI_HISTORY_MARKER);
}

const NETCATTY_MANAGED_STARTUP_COMMAND =
  /^(?:sh\s+-c\s+.*printf .*\\033\[H\\033\[2J\\033\[3J.*_nc_docker_err=.*\bdocker\s+inspect\b|printf '\\033\[H\\033\[2J\\033\[3J';\s*(?:_nc_docker_err=.*\bdocker\s+inspect\b|exec\s+(?:docker\s+(?:exec|logs)\b|tmux\s+attach\b)))/;

/** True when a shell history line came from a Netcatty-managed terminal launch. */
export function isNetcattyManagedStartupHistoryCommand(command: string): boolean {
  return NETCATTY_MANAGED_STARTUP_COMMAND.test(command.trim());
}

const ZSH_EXTENDED_RECORD = /^: (\d+):\d+;([\s\S]*)$/;
// fish_history is a YAML subset: each record starts with `- cmd: <value>`,
// optionally followed by `  when: <epoch>` and a `  paths:` block.
const FISH_CMD_LINE = /^- cmd:\s?(.*)$/;
const FISH_WHEN_LINE = /^\s+when:\s*(\d+)/;

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/**
 * zsh writes a multi-line command across several physical lines, escaping each
 * embedded newline with a trailing backslash. Reassemble those physical lines
 * back into one logical record: a line continues onto the next when it ends
 * with an odd number of backslashes (an even count is escaped literal
 * backslashes, not a continuation). The escaping backslash is dropped.
 */
function joinContinuations(lines: string[]): string[] {
  const records: string[] = [];
  let buffer: string | null = null;
  for (const line of lines) {
    const trailingBackslashes = /\\*$/.exec(line)?.[0].length ?? 0;
    const continues = trailingBackslashes % 2 === 1;
    const body = continues ? line.slice(0, -1) : line;
    buffer = buffer === null ? body : `${buffer}\n${body}`;
    if (!continues) {
      records.push(buffer);
      buffer = null;
    }
  }
  if (buffer !== null) records.push(buffer);
  return records;
}

/**
 * Reverse fish's history escaping: it stores commands on a single line,
 * encoding backslash as `\\` and newline as `\n`.
 */
const unescapeFishValue = (value: string): string => {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n') {
        result += '\n';
        i += 1;
        continue;
      }
      if (next === '\\') {
        result += '\\';
        i += 1;
        continue;
      }
    }
    result += ch;
  }
  return result;
};

export function parseBashHistory(text: string): RemoteHistoryEntry[] {
  if (!text) return [];
  const result: RemoteHistoryEntry[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\r$/, ''));

  let pendingTimestamp: number | undefined;
  let pendingLines: string[] = [];
  let inTimestampedRecord = false;

  const flush = () => {
    if (pendingLines.length) {
      const command = pendingLines.join('\n').trim();
      if (command) {
        result.push({ id: makeId(), command, source: 'bash', timestamp: pendingTimestamp });
      }
    }
    pendingLines = [];
    pendingTimestamp = undefined;
  };

  for (const line of lines) {
    // Bash HISTTIMEFORMAT writes a `#<epoch>` line before each command. That
    // marker also delimits records, which lets us regroup a multi-line command
    // (stored with embedded newlines under `lithist`) back into one entry.
    const tsMatch = /^#(\d{9,})$/.exec(line);
    if (tsMatch) {
      flush();
      pendingTimestamp = Number(tsMatch[1]) * 1000;
      inTimestampedRecord = true;
      continue;
    }
    if (inTimestampedRecord) {
      pendingLines.push(line);
      continue;
    }
    // Without timestamp markers the file has no record delimiter, so fall back
    // to one command per line (this is also how bash itself re-reads the file).
    const command = line.trim();
    if (command) {
      result.push({ id: makeId(), command, source: 'bash', timestamp: undefined });
    }
  }
  flush();
  return result;
}

export function parseZshHistory(text: string): RemoteHistoryEntry[] {
  if (!text) return [];
  const result: RemoteHistoryEntry[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\r$/, ''));
  for (const record of joinContinuations(lines)) {
    const extended = ZSH_EXTENDED_RECORD.exec(record);
    if (extended) {
      const command = (extended[2] ?? '').trim();
      if (!command) continue;
      result.push({
        id: makeId(),
        command,
        source: 'zsh',
        timestamp: Number(extended[1]) * 1000,
      });
      continue;
    }
    const command = record.trim();
    if (!command) continue;
    result.push({
      id: makeId(),
      command,
      source: 'zsh',
    });
  }
  return result;
}

export function parseFishHistory(text: string): RemoteHistoryEntry[] {
  if (!text) return [];
  const result: RemoteHistoryEntry[] = [];
  const lines = text.split(/\r?\n/);
  let current: RemoteHistoryEntry | null = null;
  const flush = () => {
    if (current) {
      result.push(current);
      current = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const cmdMatch = FISH_CMD_LINE.exec(line);
    if (cmdMatch) {
      flush();
      const command = unescapeFishValue(cmdMatch[1] ?? '').trim();
      if (!command) continue; // skip empty command, stay outside a record
      current = { id: makeId(), command, source: 'fish' };
      continue;
    }
    if (current) {
      const whenMatch = FISH_WHEN_LINE.exec(line);
      if (whenMatch) {
        current.timestamp = Number(whenMatch[1]) * 1000;
      }
      // `  paths:` and its `    - …` entries (and any leading remnant lines
      // from a tail-truncated first record) are ignored.
    }
  }
  flush();
  return result;
}

export function parseShellHistory(
  source: RemoteHistorySource,
  text: string,
): RemoteHistoryEntry[] {
  if (source === 'bash') return parseBashHistory(text);
  if (source === 'fish') return parseFishHistory(text);
  return parseZshHistory(text);
}

/**
 * Merge multiple history lists into one newest-first, de-duplicated list.
 *
 * Entries are ordered by their real timestamp when they carry one (zsh
 * EXTENDED_HISTORY, fish `when`, bash HISTTIMEFORMAT). Entries without a
 * timestamp are treated as older than any timestamped entry and otherwise keep
 * their original file order (later in the file = newer). This stops an
 * always-timestamped source (e.g. fish) from leap-frogging another source
 * purely because `flat()` placed it last. De-duplication is by exact command
 * text, keeping the newest occurrence, and the result is capped to `max`.
 */
export function mergeRemoteHistory(
  lists: RemoteHistoryEntry[][],
  max = 1000,
): RemoteHistoryEntry[] {
  const indexed = lists.flat().map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    const ta = a.entry.timestamp ?? 0;
    const tb = b.entry.timestamp ?? 0;
    if (ta !== tb) return tb - ta; // newest timestamp first
    return b.index - a.index; // same/no timestamp: later in the file first
  });

  const seen = new Set<string>();
  const merged: RemoteHistoryEntry[] = [];
  for (const { entry } of indexed) {
    if (isNetcattyAiHistoryCommand(entry.command)) continue;
    if (isNetcattyManagedStartupHistoryCommand(entry.command)) continue;
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    merged.push(entry);
    if (merged.length >= max) break;
  }
  return merged;
}
