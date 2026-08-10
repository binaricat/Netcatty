import assert from "node:assert/strict";
import test from "node:test";
import { COMMON_FIG_SPECS, normalizeCommandName } from "./autocomplete/figSpecLoader";

test("preload common specs includes dnf alongside yum and apt", () => {
  assert.ok(COMMON_FIG_SPECS.includes("apt"));
  assert.ok(COMMON_FIG_SPECS.includes("yum"));
  assert.ok(COMMON_FIG_SPECS.includes("dnf"));
});

test("normalizeCommandName strips path and extension", () => {
  assert.equal(normalizeCommandName("/usr/bin/dnf"), "dnf");
  assert.equal(normalizeCommandName("DNF"), "dnf");
});
