import { quoteRestoreCwdForShell } from "./sessionRestore";

export type TerminalDeletePlan = {
  command: string;
  directories: Array<{ parentPath: string; names: string[] }>;
};

function pathHasInteractivePtyControlBytes(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSafeInteractiveDeletePath(path: string | null | undefined): path is string {
  if (!path || !path.startsWith("/") || path === "/") return false;
  if (pathHasInteractivePtyControlBytes(path)) return false;
  const parts = path.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  return parts.filter(Boolean).length > 0;
}

function splitAbsolutePath(path: string): { parentPath: string; name: string } | null {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null;
  const name = path.slice(slash + 1);
  if (!name) return null;
  const parentPath = slash === 0 ? "/" : path.slice(0, slash);
  return { parentPath, name };
}

export function resolveInteractiveTerminalDelete(paths: readonly string[]): TerminalDeletePlan | null {
  if (paths.length === 0) return null;
  const quoted: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const path of paths) {
    if (!isSafeInteractiveDeletePath(path)) return null;
    const split = splitAbsolutePath(path);
    if (!split) return null;
    quoted.push(quoteRestoreCwdForShell(path));
    const names = grouped.get(split.parentPath) ?? [];
    names.push(split.name);
    grouped.set(split.parentPath, names);
  }
  return {
    command: "rm -rf -- " + quoted.join(" "),
    directories: Array.from(grouped, function (entry) { return { parentPath: entry[0], names: entry[1] }; }),
  };
}
