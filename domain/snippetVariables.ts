/**
 * Parse and substitute {{variable}} / {{variable:default}} placeholders in snippet commands.
 */

/** Non-global: safe to reuse; avoids lastIndex side effects across calls. */
const VARIABLE_TOKEN = /\{\{([^}:]+)(?::([^}]*))?\}\}/;

function variablePattern(): RegExp {
  return /\{\{([^}:]+)(?::([^}]*))?\}\}/g;
}

export interface SnippetVariableDef {
  name: string;
  defaultValue?: string;
}

export function snippetHasVariables(command: string): boolean {
  return VARIABLE_TOKEN.test(String(command ?? ""));
}

export function parseSnippetVariables(command: string): SnippetVariableDef[] {
  const text = String(command ?? "");
  const seen = new Set<string>();
  const result: SnippetVariableDef[] = [];

  for (const match of text.matchAll(variablePattern())) {
    const name = match[1]?.trim() ?? "";
    if (!name || seen.has(name)) continue;
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

  let output = String(command ?? "");
  for (const def of defs) {
    const value = resolved[def.name];
    const escapedName = def.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\{\\{${escapedName}(?::[^}]*)?\\}\\}`,
      "g",
    );
    output = output.replace(pattern, value);
  }

  return { ok: true, command: output };
}

/** Preview resolved command for UI; unfilled required vars stay as placeholders. */
export function previewSnippetCommand(
  command: string,
  values: Record<string, string>,
): string {
  const defs = parseSnippetVariables(command);
  if (defs.length === 0) return String(command ?? "");

  let output = String(command ?? "");
  for (const def of defs) {
    const value = resolveVariableValue(def, values);
    const replacement = value ?? `{{${def.name}}}`;
    const escapedName = def.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\{\\{${escapedName}(?::[^}]*)?\\}\\}`,
      "g",
    );
    output = output.replace(pattern, replacement);
  }
  return output;
}
