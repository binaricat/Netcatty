import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FIG_SPEC_DIR = path.join(ROOT, "node_modules/@withfig/autocomplete/build");
// Runtime prefers local specs (electron/specs) over the bundled package, so the
// tests must resolve the same file the popup will load.
const LOCAL_SPEC_DIR = path.join(ROOT, "electron/specs");

function resolveSpecPath(name: string): string {
  const local = path.join(LOCAL_SPEC_DIR, `${name}.js`);
  return fs.existsSync(local) ? local : path.join(FIG_SPEC_DIR, `${name}.js`);
}
const DICT_DIR = path.join(HERE, "autocomplete");
const COMMANDS = [
  "echo",
  "which",
  "pwd",
  "clear",
  "su",
  "crontab",
  "env",
  "uname",
  "base64",
  "date",
  "id",
  "split",
  "seq",
  "join",
  "dig",
  "dd",
  "htop",
  "basename",
  "dirname",
  "readlink",
  "more",
  "paste",
] as const;

const specs = Object.fromEntries(
  await Promise.all(
    COMMANDS.map(async (name) => {
      const mod = await import(pathToFileURL(resolveSpecPath(name)).href);
      return [name, mod.default?.default ?? mod.default] as const;
    }),
  ),
) as Record<(typeof COMMANDS)[number], FigSpec>;

const simplified = JSON.parse(
  fs.readFileSync(path.join(DICT_DIR, "descriptions.zh-CN.json"), "utf8"),
) as Record<string, string>;
const traditional = JSON.parse(
  fs.readFileSync(path.join(DICT_DIR, "descriptions.zh-TW.json"), "utf8"),
) as Record<string, string>;

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
  configurable: true,
});

Object.defineProperty(globalThis, "window", {
  value: {
    netcatty: {
      listFigSpecs: async () => [...COMMANDS],
      loadFigSpec: async (commandName: string) =>
        (specs as Record<string, FigSpec>)[commandName] ?? null,
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");

function collectDescriptions(
  node: unknown,
  out = new Set<string>(),
  seen = new WeakSet<object>(),
): Set<string> {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  const record = node as { description?: unknown };
  if (typeof record.description === "string" && record.description.trim()) {
    out.add(record.description);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) collectDescriptions(item, out, seen);
    } else if (value && typeof value === "object") {
      collectDescriptions(value, out, seen);
    }
  }
  return out;
}

const batchDescriptions = [
  ...new Set(COMMANDS.flatMap((name) => [...collectDescriptions(specs[name])])),
];

function suggestionNamed(
  suggestions: Awaited<ReturnType<typeof getCompletions>>,
  displayText: string,
) {
  return suggestions.find((suggestion) => suggestion.displayText === displayText);
}

test("batch 4 specs have complete zh-CN and zh-TW description coverage", () => {
  const missing = batchDescriptions.filter(
    (description) =>
      !(typeof simplified[description] === "string" && simplified[description].length > 0),
  );
  const missingTraditional = batchDescriptions.filter(
    (description) =>
      !(typeof traditional[description] === "string" && traditional[description].length > 0),
  );

  assert.deepEqual(missing, []);
  assert.deepEqual(missingTraditional, []);
  assert.ok(batchDescriptions.length >= 150);
});

test("batch 4 spot checks preserve verified semantics, placeholders and upstream typos", () => {
  assert.equal(
    simplified["Write arguments to the standard output"],
    "将参数写入标准输出",
  );
  assert.equal(
    simplified["Locate a program in the user's PATH"],
    "在用户的 PATH 中定位程序",
  );
  assert.equal(
    simplified["Equalize the widths of all numbers by padding with zeros as necessary"],
    "必要时用零填充，使所有数字宽度一致",
  );
  assert.equal(
    simplified["Display or set the date in UTC (Coordinated Universal) time"],
    "以 UTC（协调世界时）显示或设置日期",
  );
  assert.equal(
    simplified["Return filename portion of pathname"],
    "返回路径名的文件名部分",
  );
  assert.equal(
    simplified["Symbolic link or path to resolve"],
    "要解析的符号链接或路径",
  );
  assert.equal(
    simplified["Resolve every symbolic link in the given path and print the canonical path (all but the last component must exist)"],
    "解析路径中的每个符号链接并打印规范路径（除最后一段外都必须存在）",
  );
  // Review fixes: platform, units and scope wording.
  assert.equal(simplified["Highlight new and old processes"], "高亮新启动和已退出的进程");
  assert.equal(simplified["Highlight duration in seconds"], "高亮持续时间，单位为秒");
  assert.equal(
    simplified["Use suffix_length letters to form the suffix of the file name"],
    "使用 suffix_length 个字符构成文件名后缀",
  );
  assert.ok(
    simplified["Create split files byte_count bytes in length. If k or K is appended to the number, the file is split into byte_count kilobyte pieces. If m or M is appended to the number, the file is split into byte_count megabyte pieces.  If g or G is appended to the number, the file is split into byte_count gigabyte pieces"].includes("KiB"),
  );
  assert.equal(
    simplified["Set the conversion record size"],
    "设置转换记录长度（字节），供 block/unblock 等记录转换使用",
  );
  assert.equal(
    simplified["In addition to the default output, produce a line for each unpairable line in file file_number"],
    "除默认输出外，还为第 file_number 个文件中无法配对的行各输出一行",
  );
  assert.equal(
    simplified["Treat every argument as a string"],
    "支持多个路径名，将每个参数作为路径名处理",
  );
  assert.equal(
    simplified["End each output line with NUL, not newline"],
    "每条环境变量记录以 NUL 而非换行符结束",
  );
  assert.equal(simplified["Decode input instead of encoding it"], "解码输入而不是编码");
  assert.equal(
    simplified["When decoding, ignore non-alphabet characters"],
    "解码时忽略不属于字母表的字符",
  );
  assert.ok(
    simplified["Leave the environment unmodified.  The invoked shell is your login shell, and no directory changes are made.  As a security precaution, if the target user's shell is a non-standard shell (as defined by getusershell(3)) and the caller's real uid is non-zero, su will fail"].includes("getusershell(3)"),
  );
  // dig shares A/MX/CNAME/TXT/SOA/ANY/filter keys with dog, so the caveats
  // live in the zh-CN values while the English keys stay untouched.
  assert.equal(
    simplified["Query ALL DNS Records"],
    "查询所有 DNS 记录（ANY 结果可能不完整，见 RFC 8482）",
  );
  assert.equal(
    simplified["Query only answer section"],
    "隐藏注释、问题、权威和附加区段及统计信息",
  );
  assert.equal(
    simplified["Count logical lines, rather than screen lines"],
    "按逻辑行计数，而不是按屏幕行",
  );
  // The local dig spec fixes the upstream NS label and drops the bogus TTL type.
  assert.equal(
    simplified["Query NS records (authoritative name servers)"],
    "查询 NS 记录（权威名称服务器）",
  );
  assert.equal(simplified["Query SOA Record"], "查询 SOA 记录");
  // The local GNU date spec replaces the bundled BSD option set.
  assert.equal(
    simplified["Display the last modification time of the given file"],
    "显示给定文件的最后修改时间",
  );
  assert.equal(
    traditional["Display the last modification time of the given file"],
    "顯示給定檔案的最後修改時間",
  );
  assert.equal(
    simplified["Set the system time from the given string"],
    "按给定字符串设置系统时间",
  );
  // Placeholder-bearing keys stay literal.
  assert.equal(simplified["N[K|k|M|m|G|g]"], "N[K|k|M|m|G|g]");
});

test("batch 4 descriptions localize without changing insertion text", async () => {
  const cases = [
    { command: "echo", option: "-n", key: "Do not print the trailing newline character", zhCn: "不输出末尾的换行符" },
    { command: "which", option: "-a", key: "List all instances of executables found, instead of just the first", zhCn: "列出找到的所有可执行文件实例，而不只是第一个" },
    { command: "pwd", option: "-P", key: "Display the physical current working directory", zhCn: "显示物理当前工作目录" },
    { command: "seq", option: "-w", key: "Equalize the widths of all numbers by padding with zeros as necessary", zhCn: "必要时用零填充，使所有数字宽度一致" },
    { command: "basename", option: "-a", key: "Treat every argument as a string", zhCn: "支持多个路径名，将每个参数作为路径名处理" },
    { command: "more", option: "-s", key: "Squeeze multiple blank lines into one", zhCn: "把多个空行压缩为一行" },
    { command: "clear", option: "-T", key: "Indicates the type of terminal", zhCn: "指定终端类型" },
    { command: "date", option: "-u", key: "Display or set the date in UTC (Coordinated Universal) time", zhCn: "以 UTC（协调世界时）显示或设置日期" },
  ] as const;

  for (const { command, option, key, zhCn } of cases) {
    const localized = await getCompletions(`${command} -`, {
      locale: "zh-CN",
      skipPathCompletion: true,
      maxResults: 100,
    });
    const suggestion = suggestionNamed(localized, option);
    assert.equal(suggestion?.text, `${command} ${option}`);
    assert.equal(suggestion?.displayText, option);
    assert.equal(suggestion?.description, zhCn);

    for (const locale of ["en", "ru", undefined]) {
      const fallback = await getCompletions(`${command} -`, {
        locale,
        skipPathCompletion: true,
        maxResults: 100,
      });
      const fallbackSuggestion = suggestionNamed(fallback, option);
      assert.equal(fallbackSuggestion?.text, `${command} ${option}`);
      assert.equal(fallbackSuggestion?.description, key);
    }
  }
});

test("batch 4 zh-TW uses Taiwan terminology and mirrors zh-CN keys", () => {
  assert.equal(traditional["Write arguments to the standard output"], "將引數寫入標準輸出");
  assert.equal(traditional["Locate a program in the user's PATH"], "在使用者的 PATH 中定位程式");
  assert.equal(
    traditional["Return filename portion of pathname"],
    "返回路徑名的檔名部分",
  );
  assert.equal(traditional["Symbolic link or path to resolve"], "要解析的符號連結或路徑");
  assert.equal(traditional["Join on the field'th field of file1"], "按 file1 的第 field 個欄位聯結");
  assert.equal(traditional["Use a numeric suffix instead of a alphabetic suffix"], "使用數字字尾而不是字母字尾");
  assert.equal(
    traditional["List all instances of executables found, instead of just the first"],
    "列出找到的所有執行檔，而不只是第一個",
  );
  assert.equal(
    traditional["Instead, clear the whole screen and then display the text"],
    "改為清空整個螢幕後再顯示文字",
  );
  assert.ok(
    traditional["The file is split whenever an input line matches pattern, which is interpreted as an extended regular expression. The matching line will be the first line of the next output file. This option is incompatible with the -b and -l options"].includes("擴充正規表示式"),
  );
  assert.ok(
    traditional["Do not attempt to clear terminal's scrollback buffer using the extended E3 capability"].includes("擴充 E3"),
  );
  assert.equal(traditional["Decode input instead of encoding it"], "解碼輸入而不是編碼");
  // s2twp merges 打印 + 机器 into 印表機 when the boundary is not guarded, so
  // the zh-CN wording avoids that sequence instead of holding it out.
  assert.equal(traditional["Print the machine hardware name"], "顯示機器硬體名稱");
  assert.equal(
    traditional["Print the machine processor architecture name"],
    "顯示機器處理器架構名稱",
  );
  assert.equal(simplified["Print the machine hardware name"], "显示机器硬件名称");
  assert.equal(
    traditional["Query NS records (authoritative name servers)"],
    "查詢 NS 記錄（權威名稱伺服器）",
  );
  assert.deepEqual(Object.keys(traditional).sort(), Object.keys(simplified).sort());
});
