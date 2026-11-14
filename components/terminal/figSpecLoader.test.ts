import assert from "node:assert/strict";
import test from "node:test";
import { COMMON_FIG_SPECS, getAvailableSpecs, hasSpec, loadSpec, normalizeCommandName } from "./autocomplete/figSpecLoader";

test("preload common specs includes dnf alongside yum and apt", () => {
  assert.ok(COMMON_FIG_SPECS.includes("apt"));
  assert.ok(COMMON_FIG_SPECS.includes("yum"));
  assert.ok(COMMON_FIG_SPECS.includes("dnf"));
  for (const command of ["ln", "stat", "wc", "cut", "uniq", "tee", "xargs"]) {
    assert.ok(COMMON_FIG_SPECS.includes(command), `${command} should be preloaded`);
  }
  const batch4Commands = [
    "echo", "which", "paste", "pwd", "clear", "su", "crontab", "env", "uname",
    "base64", "date", "id", "split", "seq", "join", "dig", "dd", "htop",
    "basename", "dirname", "readlink", "more",
  ];
  for (const command of batch4Commands) {
    assert.ok(COMMON_FIG_SPECS.includes(command), `${command} should be preloaded`);
  }
});

test("normalizeCommandName strips path and extension", () => {
  assert.equal(normalizeCommandName("/usr/bin/dnf"), "dnf");
  assert.equal(normalizeCommandName("DNF"), "dnf");
});

test("caches and deduplicates specs separately for each target OS", async () => {
  const calls: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { loadFigSpec: async (name: string, hostOs: string) => {
      calls.push(`${name}:${hostOs}`);
      return { name, description: hostOs };
    } } },
  });
  const [linux, linuxAgain, macos] = await Promise.all([
    loadSpec("platform-cache-fixture", "linux"),
    loadSpec("platform-cache-fixture", "linux"),
    loadSpec("platform-cache-fixture", "macos"),
  ]);
  assert.equal(linux?.description, "linux");
  assert.equal(linuxAgain, linux);
  assert.equal(macos?.description, "macos");
  assert.deepEqual(calls, ["platform-cache-fixture:linux", "platform-cache-fixture:macos"]);
  assert.equal(await loadSpec("platform-cache-fixture", "macos"), macos);
  assert.equal(calls.length, 2);
});

test("retries a spec load after the bridge becomes available", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  assert.equal(await loadSpec("retry-fixture", "linux"), null);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { loadFigSpec: async (name: string) => ({ name }) } },
  });
  assert.equal((await loadSpec("retry-fixture", "linux"))?.name, "retry-fixture");
});

test("available specs are cached and resolved per target OS", async () => {
  const listCalls: Array<string | undefined> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: {
      listFigSpecs: async (hostOs?: string) => {
        listCalls.push(hostOs);
        return hostOs === "macos" ? ["common-fixture", "mac-only-fixture"] : ["common-fixture"];
      },
      loadFigSpec: async (name: string, hostOs?: string) =>
        (name === "mac-only-fixture" && hostOs === "macos" ? { name } : null),
    } },
  });

  assert.deepEqual(await getAvailableSpecs("linux"), ["common-fixture"]);
  assert.deepEqual(await getAvailableSpecs("linux"), ["common-fixture"]);
  assert.deepEqual(listCalls, ["linux"], "the Linux list should be fetched once");

  assert.deepEqual(await getAvailableSpecs("macos"), ["common-fixture", "mac-only-fixture"]);
  assert.deepEqual(listCalls, ["linux", "macos"]);

  assert.equal(await hasSpec("mac-only-fixture", "linux"), false);
  assert.equal(await hasSpec("mac-only-fixture", "macos"), true);
  assert.equal(await hasSpec("common-fixture", "linux"), true);

  // A successful macOS load must not advertise the command to Linux.
  assert.equal((await loadSpec("mac-only-fixture", "macos"))?.name, "mac-only-fixture");
  assert.equal(await hasSpec("mac-only-fixture", "linux"), false);
  assert.equal(await loadSpec("mac-only-fixture", "linux"), null);
});
