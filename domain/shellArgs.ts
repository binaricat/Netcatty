/**
 * Tokenize a command-line argument string into discrete args, and format an
 * arg array back into an editable string.
 *
 * Used by the custom local-shell config (#1221): the user types launch args
 * like `--login -i` in a single field; we store them as a string[] that flows
 * into `pty.spawn(shell, args)`.
 *
 * Quoting model (chosen so `formatShellArgs` ⇄ `parseShellArgs` round-trips):
 * - Single quotes are fully literal — nothing is escaped inside them. This is
 *   what keeps Windows paths (`C:\msys64\…`) and embedded double quotes intact.
 * - Inside double quotes, a backslash escapes only `"` and `\`; before any other
 *   character it stays literal, so unescaped Windows paths still survive.
 * - Outside quotes there is no backslash escaping at all.
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  let escaped = false; // pending backslash, only meaningful inside double quotes

  for (const ch of input) {
    if (quote === '"') {
      if (escaped) {
        current += ch === '"' || ch === "\\" ? ch : "\\" + ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaped) current += "\\"; // trailing backslash in an unterminated quote
  if (inToken) args.push(current);
  return args;
}

/**
 * Inverse of {@link parseShellArgs} for re-display in the editor. Tokens with
 * whitespace or quote characters are quoted so the value round-trips:
 * - prefer single quotes (no escaping needed — clean for Windows paths and
 *   embedded double quotes);
 * - when the token itself contains a single quote, fall back to double quotes
 *   and escape `\` and `"`.
 */
export function formatShellArgs(args: string[]): string {
  return args
    .map((arg) => {
      if (!/[\s"']/.test(arg)) return arg;
      if (!arg.includes("'")) return `'${arg}'`;
      return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}
