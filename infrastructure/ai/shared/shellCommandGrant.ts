import { bashArityPrefix } from './bashArity';

/** Commands whose always-allow patterns are skipped (OpenCode shell.ts CWD set). */
const CWD_COMMANDS = new Set([
  'cd',
  'chdir',
  'popd',
  'pushd',
  'push-location',
  'set-location',
]);

export function unquoteShellToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

export function tokenizeShellCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map(unquoteShellToken);
}

export function splitShellCommandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * OpenCode always-allow patterns: BashArity.prefix(tokens) + " *"
 * @see packages/opencode/src/tool/shell.ts collect()
 */
export function buildAlwaysAllowCommandPatterns(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const patterns = new Set<string>();
  const segments = splitShellCommandSegments(trimmed);

  for (const segment of segments) {
    const tokens = tokenizeShellCommand(segment);
    if (tokens.length === 0) continue;
    const cmd = tokens[0]?.toLowerCase();
    if (cmd && CWD_COMMANDS.has(cmd)) continue;
    const prefix = bashArityPrefix(tokens);
    if (prefix.length === 0) continue;
    patterns.add(`${prefix.join(' ')} *`);
  }

  if (patterns.size === 0) {
    const tokens = tokenizeShellCommand(trimmed);
    if (tokens.length > 0) {
      patterns.add(`${bashArityPrefix(tokens).join(' ')} *`);
    }
  }

  return [...patterns];
}
