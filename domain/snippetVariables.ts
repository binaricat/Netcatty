/**
 * Parse and substitute {{variable}} / {{variable:default}} placeholders in snippet commands.
 */

function variablePattern(): RegExp {
  return /\{\{([^}:]+)(?::([^}]*))?\}\}/g;
}

const GO_TEMPLATE_CONTROL_ACTIONS = new Set([
  "break",
  "continue",
  "else",
  "end",
  "if",
  "range",
  "with",
]);

function normalizeGoTemplateAction(name: string): string {
  return name.trim().replace(/^-/, "").replace(/-$/, "").trim();
}

function templateActionBody(match: RegExpMatchArray): string {
  return (match[0] ?? "").slice(2, -2);
}

function collectVariableMatches(text: string): {
  matches: RegExpMatchArray[];
  hasGoTemplateContext: boolean;
} {
  const matches = Array.from(text.matchAll(variablePattern()));
  const hasGoTemplateContext = matches.some((match) => (
    hasGoTemplateFieldReference(templateActionBody(match))
  ));
  return { matches, hasGoTemplateContext };
}

function hasGoTemplateFieldReference(name: string): boolean {
  const action = normalizeGoTemplateAction(name);
  return action === "."
    || /(?:^|[\s(])\.[A-Za-z_]/.test(action)
    || /(?:^|[\s(])\$[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_]/.test(action);
}

function isGoTemplateControlAction(name: string): boolean {
  const action = normalizeGoTemplateAction(name);
  if (action === "break" || action === "continue" || action === "else" || action === "end") {
    return true;
  }
  const firstWord = action.split(/\s+/, 1)[0] ?? "";
  return GO_TEMPLATE_CONTROL_ACTIONS.has(firstWord) && action.startsWith(`${firstWord} `);
}

function isSnippetVariableName(
  name: string,
  tokenBody: string,
  hasGoTemplateContext = false,
): boolean {
  return name !== ""
    && !hasGoTemplateFieldReference(tokenBody)
    && !(hasGoTemplateContext && isGoTemplateControlAction(tokenBody));
}

function replaceSnippetVariableTokens(
  command: string,
  replacementFor: (name: string, token: string) => string,
): string {
  const text = String(command ?? "");
  const { hasGoTemplateContext } = collectVariableMatches(text);
  return text.replace(variablePattern(), (token: string, rawName: string) => {
    const name = String(rawName ?? "").trim();
    if (!isSnippetVariableName(name, token.slice(2, -2), hasGoTemplateContext)) {
      return token;
    }
    return replacementFor(name, token);
  });
}

export interface SnippetVariableDef {
  name: string;
  defaultValue?: string;
}

export function snippetHasVariables(command: string): boolean {
  return parseSnippetVariables(command).length > 0;
}

export function parseSnippetVariables(command: string): SnippetVariableDef[] {
  const text = String(command ?? "");
  const seen = new Set<string>();
  const result: SnippetVariableDef[] = [];
  const { matches, hasGoTemplateContext } = collectVariableMatches(text);

  for (const match of matches) {
    const name = match[1]?.trim() ?? "";
    if (!isSnippetVariableName(name, templateActionBody(match), hasGoTemplateContext) || seen.has(name)) continue;
    seen.add(name);
    const defaultRaw = match[2];
    result.push({
      name,
      ...(defaultRaw !== undefined ? { defaultValue: defaultRaw } : {}),
    });
  }

  return result;
}

export type ApplySnippetVariablesResult =
  | { ok: true; command: string }
  | { ok: false; missing: string[] };

function resolveVariableValue(
  def: SnippetVariableDef,
  values: Record<string, string>,
): string | undefined {
  const raw = values[def.name];
  if (raw !== undefined && raw.trim() !== "") {
    return raw;
  }
  if (def.defaultValue !== undefined) {
    return def.defaultValue;
  }
  return undefined;
}

export function applySnippetVariables(
  command: string,
  values: Record<string, string>,
): ApplySnippetVariablesResult {
  const defs = parseSnippetVariables(command);
  if (defs.length === 0) {
    return { ok: true, command: String(command ?? "") };
  }

  const missing: string[] = [];
  const resolved: Record<string, string> = {};

  for (const def of defs) {
    const value = resolveVariableValue(def, values);
    if (value === undefined) {
      missing.push(def.name);
    } else {
      resolved[def.name] = value;
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    command: replaceSnippetVariableTokens(command, (name, token) => resolved[name] ?? token),
  };
}

/** Preview resolved command for UI; unfilled required vars stay as placeholders. */
export function previewSnippetCommand(
  command: string,
  values: Record<string, string>,
): string {
  const defs = parseSnippetVariables(command);
  if (defs.length === 0) return String(command ?? "");

  return replaceSnippetVariableTokens(command, (name) => {
    const def = defs.find((candidate) => candidate.name === name);
    if (!def) return `{{${name}}}`;
    return resolveVariableValue(def, values) ?? `{{${def.name}}}`;
  });
}
