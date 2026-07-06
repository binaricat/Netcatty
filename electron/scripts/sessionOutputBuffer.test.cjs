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

test("tryMatch keeps wildcard-looking strings literal", () => {
  assert.equal(
    tryMatch("literal .* [broken", ".* [broken"),
    ".* [broken",
  );
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

test("SessionOutputBuffer waitForRegex resolves regex source strings across line breaks", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForRegex(".*SSH资源.*登录方式.*", 1000);
  buffer.append("1. SSH资源\n请选择SSH资源\n'zxadmin'登录方式:");
  assert.equal(await pending, "1. SSH资源\n请选择SSH资源\n'zxadmin'登录方式:");
});

test("SessionOutputBuffer waitFor treats wildcard-looking strings as literal text", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitFor(".*SSH资源.*登录方式.*", 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });

  buffer.append("1. SSH资源\n请选择SSH资源\n'zxadmin'登录方式:");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\n.*SSH资源.*登录方式.*");
  assert.equal(await pending, ".*SSH资源.*登录方式.*");
});

test("SessionOutputBuffer waitFor preserves slash regex dot behavior", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitFor("/BEGIN.*END/", 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });

  buffer.append("BEGIN\nEND");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nBEGIN END");
  assert.equal(await pending, "BEGIN END");
});

test("SessionOutputBuffer waitFor handles invalid-regex-looking strings literally", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitFor("literal .* [broken", 1000);
  buffer.append("literal .* [broken");
  assert.equal(await pending, "literal .* [broken");
});

test("SessionOutputBuffer waitForRegex resolves simple source strings immediately", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append("READY");
  assert.equal(await buffer.waitForRegex("READY", 1000), "READY");
});

test("SessionOutputBuffer waitForRegex resolves simple source strings after append", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForRegex("READY", 1000);
  buffer.append("READY");
  assert.equal(await pending, "READY");
});

test("SessionOutputBuffer waitForText keeps strings literal", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForText("资源'[Empty]'账户:", 1000);
  buffer.append("资源'[Empty]'账户:");
  assert.equal(await pending, "资源'[Empty]'账户:");
});

test("SessionOutputBuffer waitForText treats wildcard-looking strings as literal text", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForText("literal .* prompt", 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  buffer.append("literal abc prompt");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nliteral .* prompt");
  assert.equal(await pending, "literal .* prompt");
});

test("SessionOutputBuffer waitForRegex does not treat stale edge-wildcard matches as fresh", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`SSH资源${"x".repeat(600)}`);

  const pending = buffer.waitForRegex(".*SSH资源.*", 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nSSH资源");
  assert.equal(await pending, "\nSSH资源");
});

test("SessionOutputBuffer waitForRegex preserves the full regex match value", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForRegex("Version: .*", 1000);
  buffer.append("Version: 1.2.3 ready");
  assert.equal(await pending, "Version: 1.2.3 ready");
});

test("SessionOutputBuffer waitForRegex applies stale protection to RegExp objects", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`SSH资源${"x".repeat(600)}`);

  const pending = buffer.waitForRegex(/.*SSH资源.*/s, 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nSSH资源");
  assert.equal(await pending, "\nSSH资源");
});

test("SessionOutputBuffer waitForRegex handles lazy edge wildcards", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForRegex(/.*?READY.*?/s, 1000);
  buffer.append("READY");
  assert.equal(await pending, "READY");
});

test("SessionOutputBuffer waitForRegex applies stale protection to anchored edge wildcards", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`READY${"x".repeat(600)}`);

  const pending = buffer.waitForRegex(/^.*READY.*$/s, 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nREADY");
  assert.equal(await pending, "\nREADY");
});

test("SessionOutputBuffer waitForRegex applies stale protection to edge plus wildcards", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`xREADYy${"x".repeat(600)}`);

  const pending = buffer.waitForRegex(/.+READY.+/s, 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nxREADYy");
  assert.equal(await pending, "\nxREADYy");
});

test("SessionOutputBuffer waitForRegex accepts fresh core matches later in a full regex result", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForRegex(".*READY.*", 1000);
  buffer.append(`READY${"x".repeat(600)}READY`);
  assert.equal(await pending, `READY${"x".repeat(600)}READY`);
});

test("SessionOutputBuffer waitForRegex does not combine stale prefix with fresh suffix", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`SSH资源${"x".repeat(600)}`);

  const pending = buffer.waitForRegex(".*SSH资源.*登录方式.*", 1000);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });

  buffer.append("\n登录方式:");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nSSH资源\n登录方式:");
  assert.equal(await pending, "\nSSH资源\n登录方式:");
});

test("SessionOutputBuffer waitForRegex finds fresh match after rejected stale overlap", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`SSH资源${"x".repeat(600)}`);

  const pending = buffer.waitForRegex(".*SSH资源.*登录方式.*", 1000);
  buffer.append("\n登录方式:\nSSH资源\n登录方式:");
  assert.equal(await pending, "\nSSH资源\n登录方式:");
});

test("SessionOutputBuffer waitForRegex rejects preexisting stale prefix with tail suffix", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`SSH资源${"x".repeat(600)}登录方式:`);

  const pending = buffer.waitForRegex(".*SSH资源.*登录方式.*", 1000);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);

  buffer.append("\nSSH资源\n登录方式:");
  assert.equal(await pending, "\nSSH资源\n登录方式:");
});

test("SessionOutputBuffer waitForRegex does not loop forever on stale zero-length matches", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`READY${"x".repeat(600)}`);

  await assert.rejects(
    buffer.waitForRegex(/(?=READY)/, 50),
    /waitForRegex timed out/,
  );
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

test("SessionOutputBuffer waitFor slash regex matches output followed by long multi-line burst", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitFor("/SSH资源\\(/", 1000);
  const menu = Array.from({ length: 15 }, (_, i) => `  [${i}] menu entry line`).join("\n");
  buffer.append(`user login success\n\nSSH资源(5) :\n${menu}\n\n> `);
  assert.equal(await pending, "SSH资源(");
});

test("SessionOutputBuffer waitForText matches literal text followed by long multi-line burst", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForText("SSH资源(", 1000);
  buffer.append(`SSH资源(5) :\n${"x".repeat(600)}`);
  assert.equal(await pending, "SSH资源(");
});

test("SessionOutputBuffer waitForRegex matches core followed by long multi-line burst", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForRegex(".*SSH资源\\(.*", 1000);
  const burst = `SSH资源(5) :\n${"x".repeat(600)}`;
  buffer.append(burst);
  assert.equal(await pending, burst);
});

test("SessionOutputBuffer waitForAny matches pattern followed by long multi-line burst", async () => {
  const buffer = new SessionOutputBuffer("s1");
  const pending = buffer.waitForAny(["账户:", "密码:"], 1000);
  buffer.append(`资源'[Empty]'账户:\n${"x".repeat(600)}`);
  assert.equal(await pending, 0);
});

test("SessionOutputBuffer waitForText survives buffer trimming while waiting", async () => {
  const buffer = new SessionOutputBuffer("s1", 1024);
  buffer.append("x".repeat(1000));
  const pending = buffer.waitForText("TARGET", 1000);
  buffer.append(`${"y".repeat(100)}TARGET${"z".repeat(500)}`);
  assert.equal(await pending, "TARGET");
});

test("SessionOutputBuffer waitForRegex survives buffer trimming while waiting", async () => {
  const buffer = new SessionOutputBuffer("s1", 1024);
  buffer.append("x".repeat(1000));
  const pending = buffer.waitForRegex("TARGET", 1000);
  buffer.append(`${"y".repeat(100)}TARGET${"z".repeat(500)}`);
  assert.equal(await pending, "TARGET");
});

test("SessionOutputBuffer waitForAny survives buffer trimming while waiting", async () => {
  const buffer = new SessionOutputBuffer("s1", 1024);
  buffer.append("x".repeat(1000));
  const pending = buffer.waitForAny(["TARGET"], 1000);
  buffer.append(`${"y".repeat(100)}TARGET${"z".repeat(500)}`);
  assert.equal(await pending, 0);
});

test("SessionOutputBuffer waitFor still rejects pre-registration scrollback beyond tail slack", async () => {
  const buffer = new SessionOutputBuffer("s1");
  buffer.append(`TARGET${"x".repeat(600)}`);
  const pending = buffer.waitFor("TARGET", 200);
  let resolvedEarly = false;
  void pending.then(() => {
    resolvedEarly = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolvedEarly, false);
  buffer.append("\nTARGET");
  assert.equal(await pending, "TARGET");
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
    { type: "waitFor", value: "DONE", timeoutMs: 5000 },
    { type: "waitForPrompt", timeoutMs: 30000 },
  ], "2026-06-27");
  assert.match(code, /sendLine\("ls -la"\)/);
  assert.match(code, /waitForText\("DONE", 5000\)/);
  assert.match(code, /waitForPrompt\(30000\)/);
  assert.doesNotMatch(code, /waitFor\("DONE"/);
});
