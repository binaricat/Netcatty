/**
 * Tokenize a command-line argument string into discrete args, and format an
 * arg array back into an editable string.
 *
 * Used by the custom local-shell config (#1221): the user types launch args
 * like `--login -i` in a single field; we store them as a string[] that flows
 * into `pty.spawn(shell, args)`.
 *
 * Quote-aware: single or double quotes group a token containing spaces and are
 * stripped from the result. Quotes may appear mid-token (`a"b c"d` → `ab cd`).
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
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
  if (inToken) args.push(current);
  return args;
}

/**
 * Inverse of {@link parseShellArgs} for re-display in the editor. Tokens
 * containing whitespace or quote characters are wrapped in quotes. The quote
 * char is chosen so the contents need no escaping and round-trip back through
 * `parseShellArgs`: prefer single quotes when the token contains a double quote
 * (common in `-c "…"` scripts), otherwise use double quotes (which also keeps
 * Windows backslash paths and apostrophes intact).
 */
export function formatShellArgs(args: string[]): string {
  return args
    .map((arg) => {
      if (!/[\s"']/.test(arg)) return arg;
      return arg.includes('"') && !arg.includes("'") ? `'${arg}'` : `"${arg}"`;
    })
    .join(" ");
}
