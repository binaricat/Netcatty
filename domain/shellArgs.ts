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
 * containing whitespace or quote characters are wrapped in double quotes so the
 * value round-trips back through `parseShellArgs`.
 */
export function formatShellArgs(args: string[]): string {
  return args.map((arg) => (/[\s"']/.test(arg) ? `"${arg}"` : arg)).join(" ");
}
