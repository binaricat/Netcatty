import type { Host, ManagedSource, Snippet } from '../types';

export function normalizeGroupTargetPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

// Undefined means a new host; existing ungrouped hosts use ''. Preserve legacy
// paths on unrelated edits so their exact-path connection defaults do not change.
export function resolveHostGroupForSave(value: string, originalGroup?: string): string {
  if (originalGroup !== undefined && (value === originalGroup || value === originalGroup.trim())) {
    return originalGroup;
  }
  return normalizeGroupTargetPath(value);
}

export function normalizeGroupTargetPaths(values: Iterable<string>): string[] {
  return Array.from(new Set(
    [...values].map(normalizeGroupTargetPath).filter(Boolean),
  ));
}

function replaceGroupPathPrefix(path: string, sourcePath: string, nextPath: string): string {
  if (path === sourcePath) return nextPath;
  if (path.startsWith(`${sourcePath}/`)) return nextPath + path.slice(sourcePath.length);
  return path;
}

export function remapSnippetTargetGroupPaths(
  snippets: Snippet[],
  sourceValue: string,
  nextValue: string,
): Snippet[] {
  const sourcePath = normalizeGroupTargetPath(sourceValue);
  const nextPath = normalizeGroupTargetPath(nextValue);
  if (!sourcePath || !nextPath || sourcePath === nextPath) return snippets;

  let changed = false;
  const nextSnippets = snippets.map((snippet) => {
    if (!snippet.targetGroups?.length) return snippet;
    const targetGroups = normalizeGroupTargetPaths(
      snippet.targetGroups.map((path) => replaceGroupPathPrefix(
        normalizeGroupTargetPath(path), sourcePath, nextPath,
      )),
    );
    if (
      targetGroups.length === snippet.targetGroups.length
      && targetGroups.every((path, index) => path === snippet.targetGroups?.[index])
    ) return snippet;
    changed = true;
    return { ...snippet, targetGroups };
  });
  return changed ? nextSnippets : snippets;
}

export function removeSnippetTargetGroupPaths(
  snippets: Snippet[],
  removedValues: Iterable<string>,
): Snippet[] {
  const removedPaths = [...removedValues]
    .map(normalizeGroupTargetPath)
    .filter(Boolean);
  if (removedPaths.length === 0) return snippets;
  const isRemoved = (path: string) => removedPaths.some(
    (removed) => path === removed || path.startsWith(`${removed}/`),
  );

  let changed = false;
  const nextSnippets = snippets.map((snippet) => {
    if (snippet.targetGroups === undefined) return snippet;
    const targetGroups = normalizeGroupTargetPaths(snippet.targetGroups).filter(
      (path) => !isRemoved(path),
    );
    if (
      targetGroups.length === snippet.targetGroups.length
      && targetGroups.every((path, index) => path === snippet.targetGroups?.[index])
    ) return snippet;
    changed = true;
    // An absent scope keeps the legacy onOutput "current session" behavior.
    // Preserve an explicit empty list when the last selected group disappears
    // so the script is disabled instead of silently widening to every host.
    return { ...snippet, targetGroups };
  });
  return changed ? nextSnippets : snippets;
}

export function groupDisplayName(groupPath: string): string {
  return groupPath.split('/').filter(Boolean).pop() ?? groupPath;
}

export function computeRenamedGroupPath(renameTargetPath: string, nextName: string): string {
  const segments = renameTargetPath.split('/').filter(Boolean);
  const parent = segments.slice(0, -1).join('/');
  return parent ? `${parent}/${nextName}` : nextName;
}

export function allocateUnnamedGroupPath(
  customGroups: string[],
  parentPath: string | null,
  baseName: string,
): { name: string; path: string } {
  let name = baseName;
  let counter = 2;
  while (true) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (!customGroups.includes(path)) {
      return { name, path };
    }
    name = `${baseName} ${counter}`;
    counter += 1;
  }
}

export function ensureAncestorPathsExpanded(
  groupPath: string,
  ensurePathExpanded: (path: string) => void,
) {
  const segments = groupPath.split('/').filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    ensurePathExpanded(segments.slice(0, i).join('/'));
  }
}

export type GroupPathRenameResult =
  | {
    ok: true;
    nextPath: string;
    updatedGroups: string[];
    updatedHosts: Host[];
    updatedManagedSources: ManagedSource[];
  }
  | { ok: false; error: 'required' | 'invalidChars' | 'duplicatePath' | 'unchanged' };

export function applyGroupPathRename(params: {
  renameTargetPath: string;
  nextName: string;
  customGroups: string[];
  hosts: Host[];
  managedSources: ManagedSource[];
}): GroupPathRenameResult {
  const trimmed = params.nextName.trim();
  if (!trimmed) {
    return { ok: false, error: 'required' };
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return { ok: false, error: 'invalidChars' };
  }

  const nextPath = computeRenamedGroupPath(params.renameTargetPath, trimmed);
  if (nextPath === params.renameTargetPath) {
    return { ok: false, error: 'unchanged' };
  }
  if (params.customGroups.includes(nextPath)) {
    return { ok: false, error: 'duplicatePath' };
  }

  const { renameTargetPath, customGroups, hosts, managedSources } = params;
  const updatedGroups = customGroups.map((groupPath) => {
    if (groupPath === renameTargetPath) return nextPath;
    if (groupPath.startsWith(`${renameTargetPath}/`)) {
      return nextPath + groupPath.slice(renameTargetPath.length);
    }
    return groupPath;
  });
  const updatedHosts = hosts.map((host) => {
    const group = host.group || '';
    if (group === renameTargetPath) return { ...host, group: nextPath };
    if (group.startsWith(`${renameTargetPath}/`)) {
      return { ...host, group: nextPath + group.slice(renameTargetPath.length) };
    }
    return host;
  });
  const updatedManagedSources = managedSources.map((source) => {
    if (source.groupName === renameTargetPath) return { ...source, groupName: nextPath };
    if (source.groupName.startsWith(`${renameTargetPath}/`)) {
      return { ...source, groupName: nextPath + source.groupName.slice(renameTargetPath.length) };
    }
    return source;
  });

  return {
    ok: true,
    nextPath,
    updatedGroups: Array.from(new Set(updatedGroups)),
    updatedHosts,
    updatedManagedSources,
  };
}
