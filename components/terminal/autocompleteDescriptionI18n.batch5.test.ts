import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FIG_SPEC_DIR = path.join(ROOT, "node_modules/@withfig/autocomplete/build");
const LOCAL_SPEC_DIR = path.join(ROOT, "electron/specs");

function resolveSpecPath(name: string): string {
  const local = path.join(LOCAL_SPEC_DIR, `${name}.js`);
  return fs.existsSync(local) ? local : path.join(FIG_SPEC_DIR, `${name}.js`);
}

const DICT_DIR = path.join(HERE, "autocomplete");
const COMMANDS = ["podman"] as const;

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

test("batch 5 podman specs have complete zh-CN and zh-TW description coverage", () => {
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
  assert.ok(batchDescriptions.length >= 60);
});

test("batch 5 spot checks podman terminology", () => {
  assert.equal(
    simplified["Manage containers, pods, and images with Podman"],
    "使用 Podman 管理容器、Pod 和镜像",
  );
  assert.equal(simplified["Log in to a container registry"], "登录容器镜像仓库");
  assert.equal(simplified["List images in local storage"], "列出本地存储中的镜像");
  assert.equal(simplified["The Podman image to use"], "要使用的 Podman 镜像");
  assert.equal(simplified["Manage a virtual machine"], "管理虚拟机");
  assert.equal(simplified["Display machine host info"], "显示虚拟机主机信息");
  assert.equal(simplified["Set a virtual machine setting"], "设置虚拟机配置项");
  assert.equal(simplified["List machines"], "列出虚拟机");
  assert.equal(simplified["Inspect an existing machine"], "检查现有虚拟机");
  assert.equal(simplified["Remove an existing machine"], "移除现有虚拟机");
  assert.equal(simplified["SSH into an existing machine"], "通过 SSH 登录现有虚拟机");
  assert.equal(simplified["Start an existing machine"], "启动现有虚拟机");
  assert.equal(simplified["Stop an existing machine"], "停止现有虚拟机");
  assert.equal(
    simplified["Manipulate manifest lists and image indexes"],
    "操作清单列表和镜像索引",
  );

  assert.equal(traditional["Log in to a container registry"], "登入容器映象倉庫");
  assert.equal(traditional["Manage a virtual machine"], "管理虛擬機器");
  assert.deepEqual(Object.keys(traditional), Object.keys(simplified));
});

test("podman descriptions localize without changing insertion text", async () => {
  const cases = [
    {
      input: "podman ",
      option: "attach",
      key: "Attach to a running container",
      zhCn: "附加到正在运行的容器",
    },
    {
      input: "podman ",
      option: "build",
      key: "Build an image using instructions from Containerfiles",
      zhCn: "使用 Containerfile 中的指令构建镜像",
    },
    {
      input: "podman -",
      option: "--log-level",
      key: "Log messages above specified level (trace, debug, info, warn, warning, error, fatal, panic) (default 'warn')",
      zhCn: "记录指定级别及以上的日志消息（trace、debug、info、warn、warning、error、fatal、panic）（默认 'warn'）",
    },
    {
      input: "podman -",
      option: "--url",
      key: "URL to access Podman service (CONTAINER_HOST)",
      zhCn: "访问 Podman 服务的 URL（CONTAINER_HOST）",
    },
  ] as const;

  for (const { input, option, key, zhCn } of cases) {
    const localized = await getCompletions(input, {
      locale: "zh-CN",
      skipPathCompletion: true,
      maxResults: 100,
    });
    const suggestion = suggestionNamed(localized, option);
    assert.equal(suggestion?.displayText, option);
    assert.equal(suggestion?.description, zhCn);

    for (const locale of ["en", "ru", undefined]) {
      const fallback = await getCompletions(input, {
        locale,
        skipPathCompletion: true,
        maxResults: 100,
      });
      assert.equal(suggestionNamed(fallback, option)?.description, key);
    }
  }
});
