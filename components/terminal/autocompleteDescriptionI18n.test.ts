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

  // Semantic fixes: registry is a package source or image registry, not the
  // Windows Registry; git --source prints a ref name, not source code.
  assert.equal(simplified["Log in to a Docker registry"], "登录 Docker 镜像仓库");
  assert.equal(traditional["Log in to a Docker registry"], "登入 Docker 映象倉庫");
  assert.equal(simplified["Publishes a package to the npm registry"], "将软件包发布到 npm 软件源");
  assert.equal(traditional["Publishes a package to the npm registry"], "將軟體包釋出到 npm 軟體源");
  assert.equal(simplified["Show source"], "显示来源");
  assert.equal(traditional["Show source"], "顯示來源");
  // git worktree is a working tree (工作树), not a workspace (工作区); the
  // two Docker capability options must use one term.
  assert.equal(simplified["Manage multiple working trees"], "管理多个工作树");
  assert.equal(simplified["Remove a working tree"], "移除工作树");
  assert.equal(simplified["Add Linux capabilities"], "添加 Linux 能力");
  assert.equal(simplified["Drop Linux capabilities"], "丢弃 Linux 能力");
  // Truncated upstream keys and semantic fixes verified against the local
  // man pages and upstream help text.
  assert.equal(
    simplified["Fetch the remote’s copy of current branch and rebases it into the local copy"],
    "获取远程上当前分支的副本，并将本地当前分支变基到该副本之上",
  );
  assert.equal(
    simplified["Composition of primaries and operands"],
    "主项（primaries）与操作数的组合",
  );
  assert.equal(
    simplified["Selects the cipher to use for encrypting the data transfer. This option is directly passed to ssh(1)"],
    "选择用于加密数据传输的密码规格。此选项直接传递给 ssh(1)",
  );
  assert.equal(
    simplified["Extract a zip file created in windows, containing files with non-ascii (chinese) filenames"],
    "解压由 Windows 创建、包含非 ASCII（中文）文件名的 zip 文件",
  );
  assert.equal(
    simplified["For writing options: write to system-wide $(prefix)/etc/gitconfig rather than"],
    "对于写入选项：写入系统级 $(prefix)/etc/gitconfig，而不是仓库的 .git/config",
  );
  assert.equal(
    simplified["Don’t display the copyright and version messages even in interactive mode"],
    "即使在交互模式下也不显示版权和版本消息",
  );
  assert.equal(simplified["List details of each working tree"], "列出每个工作树的详细信息");
  assert.equal(
    simplified["Show what revision and author last modified each line of a file"],
    "显示文件中每一行的最后修改版本和作者",
  );
  const pathspecNulKey =
    "Only meaningful with --pathspec-from-file. Pathspec elements are separated wi";
  assert.equal(
    simplified[pathspecNulKey],
    "仅与 --pathspec-from-file 一起使用时有意义。路径规格元素以 NUL 字符分隔",
  );
  assert.match(traditional[pathspecNulKey], /NUL 字元/);

  // OpenCC s2twp mis-resolves these ambiguous characters in command copy;
  // the generator's correction table must keep them out of the dictionary.
  for (const bad of ["隻", "髮", "錶", "複用", "后", "登錄檔", "註冊表"]) {
    assert.equal(
      Object.values(traditional).filter((value) => value.includes(bad)).length,
      0,
      `zh-TW still contains ${bad}`,
    );
  }
  assert.equal(
    Object.values(traditional).filter((value) => /(?<!合)併為/.test(value)).length,
    0,
    "zh-TW still contains 併為 where 並為 is required",
  );
  assert.equal(
    Object.values(simplified).filter((value) => value.includes("注册表")).length,
    0,
    "zh-CN still contains 注册表 for a package/image registry",
  );

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
