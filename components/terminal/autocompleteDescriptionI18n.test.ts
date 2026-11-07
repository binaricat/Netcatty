import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

const SINCE = "Show logs since timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)";
const SINCE_ZH = "从指定时间起显示日志（例如 2013-01-02T13:23:37Z），也可用相对时间（例如 42m 表示 42 分钟）";
const SINCE_TW = "從指定時間起顯示日誌（例如 2013-01-02T13:23:37Z），也可用相對時間（例如 42m 表示 42 分鐘）";
const FILE_REMOVED = "\"%s: File removed before we read it\"";
const FILE_REMOVED_TW = "\"%s: 讀取前檔案已被刪除\"";
const DEFAULT_LABEL = "(Default)";
const NETWORK = "Add a network";
const PROCESS_TREE = "ASCII art process tree";
const COMPRESSION_PROGRAM = "Do not use archive suffix to determine the compression program";
const UNTRANSLATED = "This autocomplete description is intentionally untranslated.";

const dockerSpec: FigSpec = {
  name: "docker",
  subcommands: [
    {
      name: "logs",
      options: [
        { name: "--since", description: SINCE },
        { name: "--mystery", description: UNTRANSLATED },
        { name: "--default-sample", description: DEFAULT_LABEL },
        { name: "--network-sample", description: NETWORK },
        { name: "--process-sample", description: PROCESS_TREE },
        { name: "--file-sample", description: FILE_REMOVED },
      ],
    },
  ],
};

const TOUCH = {
  command: "Change file access and modification times",
  adjust: "Adjust the access and modification time stamps for the file by the specified value",
  access: "Change the access time of the file",
  noCreate: "Do not create the file if it does not exist",
  force: "Attempt to force the update, even if the file permissions do not currently permit it",
  link: "If the file is a symbolic link, change the times of the link itself rather than the file that the link points to",
  modify: "Change the modification time of the file",
  reference: "Use the access and modifications times from the specified file instead of the current time of day",
  timestamp: "Change the access and modification times to the specified time instead of the current time of day",
} as const;

const touchSpec: FigSpec = {
  name: "touch",
  description: TOUCH.command,
  options: [
    { name: "-A", description: TOUCH.adjust },
    { name: "-a", description: TOUCH.access },
    { name: "-c", description: TOUCH.noCreate },
    { name: "-f", description: TOUCH.force },
    { name: "-h", description: TOUCH.link },
    { name: "-m", description: TOUCH.modify },
    { name: "-r", description: TOUCH.reference },
    { name: "-t", description: TOUCH.timestamp },
  ],
};

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
      listFigSpecs: async () => ["docker", "touch"],
      loadFigSpec: async (commandName: string) => ({
        docker: dockerSpec,
        touch: touchSpec,
      } as Record<string, FigSpec>)[commandName] ?? null,
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");

function sinceSuggestion(suggestions: Awaited<ReturnType<typeof getCompletions>>) {
  return suggestions.find((suggestion) => suggestion.displayText === "--since");
}

function suggestionNamed(
  suggestions: Awaited<ReturnType<typeof getCompletions>>,
  displayText: string,
) {
  return suggestions.find((suggestion) => suggestion.displayText === displayText);
}

test("zh-CN translates docker logs --since and falls back for unknown descriptions", async () => {
  const suggestions = await getCompletions("docker logs --", {
    locale: "zh-CN",
    skipPathCompletion: true,
    maxResults: 20,
  });
  const since = sinceSuggestion(suggestions);
  const mystery = suggestions.find((suggestion) => suggestion.displayText === "--mystery");

  assert.equal(since?.displayText, "--since");
  assert.equal(since?.description, SINCE_ZH);
  assert.equal(mystery?.description, UNTRANSLATED);
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});

test("en locale leaves autocomplete descriptions unchanged", async () => {
  const suggestions = await getCompletions("docker logs --", {
    locale: "en",
    skipPathCompletion: true,
    maxResults: 20,
  });
  const since = sinceSuggestion(suggestions);

  assert.equal(since?.displayText, "--since");
  assert.equal(since?.description, SINCE);
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});

test("zh-TW translates descriptions with Taiwan phrases and falls back when missing", async () => {
  const suggestions = await getCompletions("docker logs --", {
    locale: "zh-TW",
    skipPathCompletion: true,
    maxResults: 20,
  });

  assert.equal(sinceSuggestion(suggestions)?.description, SINCE_TW);
  assert.equal(suggestionNamed(suggestions, "--default-sample")?.description, "（預設）");
  assert.equal(suggestionNamed(suggestions, "--network-sample")?.description, "新增網路");
  assert.equal(suggestionNamed(suggestions, "--process-sample")?.description, "ASCII 藝術行程樹");
  assert.equal(suggestionNamed(suggestions, "--file-sample")?.description, FILE_REMOVED_TW);
  assert.equal(suggestionNamed(suggestions, "--mystery")?.description, UNTRANSLATED);
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});

test("locales other than zh-CN and zh-TW keep English descriptions", async () => {
  for (const locale of ["ru", "es", "zh-Hant", undefined]) {
    const suggestions = await getCompletions("docker logs --", {
      locale,
      skipPathCompletion: true,
      maxResults: 20,
    });
    assert.equal(sinceSuggestion(suggestions)?.description, SINCE);
    assert.equal(suggestionNamed(suggestions, "--process-sample")?.description, PROCESS_TREE);
  }
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});

test("zh-CN translates touch options without changing the command", async () => {
  const suggestions = await getCompletions("touch -", {
    locale: "zh-CN",
    skipPathCompletion: true,
    maxResults: 20,
  });

  assert.equal(suggestionNamed(suggestions, "-A")?.description, "按指定值调整文件的访问时间和修改时间");
  assert.equal(suggestionNamed(suggestions, "-a")?.description, "仅修改文件的访问时间");
  assert.equal(suggestionNamed(suggestions, "-c")?.description, "文件不存在时不创建文件");
  assert.equal(suggestionNamed(suggestions, "-f")?.description, "即使当前文件权限不允许，也尝试强制更新时间");
  assert.equal(suggestionNamed(suggestions, "-h")?.description, "如果文件是符号链接，则修改链接本身的时间，而不是链接所指向文件的时间");
  assert.equal(suggestionNamed(suggestions, "-m")?.description, "仅修改文件的修改时间");
  assert.equal(suggestionNamed(suggestions, "-r")?.description, "使用指定文件的访问时间和修改时间，而不是当前时间");
  assert.equal(suggestionNamed(suggestions, "-t")?.description, "将访问时间和修改时间设为指定时间，而不是当前时间");
  assert.equal(touchSpec.options?.[0].description, TOUCH.adjust);
});

test("zh-CN and zh-TW overlays do not leak across later lookups", async () => {
  const traditional = await getCompletions("docker logs --", {
    locale: "zh-TW",
    skipPathCompletion: true,
    maxResults: 20,
  });
  const simplified = await getCompletions("docker logs --", {
    locale: "zh-CN",
    skipPathCompletion: true,
    maxResults: 20,
  });
  const english = await getCompletions("docker logs --", {
    locale: "en",
    skipPathCompletion: true,
    maxResults: 20,
  });

  assert.equal(sinceSuggestion(traditional)?.description, SINCE_TW);
  assert.equal(sinceSuggestion(simplified)?.description, SINCE_ZH);
  assert.equal(sinceSuggestion(english)?.description, SINCE);
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});

test("committed zh-TW dictionary keeps zh-CN keys and Taiwan terminology", () => {
  const dictDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "autocomplete");
  const simplified = JSON.parse(fs.readFileSync(path.join(dictDir, "descriptions.zh-CN.json"), "utf8"));
  const traditional = JSON.parse(fs.readFileSync(path.join(dictDir, "descriptions.zh-TW.json"), "utf8"));

  assert.deepEqual(Object.keys(traditional), Object.keys(simplified));
  assert.equal(simplified[DEFAULT_LABEL], "（默认）");
  assert.equal(traditional[DEFAULT_LABEL], "（預設）");
  assert.equal(traditional[NETWORK], "新增網路");
  assert.equal(traditional[PROCESS_TREE], "ASCII 藝術行程樹");
  assert.equal(traditional[FILE_REMOVED], FILE_REMOVED_TW);
  assert.equal(traditional[SINCE], SINCE_TW);
  assert.equal(traditional[COMPRESSION_PROGRAM], "不根據歸檔字尾判斷壓縮程式");

  let processCount = 0;
  let tripCount = 0;
  for (const key of Object.keys(simplified)) {
    const source = simplified[key];
    const converted = traditional[key];
    assert.equal(typeof converted, "string");
    assert.equal(converted.includes("进程"), false);
    assert.equal(converted.includes("默认"), false);
    assert.equal(converted.includes("网络"), false);
    processCount += source.split("进程").length - 1;
    tripCount += converted.split("行程").length - 1;
  }
  assert.ok(processCount > 0);
  assert.equal(tripCount, processCount);
});
