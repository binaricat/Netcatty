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
const COMMANDS = ["ln", "stat", "wc", "cut", "uniq", "tee", "xargs"] as const;

const specs = Object.fromEntries(
  await Promise.all(
    COMMANDS.map(async (name) => {
      const mod = await import(pathToFileURL(path.join(SPEC_DIR, `${name}.js`)).href);
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

test("batch 3 specs have complete zh-CN and zh-TW description coverage", () => {
  const missing = batchDescriptions.filter(
    (description) => !(typeof simplified[description] === "string" && simplified[description].length > 0),
  );
  const missingTraditional = batchDescriptions.filter(
    (description) => !(typeof traditional[description] === "string" && traditional[description].length > 0),
  );

  assert.deepEqual(missing, []);
  assert.deepEqual(missingTraditional, []);
  assert.ok(batchDescriptions.length >= 70);
});

test("batch 3 spot checks correct verified semantics and upstream wording", () => {
  assert.equal(
    simplified["World, line, character, and byte count"],
    "统计单词数、行数、字符数和字节数",
  );
  assert.equal(
    traditional["World, line, character, and byte count"],
    "統計單詞數、行數、字元數和位元組數",
  );
  assert.equal(
    simplified["Terminal if the arguments will not fit in the maximum line length"],
    "若参数超出最大行长度则终止",
  );
  assert.equal(
    traditional["Terminal if the arguments will not fit in the maximum line length"],
    "若引數超出最大行長度則終止",
  );
  assert.equal(
    simplified["Report or omit repeated line"],
    "报告或省略重复行",
  );
  assert.equal(
    traditional["Report or omit repeated line"],
    "報告或省略重複行",
  );
  assert.equal(
    simplified["Use delim as the field delimiter character instead of the tab character"],
    "使用 delim 作为字段分隔符，而不是制表符",
  );
  assert.equal(
    traditional["Use delim as the field delimiter character instead of the tab character"],
    "使用 delim 作為欄位分隔符，而不是製表符",
  );
});

test("ln, stat, wc, cut, uniq, tee and xargs descriptions localize without changing insertion text", async () => {
  const cases = [
    {
      input: "ln -",
      option: "-s",
      key: "Create a symbolic link",
      zhCn: "创建符号链接",
    },
    {
      input: "stat -",
      option: "-f",
      key: "Display information using the specified format; similar to printf(3) formats in that they start with %, are then followed by a sequence of formatting characters, and end in a character that selects the field of the struct stat which is to be formatted",
      zhCn: "按指定格式显示信息；类似 printf(3)：以 % 开头，后接格式化字符，并以选择 struct stat 待格式化字段的字符结尾",
    },
    {
      input: "wc -",
      option: "-l",
      key: "Output the number of lines to the standard input",
      zhCn: "输出行数",
    },
    {
      input: "cut -",
      option: "-d",
      key: "Use delim as the field delimiter character instead of the tab character",
      zhCn: "使用 delim 作为字段分隔符，而不是制表符",
    },
    {
      input: "uniq -",
      option: "-c",
      key: "Prefix lines by the number of occurrences",
      zhCn: "在每行前加上出现次数",
    },
    {
      input: "tee -",
      option: "-a",
      key: "Append the output to the files rather than overwriting them",
      zhCn: "将输出追加到文件而不是覆盖",
    },
    {
      input: "xargs -",
      option: "-0",
      key: "Use NUL (0x00) as a separator, instead of whitespace",
      zhCn: "使用 NUL（0x00）而非空白作为分隔符",
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

  const traditionalResults = await getCompletions("uniq -", {
    locale: "zh-TW",
    skipPathCompletion: true,
    maxResults: 100,
  });
  assert.equal(suggestionNamed(traditionalResults, "-c")?.description, "在每行前加上出現次數");
});
