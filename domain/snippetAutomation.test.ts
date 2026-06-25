import test from "node:test";
import assert from "node:assert/strict";

import type { Host, Snippet } from "./models.ts";
import {
  applySnippetStartupAutomation,
  buildStartupCommandWithSnippetAutomation,
  getHostConnectSnippetCommands,
  shouldRunSnippetOnHostConnect,
} from "./snippetAutomation.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Prod",
  hostname: "prod.example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

const snippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "snippet-1",
  label: "Check disk",
  command: "df -h",
  tags: [],
  package: "",
  targets: ["host-1"],
  runOnConnect: true,
  ...overrides,
});

test("shouldRunSnippetOnHostConnect requires opt-in and a matching target", () => {
  assert.equal(shouldRunSnippetOnHostConnect(snippet(), "host-1"), true);
  assert.equal(shouldRunSnippetOnHostConnect(snippet({ runOnConnect: false }), "host-1"), false);
  assert.equal(shouldRunSnippetOnHostConnect(snippet({ targets: ["host-2"] }), "host-1"), false);
  assert.equal(shouldRunSnippetOnHostConnect(snippet({ command: "   " }), "host-1"), false);
});

test("getHostConnectSnippetCommands resolves defaults and skips missing variables", () => {
  const commands = getHostConnectSnippetCommands(host(), [
    snippet({ id: "a", command: "echo {{name:netcatty}}" }),
    snippet({ id: "b", command: "echo {{required}}" }),
    snippet({ id: "c", command: "uptime", targets: ["host-2"] }),
  ]);

  assert.deepEqual(commands, ["echo netcatty"]);
});

test("getHostConnectSnippetCommands uses persisted variable values when provided", () => {
  const commands = getHostConnectSnippetCommands(
    host(),
    [snippet({ id: "a", command: "deploy {{service}}" })],
    () => ({ service: "api" }),
  );

  assert.deepEqual(commands, ["deploy api"]);
});

test("buildStartupCommandWithSnippetAutomation appends snippets after host startup command", () => {
  assert.equal(
    buildStartupCommandWithSnippetAutomation({
      hostStartupCommand: "cd /srv",
      snippetCommands: ["git status", "docker ps\n"],
    }),
    "cd /srv\ngit status\ndocker ps",
  );
});

test("applySnippetStartupAutomation returns original host when no snippets apply", () => {
  const original = host();
  const result = applySnippetStartupAutomation(original, [snippet({ targets: ["other"] })]);

  assert.equal(result, original);
});

test("applySnippetStartupAutomation appends matching snippet commands", () => {
  const result = applySnippetStartupAutomation(
    host({ startupCommand: "cd /srv" }),
    [
      snippet({ id: "a", command: "git status" }),
      snippet({ id: "b", command: "echo done", runOnConnect: false }),
    ],
  );

  assert.equal(result.startupCommand, "cd /srv\ngit status");
});
