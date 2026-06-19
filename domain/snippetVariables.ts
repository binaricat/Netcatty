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
  goTemplateOffsets: Set<number>;
} {
  const matches = Array.from(text.matchAll(variablePattern()));
  const goTemplateOffsets = new Set<number>();
  const goTemplateVariables = new Set<string>();
  let blockDepth = 0;

  for (const match of matches) {
    const action = normalizeGoTemplateAction(templateActionBody(match));
    const firstWord = action.split(/\s+/, 1)[0] ?? "";
    const hasFieldReference = hasGoTemplateFieldReference(action);
    const hasKnownVariableReference = hasGoTemplateVariableReference(action, goTemplateVariables);
    const insideBlock = blockDepth > 0;
    const isBlockStart = (firstWord === "if" || firstWord === "range" || firstWord === "with")
      && (hasFieldReference || hasKnownVariableReference);
    const isBlockEnd = action === "end";
    const isGoTemplateToken = hasFieldReference
      || hasKnownVariableReference
      || isBlockStart
      || (insideBlock && isGoTemplateControlAction(action));

    if (isGoTemplateToken && match.index !== undefined) {
      goTemplateOffsets.add(match.index);
    }
    if (isGoTemplateToken) {
      for (const variable of action.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*(?=\s*(?:,|:?=))/g)) {
        goTemplateVariables.add(variable[0]);
      }
    }
    if (isBlockStart) {
      blockDepth += 1;
    } else if (isBlockEnd && insideBlock) {
      blockDepth -= 1;
    }
  }

  return { matches, goTemplateOffsets };
}

function hasGoTemplateFieldReference(name: string): boolean {
  const action = normalizeGoTemplateAction(name);
  return action === "."
    || /(?:^|[\s(])\.[A-Za-z_]/.test(action)
    || /(?:^|[\s(])\.(?:$|[\s),|])/.test(action)
    || /(?:^|[\s(])\$[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_]/.test(action);
}

function hasGoTemplateVariableReference(action: string, variables: Set<string>): boolean {
  for (const variable of variables) {
    if (new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(variable)}(?:$|[^A-Za-z0-9_])`).test(action)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
): boolean {
  return name !== "";
}

function replaceSnippetVariableTokens(
  command: string,
  replacementFor: (name: string, token: string) => string,
): string {
  const text = String(command ?? "");
  const { goTemplateOffsets } = collectVariableMatches(text);
  return text.replace(variablePattern(), (token: string, rawName: string, _defaultRaw: string | undefined, offset: number) => {
    const name = String(rawName ?? "").trim();
    if (goTemplateOffsets.has(offset) || !isSnippetVariableName(name)) {
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
  const { matches, goTemplateOffsets } = collectVariableMatches(text);

  for (const match of matches) {
    const name = match[1]?.trim() ?? "";
    if ((match.index !== undefined && goTemplateOffsets.has(match.index)) || !isSnippetVariableName(name) || seen.has(name)) continue;
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
