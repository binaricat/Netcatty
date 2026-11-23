import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadFixture(relativePath: string): Promise<FigSpec> {
  const mod = await import(pathToFileURL(path.join(ROOT, relativePath)).href);
  return mod.default?.default ?? mod.default;
}

const [su, linuxReadlink, macReadlink, linuxDate, macDate, bundledDate, linuxBase64, macBase64] = await Promise.all([
  loadFixture("node_modules/@withfig/autocomplete/build/su.js"),
  loadFixture("electron/specs/readlink.js"),
  loadFixture("electron/specs/macos/readlink.js"),
  loadFixture("electron/specs/date.js"),
  loadFixture("electron/specs/macos/date.js"),
  loadFixture("node_modules/@withfig/autocomplete/build/date.js"),
  loadFixture("electron/specs/base64.js"),
  loadFixture("node_modules/@withfig/autocomplete/build/base64.js"),
]);

const byPlatform: Record<string, Record<string, FigSpec>> = {
  linux: { su, readlink: linuxReadlink, date: linuxDate, base64: linuxBase64 },
  macos: { su, readlink: macReadlink, date: macDate, base64: macBase64 },
};
const descriptionsDir = path.join(ROOT, "components/terminal/autocomplete");
const dictionaries = {
  "zh-CN": JSON.parse(fs.readFileSync(path.join(descriptionsDir, "descriptions.zh-CN.json"), "utf8")) as Record<string, string>,
  "zh-TW": JSON.parse(fs.readFileSync(path.join(descriptionsDir, "descriptions.zh-TW.json"), "utf8")) as Record<string, string>,
};

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    netcatty: {
      listFigSpecs: async () => ["su", "readlink", "date", "base64"],
      loadFigSpec: async (name: string, hostOs?: string) =>
        byPlatform[hostOs ?? "linux"]?.[name] ?? null,
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");
type Locale = "en" | "zh-CN" | "zh-TW";

async function suggestions(input: string, os: "linux" | "macos", locale: Locale) {
  return getCompletions(input, { os, locale, skipPathCompletion: true, maxResults: 100 });
}

function collectDescriptions(node: unknown, out = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  const entry = node as Record<string, unknown>;
  if (typeof entry.description === "string" && entry.description.trim()) out.add(entry.description);
  for (const value of Object.values(entry)) {
    if (Array.isArray(value)) value.forEach((child) => collectDescriptions(child, out, seen));
    else if (value && typeof value === "object") collectDescriptions(value, out, seen);
  }
  return out;
}

test("su -m distinguishes BSD login shells from util-linux shell selection", async () => {
  const expected: Record<Locale, string> = {
    en: "Leave the environment unmodified.  The invoked shell is your login shell, and no directory changes are made.  As a security precaution, if the target user's shell is a non-standard shell (as defined by getusershell(3)) and the caller's real uid is non-zero, su will fail",
    "zh-CN": "尝试保留环境并通常保持当前工作目录。BSD 使用调用者的登录 shell；目标 shell 不在 getusershell(3) 列表且调用者非 root 时会失败。Linux util-linux 优先使用 -s 指定的 shell，其次使用 SHELL；受限 shell、登录选项及 PAM 可能影响结果",
    "zh-TW": "嘗試保留環境並通常保持當前工作目錄。BSD 使用呼叫者的登入 shell；目標 shell 不在 getusershell(3) 列表且呼叫者非 root 時會失敗。Linux util-linux 優先使用 -s 指定的 shell，其次使用 SHELL；受限 shell、登入選項及 PAM 可能影響結果",
  };
  for (const os of ["linux", "macos"] as const) {
    for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
      const option = (await suggestions("su -", os, locale)).find((item) => item.displayText === "-m");
      assert.equal(option?.text, "su -m");
      assert.equal(option?.description, expected[locale]);
    }
  }
});

test("GNU readlink quiet and verbose suggestions use the correct descriptions", async () => {
  const expected: Record<Locale, { quiet: string; verbose: string }> = {
    en: { quiet: "Suppress most error messages", verbose: "Report error messages" },
    "zh-CN": { quiet: "抑制大多数错误消息", verbose: "显示错误消息" },
    "zh-TW": { quiet: "抑制大多數錯誤訊息", verbose: "顯示錯誤訊息" },
  };
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const result = await suggestions("readlink -", "linux", locale);
    for (const option of ["-q", "--quiet", "-s", "--silent"]) {
      const item = result.find((value) => value.displayText === option);
      assert.equal(item?.text, `readlink ${option}`);
      assert.equal(item?.description, expected[locale].quiet);
    }
    for (const option of ["-v", "--verbose"]) {
      const item = result.find((value) => value.displayText === option);
      assert.equal(item?.text, `readlink ${option}`);
      assert.equal(item?.description, expected[locale].verbose);
    }
    assert.equal(result.some((item) => item.displayText === "--strip"), false);
  }
});

test("all descriptions in macOS date and base64 specs have both translations", () => {
  for (const [name, spec] of Object.entries({ macDate, bundledDate, macBase64, macReadlink })) {
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      const missing = [...collectDescriptions(spec)].filter((description) => !dictionary[description]?.trim());
      assert.deepEqual(missing, [], `${name}: missing ${locale} translations`);
    }
  }
});

test("macOS date falls back to the bundled spec and keeps its original option semantics", async () => {
  const { loadFigSpec } = createRequire(import.meta.url)("../../electron/main/registerBridges.cjs") as {
    loadFigSpec: (electronDir: string, name: string, os: string) => Promise<FigSpec | null>;
  };
  // This existing directory has no local specs but shares the real node_modules.
  const electronDirWithoutOverrides = path.join(ROOT, "scripts");
  assert.equal(fs.existsSync(path.join(electronDirWithoutOverrides, "specs/macos/date.js")), false);
  const fallback = await loadFigSpec(electronDirWithoutOverrides, "date", "macos");
  assert.ok(fallback);
  const option = (name: string) => fallback.options?.find((item) =>
    (Array.isArray(item.name) ? item.name : [item.name]).includes(name));
  const cases = [
    ["-d", "Set the kernel's value for daylight saving time", "设置内核的夏令时标志", "設定核心的夏令時標誌"],
    ["-t", "Set the system's value for minutes west of GMT", "设置系统中相对于 GMT 向西的分钟数", "設定系統中相對於 GMT 向西的分鐘數"],
    ["-n", "Only set time on the current machine, instead of all machines in the local group", "仅设置当前机器的时间，不设置本地组内其他机器的时间", "僅設定當前機器的時間，不設定本地組內其他機器的時間"],
    ["-r", "Print the date and time represented by the specified number of seconds since the Epoch", "显示自纪元起指定秒数所对应的日期和时间", "顯示自紀元起指定秒數所對應的日期和時間"],
  ];
  const { localizeSpecSuggestionDescriptions } = await import("./autocomplete/autocompleteDescriptionI18n.ts");
  for (const [name, english, simplified, traditional] of cases) {
    const entry = option(name);
    assert.equal(entry?.description, english);
    assert.equal((await localizeSpecSuggestionDescriptions([entry!], "en"))[0].description, english);
    assert.equal((await localizeSpecSuggestionDescriptions([entry!], "zh-CN"))[0].description, simplified);
    assert.equal((await localizeSpecSuggestionDescriptions([entry!], "zh-TW"))[0].description, traditional);
  }
  const referenceArg = option("-r")?.args;
  assert.ok(referenceArg && !Array.isArray(referenceArg));
  const seconds = "Number of seconds since the Epoch (00:00:00 UTC, January 1, 1970)";
  assert.equal(referenceArg.description, seconds);
  assert.equal(dictionaries["zh-CN"][seconds], "自纪元（1970 年 1 月 1 日 00:00:00 UTC）起的秒数");
  assert.equal(dictionaries["zh-TW"][seconds], "自紀元（1970 年 1 月 1 日 00:00:00 UTC）起的秒數");
});

test("macOS date and base64 show localized BSD semantics", async () => {
  const expected: Record<Locale, { obsolete: string; reference: string; zone: string; input: string; wrap: string }> = {
    en: {
      obsolete: "Obsolete option, accepted and ignored for compatibility",
      reference: "Display a file's modification time or a time expressed in seconds since the Epoch",
      zone: "Display the time in the specified output time zone",
      input: "Read input from input_file.  Default is stdin; passing - also represents stdin",
      wrap: "Insert line breaks every count characters.  Default is 0, which generates an unbroken stream",
    },
    "zh-CN": {
      obsolete: "过时选项；为兼容而接受，但会被忽略",
      reference: "显示文件的最后修改时间，或自纪元起指定秒数对应的时间",
      zone: "按指定的输出时区显示时间",
      input: "从 input_file 读取输入；默认为标准输入，'-' 也表示标准输入",
      wrap: "每 count 个字符插入换行符；默认为 0，输出不换行",
    },
    "zh-TW": {
      obsolete: "過時選項；為相容而接受，但會被忽略",
      reference: "顯示檔案的最後修改時間，或自紀元起指定秒數對應的時間",
      zone: "按指定的輸出時區顯示時間",
      input: "從 input_file 讀取輸入；預設為標準輸入，'-' 也表示標準輸入",
      wrap: "每 count 個字元插入換行符；預設為 0，輸出不換行",
    },
  };
  assert.deepEqual(macDate.options?.find((option) => option.name === "-z")?.args, { name: "output_zone" });
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const dateOptions = await suggestions("date -", "macos", locale);
    assert.equal(dateOptions.find((item) => item.displayText === "-n")?.description, expected[locale].obsolete);
    assert.equal(dateOptions.find((item) => item.displayText === "-r")?.description, expected[locale].reference);
    const zone = dateOptions.find((item) => item.displayText === "-z");
    assert.equal(zone?.text, "date -z");
    assert.equal(zone?.description, expected[locale].zone);
    const base64Options = await suggestions("base64 -", "macos", locale);
    assert.equal(base64Options.find((item) => item.displayText === "-i")?.description, expected[locale].input);
    assert.equal(base64Options.find((item) => item.displayText === "-b")?.description, expected[locale].wrap);
  }
});

test("macOS readlink shows the localized BSD canonicalization option", async () => {
  const expected: Record<Locale, string> = {
    en: "Resolve symbolic links and print the canonical path only if all components exist",
    "zh-CN": "解析符号链接，仅当所有路径组件都存在时才打印规范路径",
    "zh-TW": "解析符號連結，僅當所有路徑元件都存在時才打印規範路徑",
  };
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const result = await suggestions("readlink -", "macos", locale);
    const option = result.find((item) => item.displayText === "-f");
    assert.equal(option?.text, "readlink -f");
    assert.equal(option?.description, expected[locale]);
    assert.equal(result.some((item) => item.displayText === "-s"), false);
  }
});

test("macOS description translations retain their argument and format literals", () => {
  const literalCases: Array<[string, string[]]> = [
    ["Read input from input_file.  Default is stdin; passing - also represents stdin", ["input_file", "'-'"]],
    ["Write output to output_file.  Default is stdout; passing - also represents stdout", ["output_file", "'-'"]],
    ["[+|-]val[ymwdHMS]", ["[+|-]val[ymwdHMS]"]],
    ["Use specified format for input instead of the default [[[mm]dd]HH]MM[[cc]yy][.ss] format", ["[[[mm]dd]HH]MM[[cc]yy][.ss]"]],
  ];
  for (const dictionary of Object.values(dictionaries)) {
    for (const [key, literals] of literalCases) {
      for (const literal of literals) assert.ok(dictionary[key]?.includes(literal), `${key}: missing ${literal}`);
    }
  }
});
