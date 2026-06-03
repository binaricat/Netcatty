/**
 * Tokenize a command-line argument string into discrete args, and format an
 * arg array back into an editable string.
 *
 * Used by the custom local-shell config (#1221): the user types launch args
 * like `--login -i` in a single field; we store them as a string[] that flows
 * into `pty.spawn(shell, args)`.
 *
 * Quoting model (POSIX single-quote style, so format ⇄ parse round-trips):
 * - Both quote types are fully literal inside their span — nothing is escaped.
 *   This keeps Windows paths (`C:\msys64\…`, even a trailing `\`) and embedded
 *   double quotes intact.
 * - Outside quotes a backslash is literal too, EXCEPT `\'` which yields a
 *   literal single quote. That is the only escape, and it exists solely to
 *   support the POSIX `'\''` idiom that `formatShellArgs` emits for tokens that
 *   themselves contain a single quote. Every other backslash stays literal, so
 *   unquoted Windows paths survive.
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\" && input[i + 1] === "'") {
      current += "'";
      inToken = true;
      i++;
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
 * Inverse of {@link parseShellArgs} for re-display in the editor. Single-quote
 * quoting keeps the contents literal (Windows paths and double quotes need no
 * escaping); an embedded single quote uses the POSIX `'\''` idiom. An explicit
 * empty arg is emitted as `''` so it is not dropped on the next save.
 */
export function formatShellArgs(args: string[]): string {
  return args
    .map((arg) => {
      if (arg === "") return "''";
      if (!/[\s"']/.test(arg)) return arg;
      return `'${arg.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}
