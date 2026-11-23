import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SPEC_DIR = path.join(ROOT, "node_modules/@withfig/autocomplete/build");
const DICT_DIR = path.join(HERE, "autocomplete");
const COMMANDS = ["python", "python3", "node", "vim", "sort", "awk", "sed"] as const;

const DEFERRED_NODE_KEY =
  "Follows symlinks to directories when examining source code and templates for translation strings";

const specs = Object.fromEntries(
  await Promise.all(
    COMMANDS.map(async (name) => {
      const localSpec = path.join(ROOT, "electron/specs", `${name}.js`);
      const specFile = fs.existsSync(localSpec) ? localSpec : path.join(SPEC_DIR, `${name}.js`);
      const mod = await import(pathToFileURL(specFile).href);
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

const batchDescriptions = [...new Set(COMMANDS.flatMap((name) => [...collectDescriptions(specs[name])]))];

function suggestionNamed(
  suggestions: Awaited<ReturnType<typeof getCompletions>>,
  displayText: string,
) {
  return suggestions.find((suggestion) => suggestion.displayText === displayText);
}

test("batch specs cover every description except the documented node shared-key conflict", () => {
  const missing = batchDescriptions.filter(
    (description) => !(typeof simplified[description] === "string" && simplified[description].length > 0),
  );

  assert.deepEqual(missing, [DEFERRED_NODE_KEY]);
  assert.equal(typeof simplified[DEFERRED_NODE_KEY], "undefined");
  assert.equal(typeof traditional[DEFERRED_NODE_KEY], "undefined");
  assert.ok(batchDescriptions.length >= 178);
});

test("batch zh-TW spot checks cover generated terminology", () => {
  assert.equal(
    traditional["Don’t display the copyright and version messages even in interactive mode"],
    "上游選項疑似錯誤：互動模式下不顯示版權和版本資訊請用 -q",
  );
  assert.equal(traditional["Watch input files"], "監視輸入檔案");
  assert.equal(
    traditional["'nocompatible', Vim defaults, no plugins, no viminfo"],
    "'nocompatible'、Vim 預設值、不載入外掛、不使用 viminfo",
  );
  assert.equal(
    traditional["Set the maximum number of execution threads.  Default number equals to the number of CPUs"],
    "設定並行排序的執行緒數",
  );
  assert.equal(
    traditional["Prints the pattern space, then, regardless, replaces the pattern space with the next line of input. If there is no more input then sed exits without processing any more commands"],
    "未停用自動列印時，先列印模式空間；隨後用下一行輸入替換模式空間。若無更多輸入則退出。",
  );
  assert.equal(
    traditional["Run in POSIX compatibility mode (gawk)"],
    "以傳統相容模式執行，行為等同 Brian Kernighan 的 awk（gawk）",
  );
  assert.equal(
    traditional["Interprets regular expressions as extended (modern) regular expressions rather than basic regular expressions"],
    "將正規表示式解釋為擴充套件（現代）正規表示式，而不是基本正規表示式",
  );
});

test("python, node, vim, sort, awk, and sed options localize without changing insertion text", async () => {
  const cases = [
    {
      input: "python -",
      option: "-B",
      key: "If given, Python won’t try to write .pyc files on the import of source modules",
      zhCn: "指定后，Python 在导入源模块时不会写入 .pyc 文件",
    },
    {
      input: "python -",
      option: "-I",
      key: "Run Python in isolated mode. This also implies -E and -s. In isolated mode sys.path contains neither the script’s directory nor the user’s site-packages directory",
      zhCn: "以隔离模式运行 Python，同时隐含 -E 和 -s。隔离模式下 sys.path 不包含脚本目录和用户 site-packages 目录",
    },
    {
      input: "python -",
      option: "-g",
      key: "Don’t display the copyright and version messages even in interactive mode",
      zhCn: "上游选项疑似错误：交互模式下不显示版权和版本信息请用 -q",
    },
    {
      input: "python3 -",
      option: "-m",
      key: "Search sys.path for the named module and execute its contents as the __main__ module",
      zhCn: "在 sys.path 中搜索指定模块，并将其内容作为 __main__ 模块执行",
    },
    {
      input: "node -",
      option: "--watch",
      key: "Watch input files",
      zhCn: "监视输入文件",
    },
    {
      input: "node -",
      option: "--env-file",
      key: "Specify a file containing environment variables",
      zhCn: "指定包含环境变量的文件",
    },
    {
      input: "node -",
      option: "--inspect",
      key: "Activate inspector on host:port (default: 127.0.0.1:9229)",
      zhCn: "在 host:port 上启用检查器（默认：127.0.0.1:9229）",
    },
    {
      input: "node -",
      option: "--preserve-symlinks",
      key: DEFERRED_NODE_KEY,
      zhCn: DEFERRED_NODE_KEY,
    },
    {
      input: "vim -",
      option: "-R",
      key: "Readonly mode (like 'view')",
      zhCn: "只读模式（类似 'view'）",
    },
    {
      input: "vim -",
      option: "--clean",
      key: "'nocompatible', Vim defaults, no plugins, no viminfo",
      zhCn: "'nocompatible'、Vim 默认值、不加载插件、不使用 viminfo",
    },
    {
      input: "sort -",
      option: "--parallel",
      key: "Set the maximum number of execution threads.  Default number equals to the number of CPUs",
      zhCn: "设置并行排序的线程数",
    },
    {
      input: "sort -",
      option: "--radixsort",
      key: "Try to use radix sort, if the sort specifications allow",
      zhCn: "若排序规范允许，尝试使用基数排序",
    },
    {
      input: "awk -",
      option: "-c",
      key: "Run in POSIX compatibility mode (gawk)",
      zhCn: "以传统兼容模式运行，行为等同 Brian Kernighan 的 awk（gawk）",
    },
    {
      input: "awk -",
      option: "-n",
      key: "Disable automatic input record splitting (gawk)",
      zhCn: "识别输入数据中的八进制和十六进制值，请谨慎使用（gawk）",
    },
    {
      input: "awk -",
      option: "-t",
      key: "Enable type checking (gawk)",
      zhCn: "对无法移植到原始 UNIX awk 的构造发出警告（gawk）",
    },
    {
      input: "sed -",
      option: "-E",
      key: "Interprets regular expressions as extended (modern) regular expressions rather than basic regular expressions",
      zhCn: "将正则表达式解释为扩展（现代）正则表达式，而不是基本正则表达式",
    },
    {
      input: "sed -",
      option: "-r",
      key: "Same as `-E` for compatibility with GNU sed",
      zhCn: "与 `-E` 相同，用于兼容 GNU sed",
    },
    {
      input: "sed ",
      option: "n",
      key: "Prints the pattern space, then, regardless, replaces the pattern space with the next line of input. If there is no more input then sed exits without processing any more commands",
      zhCn: "未禁用自动打印时，先打印模式空间；随后用下一行输入替换模式空间。若无更多输入则退出。",
    },
  ];

  for (const { input, option, key, zhCn } of cases) {
    const command = input.split(" ")[0];
    const localized = await getCompletions(input, {
      locale: "zh-CN",
      skipPathCompletion: true,
      maxResults: 100,
    });
    const suggestion = suggestionNamed(localized, option);
    assert.equal(suggestion?.text, `${command} ${option}`);
    assert.equal(suggestion?.description, zhCn);

    for (const locale of ["en", "ru", undefined]) {
      const fallback = await getCompletions(input, {
        locale,
        skipPathCompletion: true,
        maxResults: 100,
      });
      const fallbackSuggestion = suggestionNamed(fallback, option);
      assert.equal(fallbackSuggestion?.text, `${command} ${option}`);
      assert.equal(fallbackSuggestion?.description, key);
    }
  }

  assert.equal(specs.python.description, "Run the python interpreter");
  assert.equal(specs.sort.description, "Sort or merge records (lines) of text and binary files");
});
