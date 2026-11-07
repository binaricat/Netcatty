import assert from "node:assert/strict";
import test from "node:test";
import { COMMON_FIG_SPECS, normalizeCommandName } from "./autocomplete/figSpecLoader";

test("preload common specs includes dnf alongside yum and apt", () => {
  assert.ok(COMMON_FIG_SPECS.includes("apt"));
  assert.ok(COMMON_FIG_SPECS.includes("yum"));
  assert.ok(COMMON_FIG_SPECS.includes("dnf"));
  for (const command of ["ln", "stat", "wc", "cut", "uniq", "tee", "xargs"]) {
    assert.ok(COMMON_FIG_SPECS.includes(command), `${command} should be preloaded`);
  }
});

test("normalizeCommandName strips path and extension", () => {
  assert.equal(normalizeCommandName("/usr/bin/dnf"), "dnf");
  assert.equal(normalizeCommandName("DNF"), "dnf");
});
