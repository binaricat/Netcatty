/** 判断交互命令会不会改变当前 shell 的目录。最终路径以 pwd 为准，不再从命令文本猜测。 */

const DIRECTORY_COMMAND = /^(?:sudo\s+)?(?:builtin\s+)?(cd|pushd|popd)(?:\s|$)/;

/**
 * 把交互命令拆成 &&、;、|| 列表。
 * 顶层管道 | 和后台 & 会让 cd 跑在子 shell 里，返回 null，调用方不要注入 pwd。
 * 引号、注释、$() 和反引号里的符号不当成顶层操作符。引号或括号没闭合时也返回 null，避免打断续行。
 */
const splitInteractiveCommandList = (line: string): string[] | null => {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let backtick = false;
  let depth = 0;

  const push = () => {
    segments.push(current);
    current = "";
  };

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index] ?? "";
    const next = line[index + 1];

    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\") {
        if (next) {
          current += next;
          index += 1;
        }
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (backtick) {
      current += ch;
      if (ch === "`") backtick = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`") {
      backtick = true;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      if (next) {
        current += next;
        index += 1;
      }
      continue;
    }
    if (ch === "#" && (current.length === 0 || /\s$/.test(current))) break;
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      current += ch;
      continue;
    }
    if (depth > 0) {
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      push();
      index += 1;
      continue;
    }
    if (ch === "&" || ch === "|") return null;
    current += ch;
  }

  if (quote || backtick || depth !== 0) return null;
  push();
  return segments;
};

const listCommands = (command: string): string[] | null => {
  const segments = splitInteractiveCommandList(command.trim());
  if (!segments) return null;
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
};

/** cd / pushd / popd 会改变当前 shell 目录。组合命令等整行结束后再 pwd。 */
export const commandReportsDirectoryChange = (command: string): boolean => {
  const commands = listCommands(command);
  if (!commands) return false;
  return commands.some((segment) => DIRECTORY_COMMAND.test(segment));
};
