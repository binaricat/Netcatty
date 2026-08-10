const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

const dnfSpecPath = path.join(__dirname, "..", "specs", "dnf.js");

function resolveNames(name) {
  return Array.isArray(name) ? name : [name];
}

function collectSubcommandNames(spec) {
  const names = new Set();
  for (const sub of spec.subcommands || []) {
    for (const n of resolveNames(sub.name)) names.add(n);
  }
  return names;
}

test("local dnf fig spec covers common Rocky/RHEL package-manager commands", async () => {
  assert.equal(fs.existsSync(dnfSpecPath), true, "electron/specs/dnf.js should exist");

  const mod = await import(pathToFileURL(dnfSpecPath).href);
  const spec = mod.default?.default ?? mod.default;
  assert.ok(spec, "dnf spec should export a default completionSpec");
  assert.equal(spec.name, "dnf");

  const names = collectSubcommandNames(spec);
  for (const required of [
    "install",
    "remove",
    "upgrade",
    "update",
    "autoremove",
    "reinstall",
    "downgrade",
    "search",
    "info",
    "list",
    "provides",
    "clean",
    "makecache",
    "repolist",
    "history",
    "group",
    "distro-sync",
    "swap",
    "module",
  ]) {
    assert.equal(names.has(required), true, `missing dnf subcommand: ${required}`);
  }

  const group = (spec.subcommands || []).find((s) => resolveNames(s.name).includes("group"));
  assert.ok(group, "group subcommand should exist");
  const groupNames = collectSubcommandNames(group);
  for (const required of ["install", "remove", "list", "info"]) {
    assert.equal(groupNames.has(required), true, `missing dnf group subcommand: ${required}`);
  }
});
