import test from "node:test";
import assert from "node:assert/strict";

import { parseShellArgs, formatShellArgs } from "./shellArgs";

test("parseShellArgs splits plain space-separated args", () => {
  assert.deepEqual(parseShellArgs("--login -i"), ["--login", "-i"]);
});

test("parseShellArgs returns empty array for empty or whitespace input", () => {
  assert.deepEqual(parseShellArgs(""), []);
  assert.deepEqual(parseShellArgs("   "), []);
});

test("parseShellArgs collapses surrounding and repeated whitespace", () => {
  assert.deepEqual(parseShellArgs("  --login   -i  "), ["--login", "-i"]);
  assert.deepEqual(parseShellArgs("\t--login\t-i\n"), ["--login", "-i"]);
});

test("parseShellArgs keeps double-quoted args with spaces intact", () => {
  assert.deepEqual(
    parseShellArgs('--rcfile "C:\\Program Files\\rc"'),
    ["--rcfile", "C:\\Program Files\\rc"],
  );
});

test("parseShellArgs keeps single-quoted args with spaces intact", () => {
  assert.deepEqual(parseShellArgs("--msg 'hello world'"), ["--msg", "hello world"]);
});

test("parseShellArgs allows quotes in the middle of a token", () => {
  assert.deepEqual(parseShellArgs('a"b c"d'), ["ab cd"]);
});

test("formatShellArgs joins plain args with single spaces", () => {
  assert.equal(formatShellArgs(["--login", "-i"]), "--login -i");
});

test("formatShellArgs returns empty string for empty array", () => {
  assert.equal(formatShellArgs([]), "");
});

test("formatShellArgs single-quotes tokens containing whitespace", () => {
  assert.equal(formatShellArgs(["--msg", "hello world"]), "--msg 'hello world'");
});

test("formatShellArgs keeps Windows backslash paths intact (no escaping)", () => {
  assert.equal(formatShellArgs(["--rcfile", "C:\\Program Files\\rc"]), "--rcfile 'C:\\Program Files\\rc'");
});

test("parse and format round-trip", () => {
  const cases: string[][] = [
    [],
    ["--login", "-i"],
    ["--msg", "hello world"],
    ["--rcfile", "C:\\Program Files\\rc"],
    ["-c", 'echo "hello world"'],
    ["--msg", "it's fine"],
    ["-c", `echo "it's ok"`],
    ["a'b", 'c"d'],
    ["C:\\dir\\"],
    ["-c", ""],
  ];
  for (const args of cases) {
    assert.deepEqual(parseShellArgs(formatShellArgs(args)), args);
  }
});

test("parseShellArgs preserves a trailing backslash inside double quotes", () => {
  assert.deepEqual(parseShellArgs('"C:\\dir\\"'), ["C:\\dir\\"]);
});

test("formatShellArgs uses single quotes for tokens containing double quotes", () => {
  assert.equal(formatShellArgs(['echo "x"']), `'echo "x"'`);
});

test("formatShellArgs uses the POSIX '\\'' idiom for embedded single quotes", () => {
  assert.equal(formatShellArgs(["it's"]), "'it'\\''s'");
});

test("formatShellArgs emits an explicit empty arg as ''", () => {
  assert.equal(formatShellArgs(["-c", ""]), "-c ''");
});
