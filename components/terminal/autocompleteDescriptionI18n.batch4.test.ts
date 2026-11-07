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
    simplified["File(s) to readlink"],
    "要读取的符号链接文件",
  );
  assert.equal(
    simplified["Count logical lines, rather than screen lines"],
    "按逻辑行计数，而不是按屏幕行",
  );
  // Upstream dig spec labels the NS type as "Query MX Record"; the translation
  // keeps the correct meaning and records the upstream wording error.
  assert.equal(
    simplified["Query MX Record"],
    "查询 NS 记录（上游英文描述误写为 MX）",
  );
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
    { command: "basename", option: "-a", key: "Treat every argument as a string", zhCn: "把每个参数都当作字符串" },
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
  assert.equal(traditional["File(s) to readlink"], "要讀取的符號連結檔案");
  assert.equal(
    traditional["Query MX Record"],
    "查詢 NS 記錄（上游英文描述誤寫為 MX）",
  );
  assert.deepEqual(Object.keys(traditional).sort(), Object.keys(simplified).sort());
});
