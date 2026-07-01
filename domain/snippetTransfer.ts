import type { Snippet } from "./models";
import { normalizeVaultOrder } from "./vaultOrder";

export const SNIPPET_EXPORT_KIND = "netcatty.snippets" as const;
export const SNIPPET_EXPORT_VERSION = 2 as const;
export const SNIPPET_EXPORT_VERSION_LEGACY = 1 as const;

export type SnippetImportConflictAction = "skip" | "overwrite";

export type SnippetExportItem = {
  label: string;
  command: string;
  tags?: string[];
  package?: string;
  shortkey?: string;
  noAutoRun?: boolean;
  multiLineRunMode?: Snippet["multiLineRunMode"];
  kind?: "snippet" | "script";
  language?: "javascript" | "python";
  description?: string;
  trigger?: "manual" | "onConnect" | "onOutput";
  triggerPattern?: string;
};

export type SnippetExportPayload = {
  kind: typeof SNIPPET_EXPORT_KIND;
  version: typeof SNIPPET_EXPORT_VERSION | typeof SNIPPET_EXPORT_VERSION_LEGACY;
  exportedAt: string;
  snippetPackages: string[];
  snippets: SnippetExportItem[];
};

export type SnippetImportStats = {
  imported: number;
  overwritten: number;
  skipped: number;
  conflicts: number;
};

export type SnippetImportMergeResult = {
  snippets: Snippet[];
  snippetPackages: string[];
  stats: SnippetImportStats;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const uniqueStrings = (values: unknown[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const getPackageAncestors = (path: string): string[] => {
  const normalized = path.trim().replace(/\/+$/g, "");
  if (!normalized) return [];
  const isAbsolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.map((_, index) => {
    const joined = parts.slice(0, index + 1).join("/");
    return isAbsolute ? `/${joined}` : joined;
  });
};

export const collectSnippetPackagePaths = (
  snippets: Pick<SnippetExportItem, "package">[],
  snippetPackages: string[] = [],
): string[] => {
  const referenced = new Set<string>();
  snippets.forEach((snippet) => {
    const packagePath = snippet.package?.trim();
    if (!packagePath) return;
    getPackageAncestors(packagePath).forEach((path) => referenced.add(path));
  });

  const ordered = uniqueStrings([
    ...snippetPackages.filter((path) => referenced.has(path)),
    ...Array.from(referenced),
  ]);
  return ordered;
};

const mergeSnippetPackagePaths = (...groups: string[][]): string[] => {
  const paths: string[] = [];
  groups.flat().forEach((path) => {
    getPackageAncestors(path).forEach((ancestor) => paths.push(ancestor));
  });
  return uniqueStrings(paths);
};

const toExportItem = (snippet: Snippet): SnippetExportItem => ({
  label: snippet.label,
  command: snippet.command,
  tags: Array.isArray(snippet.tags) ? [...snippet.tags] : [],
  package: snippet.package || "",
  ...(snippet.shortkey ? { shortkey: snippet.shortkey } : {}),
  ...(snippet.noAutoRun ? { noAutoRun: snippet.noAutoRun } : {}),
  ...(snippet.multiLineRunMode ? { multiLineRunMode: snippet.multiLineRunMode } : {}),
  ...(snippet.kind ? { kind: snippet.kind } : {}),
  ...(snippet.language ? { language: snippet.language } : {}),
  ...(snippet.description ? { description: snippet.description } : {}),
  ...(snippet.trigger ? { trigger: snippet.trigger } : {}),
  ...(snippet.triggerPattern ? { triggerPattern: snippet.triggerPattern } : {}),
});

export const buildSnippetExportPayload = ({
  snippets,
  snippetPackages,
  exportedAt = new Date().toISOString(),
}: {
  snippets: Snippet[];
  snippetPackages: string[];
  exportedAt?: string;
}): SnippetExportPayload => {
  const exportItems = snippets.map(toExportItem);
  return {
    kind: SNIPPET_EXPORT_KIND,
    version: SNIPPET_EXPORT_VERSION,
    exportedAt,
    snippetPackages: collectSnippetPackagePaths(exportItems, snippetPackages),
    snippets: exportItems,
  };
};

const fallbackLabel = (command: string): string => {
  const firstLine = command.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim().slice(0, 80) || "Imported snippet";
};

const sanitizeImportItem = (value: unknown): SnippetExportItem | null => {
  if (!isObjectRecord(value) || typeof value.command !== "string") return null;
  if (!value.command.trim()) return null;
  const label = typeof value.label === "string" && value.label.trim()
    ? value.label.trim()
    : fallbackLabel(value.command);
  return {
    label,
    command: value.command,
    tags: Array.isArray(value.tags)
      ? uniqueStrings(value.tags)
      : [],
    package: typeof value.package === "string" ? value.package.trim() : "",
    shortkey: typeof value.shortkey === "string" && value.shortkey.trim()
      ? value.shortkey.trim()
      : undefined,
    noAutoRun: value.noAutoRun === true ? true : undefined,
    multiLineRunMode: value.multiLineRunMode === "lineDelay" || value.multiLineRunMode === "paste"
      ? value.multiLineRunMode
      : undefined,
    kind: value.kind === "script" ? "script" : undefined,
    language: value.language === "javascript" || value.language === "python"
      ? value.language
      : undefined,
    description: typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : undefined,
    trigger: value.trigger === "onConnect" || value.trigger === "onOutput"
      ? value.trigger
      : undefined,
    triggerPattern: typeof value.triggerPattern === "string" && value.triggerPattern.trim()
      ? value.triggerPattern.trim()
      : undefined,
  };
};

const parseSnippetImportObject = (parsed: Record<string, unknown>): SnippetExportPayload => {
  const version = parsed.version;
  if (parsed.kind !== SNIPPET_EXPORT_KIND) {
    throw new Error("Unsupported snippet import file.");
  }
  if (version !== SNIPPET_EXPORT_VERSION && version !== SNIPPET_EXPORT_VERSION_LEGACY) {
    throw new Error("Unsupported snippet import file.");
  }
  if (!Array.isArray(parsed.snippets)) {
    throw new Error("Snippet import file has no snippets.");
  }

  const snippets = parsed.snippets
    .map(sanitizeImportItem)
    .filter((item): item is SnippetExportItem => Boolean(item));

  return {
    kind: SNIPPET_EXPORT_KIND,
    version: version === SNIPPET_EXPORT_VERSION ? SNIPPET_EXPORT_VERSION : SNIPPET_EXPORT_VERSION_LEGACY,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
    snippetPackages: collectSnippetPackagePaths(
      snippets,
      Array.isArray(parsed.snippetPackages) ? uniqueStrings(parsed.snippetPackages) : [],
    ),
    snippets,
  };
};

export const combineSnippetImportPayloads = (payloads: SnippetExportPayload[]): SnippetExportPayload => {
  const snippets = payloads.flatMap((payload) => payload.snippets);
  const snippetPackages = payloads.flatMap((payload) => payload.snippetPackages);
  return {
    kind: SNIPPET_EXPORT_KIND,
    version: SNIPPET_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    snippetPackages: collectSnippetPackagePaths(snippets, snippetPackages),
    snippets,
  };
};

export const parseSnippetImportPayload = (jsonString: string): SnippetExportPayload => {
  const parsed = JSON.parse(jsonString) as unknown;
  if (Array.isArray(parsed)) {
    const nestedPayloads = parsed
      .filter(isObjectRecord)
      .filter((item) => Array.isArray(item.snippets))
      .map(parseSnippetImportObject);
    if (nestedPayloads.length > 0 && nestedPayloads.length === parsed.length) {
      return combineSnippetImportPayloads(nestedPayloads);
    }

    const snippets = parsed
      .map(sanitizeImportItem)
      .filter((item): item is SnippetExportItem => Boolean(item));
    return {
      kind: SNIPPET_EXPORT_KIND,
      version: SNIPPET_EXPORT_VERSION,
      exportedAt: "",
      snippetPackages: collectSnippetPackagePaths(snippets),
      snippets,
    };
  }

  if (!isObjectRecord(parsed)) {
    throw new Error("Invalid snippet import file.");
  }
  return parseSnippetImportObject(parsed);
};

const toImportedSnippet = (item: SnippetExportItem, id: string, order?: number): Snippet => ({
  id,
  label: item.label,
  command: item.command,
  tags: item.tags || [],
  package: item.package || "",
  targets: [],
  ...(item.shortkey ? { shortkey: item.shortkey } : {}),
  ...(item.noAutoRun ? { noAutoRun: item.noAutoRun } : {}),
  ...(item.multiLineRunMode ? { multiLineRunMode: item.multiLineRunMode } : {}),
  ...(item.kind ? { kind: item.kind } : {}),
  ...(item.language ? { language: item.language } : {}),
  ...(item.description ? { description: item.description } : {}),
  ...(item.trigger ? { trigger: item.trigger } : {}),
  ...(item.triggerPattern ? { triggerPattern: item.triggerPattern } : {}),
  order,
});

export const mergeSnippetImportPayload = ({
  existingSnippets,
  existingSnippetPackages,
  payload,
  conflictAction,
  createId,
}: {
  existingSnippets: Snippet[];
  existingSnippetPackages: string[];
  payload: SnippetExportPayload;
  conflictAction: SnippetImportConflictAction;
  createId: () => string;
}): SnippetImportMergeResult => {
  const next = [...existingSnippets];
  const commandToIndex = new Map<string, number>();
  next.forEach((snippet, index) => {
    if (!commandToIndex.has(snippet.command)) {
      commandToIndex.set(snippet.command, index);
    }
  });

  const stats: SnippetImportStats = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    conflicts: 0,
  };

  const getNextOrder = () => {
    const maxOrder = next.reduce((max, snippet, index) => {
      const order = typeof snippet.order === "number" ? snippet.order : (index + 1) * 1000;
      return Math.max(max, order);
    }, 0);
    return maxOrder + 1000;
  };

  payload.snippets.forEach((item) => {
    const existingIndex = commandToIndex.get(item.command);
    if (existingIndex !== undefined) {
      stats.conflicts += 1;
      if (conflictAction === "skip") {
        stats.skipped += 1;
        return;
      }
      const existing = next[existingIndex];
      next[existingIndex] = toImportedSnippet(item, existing.id, existing.order);
      stats.overwritten += 1;
      return;
    }

    const imported = toImportedSnippet(item, createId(), getNextOrder());
    commandToIndex.set(imported.command, next.length);
    next.push(imported);
    stats.imported += 1;
  });

  return {
    snippets: normalizeVaultOrder(next),
    snippetPackages: mergeSnippetPackagePaths(
      existingSnippetPackages,
      payload.snippetPackages,
      next.map((snippet) => snippet.package || ""),
    ),
    stats,
  };
};
