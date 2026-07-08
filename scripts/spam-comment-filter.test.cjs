"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { detectSpamComment, extractDangerousFiles } = require("./spam-comment-filter.cjs");

test("flags the fake Netcatty patch spam pattern", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "User",
    body: "[netcatty_patch.zip](https://example.com/netcatty_patch.zip)\n\nMan, that terminal rendering bug is such a pain. It looks like the sftp module is tripping over the encoding when it tries to sync the current path. I found a quick patch that fixes the character mapping in the backend so those black boxes finally disappear.",
  });

  assert.equal(result.spam, true);
});

test("does not flag ordinary log attachments from outside users", () => {
  const result = detectSpamComment({
    authorAssociation: "FIRST_TIME_CONTRIBUTOR",
    userType: "User",
    body: "I attached debug-logs.zip from a failed connection. The app hangs after I click connect, and the logs show the SSH handshake timing out.",
  });

  assert.equal(result.spam, false);
});

test("does not flag trusted maintainers even when sharing patch archives", () => {
  const result = detectSpamComment({
    authorAssociation: "OWNER",
    userType: "User",
    body: "Try this temporary netcatty_patch.zip while I prepare the signed release. It fixes the rendering issue.",
  });

  assert.equal(result.spam, false);
});

test("extracts risky file names from markdown links and plain text", () => {
  assert.deepEqual(
    extractDangerousFiles("[fix.zip](https://example.com/fix.zip) also hotfix.dmg"),
    ["fix.zip", "https://example.com/fix.zip", "hotfix.dmg"]
  );
});
