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
const COMMANDS = ["zip", "unzip", "make", "nano"] as const;

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
        specs[commandName as (typeof COMMANDS)[number]] ?? null,
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");
const { localizeSpecSuggestionDescriptions } = await import(
  "./autocomplete/autocompleteDescriptionI18n.ts"
);

function collectDescriptions(node: unknown, out = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
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

test("batch specs have complete zh-CN and zh-TW description coverage", async () => {
  assert.ok(batchDescriptions.length >= 32);
  for (const description of batchDescriptions) {
    assert.equal(typeof simplified[description], "string", `missing zh-CN: ${description}`);
    assert.ok(simplified[description].length > 0, `empty zh-CN: ${description}`);
    assert.equal(typeof traditional[description], "string", `missing zh-TW: ${description}`);
    assert.ok(traditional[description].length > 0, `empty zh-TW: ${description}`);
  }

  const localized = await localizeSpecSuggestionDescriptions(
    batchDescriptions.map((description) => ({ text: description, description })),
    "zh-CN",
  );
  for (const [index, suggestion] of localized.entries()) {
    assert.equal(suggestion.text, batchDescriptions[index]);
    assert.notEqual(suggestion.description, batchDescriptions[index]);
  }
});

test("batch zh-TW spot checks cover corrected semantics", () => {
  assert.equal(
    traditional["Archive a directory and its contents with the highest level [9] of compression"],
    "使用最高壓縮級別 9",
  );
  assert.equal(
    traditional["Extract a zip file created in windows, containing files with non-ascii (chinese) filenames"],
    "上游選項疑似錯誤，請核對當前 unzip 版本支援的引數",
  );
  assert.equal(
    traditional["Turn on value of next option"],
    "啟用指定的 NeXT 相容選項（Apple 擴充套件）",
  );
});

test("zip, unzip, and make options localize without changing insertion text", async () => {
  const cases = [
    { input: "zip -", option: "-r", zhCn: "递归打包并压缩目录及其内容" },
    { input: "zip -", option: "-9", zhCn: "使用最高压缩级别 9" },
    { input: "unzip -", option: "-l", zhCn: "列出 zip 文件内容而不解压" },
    {
      input: "unzip -",
      option: "-0",
      zhCn: "上游选项疑似错误，请核对当前 unzip 版本支持的参数",
    },
    { input: "make -", option: "-N", zhCn: "启用指定的 NeXT 兼容选项（Apple 扩展）" },
    { input: "make --", option: "--warn-undefined-variables", zhCn: "引用未定义变量时发出警告" },
  ];

  for (const { input, option, zhCn } of cases) {
    const suggestions = await getCompletions(input, {
      locale: "zh-CN",
      skipPathCompletion: true,
      maxResults: 50,
    });
    const suggestion = suggestionNamed(suggestions, option);
    assert.equal(suggestion?.text, `${input.split(" ")[0]} ${option}`);
    assert.equal(suggestion?.description, zhCn);
  }
});

test("batch command descriptions localize and English remains the fallback", async () => {
  const nano = specs.nano.description;
  assert.ok(nano);

  const [zhCn] = await localizeSpecSuggestionDescriptions([{ description: nano }], "zh-CN");
  const [zhTw] = await localizeSpecSuggestionDescriptions([{ description: nano }], "zh-TW");
  const [en] = await localizeSpecSuggestionDescriptions([{ description: nano }], "en");

  assert.equal(zhCn.description, "Nano 的 ANOther 编辑器，一个增强的免费 Pico 克隆");
  assert.equal(zhTw.description, "Nano 的 ANOther 編輯器，一個增強的免費 Pico 克隆");
  assert.equal(en.description, nano);
  assert.equal(specs.nano.description, nano);
});
