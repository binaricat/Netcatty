export const SNIPPET_PACKAGE_NAME_PATTERN = /^[\w\p{L}\p{N}-]+$/u;

export const SNIPPET_PACKAGE_PATH_CHANGE_EVENT = "netcatty:snippets:package-path-change";

export type SnippetPackagePathChange = {
  from: string;
  to: string | null;
};

export type SnippetPackageRenameError = "empty" | "invalidChars" | "duplicate";

type PackagedSnippet = { package?: string };

export function isSnippetPackagePathAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function getSnippetPackageAncestors(path: string): string[] {
  const normalized = path.trim().replace(/\/+$/g, "");
  if (!normalized) return [];
  const isAbsolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.map((_, index) => {
    const joined = parts.slice(0, index + 1).join("/");
    return isAbsolute ? `/${joined}` : joined;
  });
}

/** Persisted packages plus inferred ancestors from packages and snippet.package. */
export function collectSnippetPackageTreePaths(
  packages: string[],
  snippets: PackagedSnippet[] = [],
): string[] {
  const paths = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    getSnippetPackageAncestors(raw).forEach((ancestor) => paths.add(ancestor));
  };
  packages.forEach(add);
  snippets.forEach((snippet) => add(snippet.package));
  return Array.from(paths);
}

export const rewriteSnippetPackagePath = (value: string, from: string, to: string): string => {
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return to + value.slice(from.length);
  return value;
};

export function applySnippetPackagePathChange(
  value: string | undefined,
  change: SnippetPackagePathChange,
): string {
  const packagePath = value || "";
  if (!packagePath || !isSnippetPackagePathAtOrBelow(packagePath, change.from)) {
    return packagePath;
  }
  return change.to === null
    ? ""
    : rewriteSnippetPackagePath(packagePath, change.from, change.to);
}

/** Remove a package and descendants; keep snippets and clear their package path. */
export function deleteSnippetPackage<T extends PackagedSnippet>(
  packages: string[],
  snippets: T[],
  path: string,
): { packages: string[]; snippets: T[] } {
  return {
    packages: packages.filter((item) => !isSnippetPackagePathAtOrBelow(item, path)),
    snippets: snippets.map((snippet) => {
      const packagePath = snippet.package || "";
      if (!packagePath || !isSnippetPackagePathAtOrBelow(packagePath, path)) return snippet;
      return { ...snippet, package: "" };
    }),
  };
}

export function renameSnippetPackage<T extends PackagedSnippet>(
  packages: string[],
  snippets: T[],
  path: string,
  newName: string,
):
  | { ok: true; packages: string[]; snippets: T[]; newPath: string }
  | { ok: false; error: SnippetPackageRenameError } {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  if (!SNIPPET_PACKAGE_NAME_PATTERN.test(trimmed)) return { ok: false, error: "invalidChars" };

  const parts = path.split("/");
  parts[parts.length - 1] = trimmed;
  const newPath = parts.join("/");

  if (newPath === path) {
    return { ok: true, packages, snippets, newPath };
  }

  const occupied = collectSnippetPackageTreePaths(packages, snippets);
  const duplicate = occupied.some(
    (item) => item !== path && item.toLowerCase() === newPath.toLowerCase(),
  );
  if (duplicate) return { ok: false, error: "duplicate" };

  return {
    ok: true,
    newPath,
    packages: Array.from(new Set(
      packages.map((item) => rewriteSnippetPackagePath(item, path, newPath)),
    )),
    snippets: snippets.map((snippet) => {
      const packagePath = snippet.package || "";
      if (!packagePath) return snippet;
      const nextPath = rewriteSnippetPackagePath(packagePath, path, newPath);
      return nextPath === packagePath ? snippet : { ...snippet, package: nextPath };
    }),
  };
}
