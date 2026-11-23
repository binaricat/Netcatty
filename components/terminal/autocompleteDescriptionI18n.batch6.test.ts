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
const COMMANDS = ["ip"] as const;

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

test("batch 6 ip spec has complete zh-CN and zh-TW description coverage", () => {
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
  assert.ok(batchDescriptions.length >= 80);
});

test("batch 6 spot checks ip terminology", () => {
  assert.equal(
    simplified["Show / manipulate routing, network devices, interfaces and tunnels"],
    "显示/操作路由、网络设备、接口和隧道",
  );
  assert.equal(simplified["Manage addresses"], "管理地址");
  assert.equal(simplified["Display addresses"], "显示地址");
  assert.equal(simplified["Manage network devices"], "管理网络设备");
  assert.equal(simplified["Specify the protocol family"], "指定协议族");
  assert.equal(simplified["Watch for netlink messages"], "监视 netlink 消息");

  assert.equal(
    traditional["Show / manipulate routing, network devices, interfaces and tunnels"],
    "顯示/操作路由、網路裝置、介面和隧道",
  );
  assert.equal(traditional["Manage addresses"], "管理地址");
  assert.equal(traditional["Manage network devices"], "管理網路裝置");
  assert.deepEqual(Object.keys(traditional), Object.keys(simplified));
});

test("ip descriptions localize without changing insertion text", async () => {
  const cases = [
    {
      input: "ip ",
      option: "address",
      key: "Manage addresses",
      zhCn: "管理地址",
    },
    {
      input: "ip addr ",
      option: "show",
      key: "Display addresses",
      zhCn: "显示地址",
    },
    {
      input: "ip -",
      option: "-4",
      key: "Use IPv4",
      zhCn: "使用 IPv4",
    },
    {
      input: "ip -",
      option: "-f",
      key: "Specify the protocol family",
      zhCn: "指定协议族",
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
