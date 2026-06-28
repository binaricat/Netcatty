"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionOutputBuffer, tryMatch } = require("./sessionOutputBuffer.cjs");
const { SHELL_PROMPT_END_REGEX } = require("./shellPromptPatterns.cjs");
const { stepsToJavaScript } = require("./scriptCodegen.cjs");

test("tryMatch finds substring patterns", () => {
  assert.equal(tryMatch("hello world", "world"), "world");
});

test("tryMatch supports slash-delimited regex patterns", () => {
  assert.equal(tryMatch("sudo password:", "/password/i"), "password");
});

test("tryMatch accepts RegExp objects from an isolated vm context", () => {
  const vm = require("node:vm");
  const sandbox = {};
  vm.createContext(sandbox);
  const pattern = vm.runInContext("/SAMPLE_4_DONE/", sandbox);
  assert.equal(tryMatch("tag_SAMPLE_4_DONE ok", pattern), "SAMPLE_4_DONE");
});

test("SessionOutputBuffer waitFor resolves on appended data", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitFor("$ ", 1000);
  buffer.append("user@host:$ ");
  assert.equal(await pending, "$ ");
});

test("SessionOutputBuffer waitFor resolves root shell prompt", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitFor("# ", 1000);
  buffer.append("Welcome to Ubuntu\nroot@VM-4-16-ubuntu:~# ");
  assert.equal(await pending, "# ");
});

test("shell prompt regex matches root and user prompts", () => {
  assert.match("root@VM-4-16-ubuntu:~# ", SHELL_PROMPT_END_REGEX);
  assert.match("user@host:~$ ", SHELL_PROMPT_END_REGEX);
  assert.doesNotMatch("Welcome to Ubuntu 22.04", SHELL_PROMPT_END_REGEX);
});

test("SessionOutputBuffer waitForAny matches shell prompt patterns", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForAny(["# ", "$ ", SHELL_PROMPT_END_REGEX], 1000);
  buffer.append("root@VM-4-16-ubuntu:~# ");
  assert.equal(await pending, 0);
});

test("SessionOutputBuffer waitFor ignores stale prompt before cursor", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("user@host:~$ ");
  const first = buffer.waitFor("$ ", 1000);
  assert.equal(await first, "$ ");

  const second = buffer.waitFor("$ ", 1000);
  let resolvedEarly = false;
  void second.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolvedEarly, false);

  buffer.append("ls output\nuser@host:~$ ");
  assert.equal(await second, "$ ");
});

test("stepsToJavaScript sends sensitive prompt result", () => {
  const code = stepsToJavaScript([
    { type: "send", value: "secret", sensitive: true },
    { type: "waitForPrompt", timeoutMs: 30000 },
  ], "2026-06-27");
  assert.match(code, /const sensitiveValue0 = await nct\.dialog\.prompt\("Enter sensitive value", ""\);/);
  assert.match(code, /await nct\.screen\.sendLine\(sensitiveValue0\);/);
});

test("stepsToJavaScript generates sendLine and waitForPrompt steps", () => {
  const code = stepsToJavaScript([
    { type: "waitForPrompt", timeoutMs: 30000 },
    { type: "send", value: "ls -la" },
    { type: "waitForPrompt", timeoutMs: 30000 },
  ], "2026-06-27");
  assert.match(code, /sendLine\("ls -la"\)/);
  assert.match(code, /waitForPrompt\(30000\)/);
  assert.doesNotMatch(code, /waitFor\("\$ "/);
});
