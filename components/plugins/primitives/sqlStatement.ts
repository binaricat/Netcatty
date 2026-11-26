/**
 * Pure SQL statement and alias helpers used by PluginCodeEditor.
 * Runs synchronously in the host renderer with zero IPC overhead.
 */

export function extractCurrentSqlStatement(sql: string, cursorOffset: number): string {
  if (!sql) return '';
  const clampedCursor = Math.max(0, Math.min(cursorOffset, sql.length));
  const statements: Array<{ start: number; end: number; text: string }> = [];

  let start = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === '\\' && next !== undefined) {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inBacktick) {
      if (ch === '`' && next === '`') {
        i += 2;
        continue;
      }
      if (ch === '`') inBacktick = false;
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[a-zA-Z0-9_]*\$/u.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      const raw = sql.slice(start, i);
      if (raw.trim().length > 0) {
        statements.push({ start, end: i + 1, text: raw.trim() });
      }
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }

  const tail = sql.slice(start);
  if (tail.trim().length > 0) {
    statements.push({ start, end: sql.length, text: tail.trim() });
  }

  if (statements.length === 0) return sql.trim();

  for (const stmt of statements) {
    if (clampedCursor >= stmt.start && clampedCursor <= stmt.end) {
      return stmt.text;
    }
  }
  // If cursor sits in trailing whitespace after a semicolon, return the preceding statement.
  let chosen = statements[0];
  for (const stmt of statements) {
    if (stmt.start <= clampedCursor) chosen = stmt;
  }
  return chosen.text;
}

/** Extract simple `FROM/JOIN [schema.]table [AS] alias` bindings for dot-completion. */
export function extractSqlTableAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const pattern = /\b(?:from|join|update|into)\s+(?:["`]?([a-zA-Z_][\w$]*)["`]?\.)?["`]?([a-zA-Z_][\w$]*)["`]?(?:\s+(?:as\s+)?["`]?([a-zA-Z_][\w$]*)["`]?)?/giu;
  const reserved = new Set([
    'where', 'on', 'set', 'values', 'inner', 'left', 'right', 'full', 'outer',
    'cross', 'join', 'group', 'order', 'having', 'limit', 'offset', 'union',
    'select', 'from', 'as', 'using', 'returning',
  ]);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const tableName = match[2];
    const alias = match[3];
    if (!tableName) continue;
    aliases.set(tableName.toLowerCase(), tableName);
    if (alias && !reserved.has(alias.toLowerCase())) {
      aliases.set(alias.toLowerCase(), tableName);
    }
  }
  return aliases;
}
