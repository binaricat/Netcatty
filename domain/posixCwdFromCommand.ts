/** Infer the next POSIX cwd from a simple interactive `cd`/`pushd` command. */

const CD_COMMAND = /^(?:sudo\s+)?(?:builtin\s+)?(cd|pushd)(?:\s+--)?(?:\s+(.*))?$/;

export const normalizePosixCwd = (path: string): string => {
  const hasTrailingSlash = path.length > 1 && path.endsWith("/");
  const isAbsolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (!isAbsolute) return parts.join("/");
  const normalized = `/${parts.join("/")}`;
  if (normalized === "/") return "/";
  return hasTrailingSlash ? `${normalized}/` : normalized;
};

const joinPosixCwd = (base: string, relative: string): string => {
  if (relative.startsWith("/")) return normalizePosixCwd(relative);
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return normalizePosixCwd(`${prefix}${relative}`);
};

const tokenizeSinglePathArg = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    || (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith("'") ? inner : inner.replace(/\\(.)/g, "$1");
  }
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  if (trimmed.slice(token.length).trim()) return null;
  return token.replace(/\\(.)/g, "$1");
};

export const applyPosixCwdFromCommand = (input: {
  command: string;
  currentCwd?: string | null;
  homeDir?: string | null;
}): string | null => {
  const line = input.command.trim();
  if (!line || /[;&|]/.test(line)) return null;
  const match = line.match(CD_COMMAND);
  if (!match) return null;
  const operand = tokenizeSinglePathArg(match[2] ?? "");
  if (operand === null) return null;
  if (operand === "-") return null;

  const home = input.homeDir && input.homeDir.startsWith("/")
    ? normalizePosixCwd(input.homeDir)
    : null;
  const current = input.currentCwd && (input.currentCwd === "~" || input.currentCwd.startsWith("/"))
    ? input.currentCwd
    : null;

  if (!operand || operand === "~") return home ?? "~";
  if (operand.startsWith("~/")) {
    if (!home) return null;
    return joinPosixCwd(home, operand.slice(2));
  }
  if (operand.startsWith("/")) return normalizePosixCwd(operand);
  if (!current || current === "~") {
    if (!home) return null;
    return joinPosixCwd(home, operand);
  }
  return joinPosixCwd(current, operand);
};
