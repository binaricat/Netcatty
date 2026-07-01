"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionOutputBuffer, tryMatch } = require("./sessionOutputBuffer.cjs");
const { SHELL_PROMPT_END_REGEX, shellPromptPatterns } = require("./shellPromptPatterns.cjs");
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

test("SessionOutputBuffer waitFor ignores stale scrollback not near buffer tail", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`${"x".repeat(600)}Do you want to reset password? ${"x".repeat(600)}`);

  const pending = buffer.waitFor(/Do you want to reset password/, 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("Do you want to reset password? ");
  assert.equal(await pending, "Do you want to reset password");
});

test("SessionOutputBuffer waitFor resolves prompt already at buffer tail", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("root@host:~# ");
  assert.equal(await buffer.waitFor("# ", 1000), "# ");
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

test("SessionOutputBuffer markCurrentOutputConsumed prevents startup text from matching", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("previous deploy READY\nuser@host:~$ ");
  buffer.markCurrentOutputConsumed({ preserveTailPatterns: shellPromptPatterns() });

  const pending = buffer.waitFor("READY", 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("fresh READY\n");
  assert.equal(await pending, "READY");
});

test("SessionOutputBuffer markCurrentOutputConsumed preserves the startup prompt once", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("root@host:~# ");
  buffer.markCurrentOutputConsumed({ preserveTailPatterns: shellPromptPatterns() });

  assert.equal(
    await buffer.waitForAny(
      shellPromptPatterns(),
      1000,
      undefined,
      { allowPreservedTailMatch: true },
    ),
    0,
  );

  const second = buffer.waitForAny(shellPromptPatterns(), 200);
  let resolvedEarly = false;
  void second.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("root@host:~# ");
  assert.equal(await second, 0);
});

test("SessionOutputBuffer normal waitForAny does not consume preserved startup prompts", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("previous deploy READY\nuser@host:~$ ");
  buffer.markCurrentOutputConsumed({ preserveTailPatterns: shellPromptPatterns() });

  const pending = buffer.waitForAny(["READY", ...shellPromptPatterns()], 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("READY\n");
  assert.equal(await pending, 0);
});

test("SessionOutputBuffer preserved prompt can be consumed explicitly for waitForPrompt", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("previous deploy READY\nuser@host:~$ ");
  buffer.markCurrentOutputConsumed({ preserveTailPatterns: shellPromptPatterns() });

  assert.equal(
    await buffer.waitForAny(
      ["READY", ...shellPromptPatterns()],
      1000,
      undefined,
      { allowPreservedTailMatch: true },
    ),
    2,
  );
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
