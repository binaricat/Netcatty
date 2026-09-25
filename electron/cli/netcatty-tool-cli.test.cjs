"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs, bindHostChatSession, requireChatSession } = require("./netcatty-tool-cli.cjs");
const { buildCatalogCliParams } = require("../capabilities/adapters/cliAdapter.cjs");
const { TOOL_CLI_CHAT_SESSION_ENV_VAR } = require("./cliChatSession.cjs");

function fakeCreateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test("parseArgs consumes attachment filename flag", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "attachment",
    "read",
    "--filename",
    "hosts.csv",
    "--json",
  ]);

  assert.deepEqual(positionals, ["attachment", "read"]);
  assert.equal(opts.filename, "hosts.csv");
  assert.equal(opts.chatSessionId, null);
  assert.equal(opts.json, true);
});

test("parseArgs rejects the removed --chat-session flag", () => {
  assert.throws(
    () => parseArgs([
      "node",
      "netcatty-tool-cli",
      "env",
      "--chat-session",
      "other-chat",
      "--json",
    ]),
    (err) => {
      assert.equal(err.code, "INVALID_ARGUMENT");
      assert.match(err.message, /not a CLI flag/);
      return true;
    },
  );
});

test("parseArgs consumes snippet multi-line run mode flag", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "snippets",
    "update",
    "--snippet-id",
    "snippet-1",
    "--multi-line-run-mode",
    "lineDelay",
    "--json",
  ]);

  assert.deepEqual(positionals, ["snippets", "update"]);
  assert.equal(opts.snippetId, "snippet-1");
  assert.equal(opts.multiLineRunMode, "lineDelay");
  assert.equal(opts.json, true);
});

test("parseArgs consumes dynamic script group targets", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "scripts",
    "targets",
    "set",
    "--script-id",
    "script-1",
    "--target-groups",
    '["Production","Staging/Web"]',
    "--json",
  ]);

  assert.deepEqual(positionals, ["scripts", "targets", "set"]);
  assert.equal(opts.scriptId, "script-1");
  assert.equal(opts.targetGroups, '["Production","Staging/Web"]');
  assert.equal(opts.json, true);
});

test("parseArgs consumes vault note import flags", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "notes",
    "import",
    "--file-name",
    "runbook.md",
    "--title",
    "Runbook",
    "--content",
    "# Steps",
    "--group",
    "ops",
    "--json",
  ]);

  assert.deepEqual(positionals, ["notes", "import"]);
  assert.equal(opts.fileName, "runbook.md");
  assert.equal(opts.title, "Runbook");
  assert.equal(opts.content, "# Steps");
  assert.equal(opts.group, "ops");
  assert.equal(opts.json, true);
});

test("notes CLI keeps explicit empty content and group through parse and catalog params", () => {
  const cleared = parseArgs([
    "node",
    "netcatty-tool-cli",
    "notes",
    "update",
    "--note-id",
    "n1",
    "--content",
    "",
    "--group",
    "",
    "--json",
  ]);
  assert.equal(cleared.opts.content, "");
  assert.equal(cleared.opts.group, "");
  const updateParams = buildCatalogCliParams("vault.note.update", cleared.opts, fakeCreateError);
  assert.equal(updateParams.noteId, "n1");
  assert.equal(updateParams.content, "");
  assert.equal(updateParams.group, "");
  assert.equal("title" in updateParams, false);

  const imported = parseArgs([
    "node",
    "netcatty-tool-cli",
    "notes",
    "import",
    "--file-name",
    "empty.md",
    "--content",
    "",
    "--json",
  ]);
  assert.equal(imported.opts.content, "");
  const importParams = buildCatalogCliParams("vault.note.import", imported.opts, fakeCreateError);
  assert.equal(importParams.fileName, "empty.md");
  assert.equal(importParams.content, "");
});

test("requireChatSession accepts a resolved id", () => {
  assert.equal(requireChatSession({ chatSessionId: "chat-1" }, "env"), "chat-1");
});

test("requireChatSession explains the host env var when missing", () => {
  assert.throws(
    () => requireChatSession({ chatSessionId: null }, "env"),
    (err) => {
      assert.equal(err.code, "INVALID_ARGUMENT");
      assert.match(err.message, /NETCATTY_CLI_CHAT_SESSION_ID/);
      assert.doesNotMatch(err.message, /Pass --chat-session/);
      return true;
    },
  );
});

test("bindHostChatSession copies only the host env id onto opts", () => {
  const opts = { chatSessionId: null };
  bindHostChatSession(opts, { [TOOL_CLI_CHAT_SESSION_ENV_VAR]: "ai_123" });
  assert.equal(opts.chatSessionId, "ai_123");
});
