import assert from "node:assert/strict";
import test from "node:test";
import type { Host } from "./models.ts";
import { resolveTerminalSftpHost } from "./sftpTerminalIdentity.ts";

const host = (id: string, username: string): Host => ({
  id, label: id, hostname: `${id}.example.test`, port: 22, username,
  tags: [], os: "linux",
});

test("SFTP follows each focused terminal's authenticated identity across focus changes", () => {
  const root = host("shared", "root");
  const deploy = { ...root, username: "deploy", identityId: "deploy-id" };
  const other = host("other", "alice");

  assert.equal(resolveTerminalSftpHost({
    sessionHost: root, storedHost: other, authenticatedHost: deploy, followsTerminal: true,
  }), deploy);
  assert.equal(resolveTerminalSftpHost({
    sessionHost: root, storedHost: root, authenticatedHost: deploy, followsTerminal: true,
  }), deploy);
  assert.equal(resolveTerminalSftpHost({
    sessionHost: other, storedHost: deploy, authenticatedHost: undefined, followsTerminal: true,
  }), other);
  assert.equal(resolveTerminalSftpHost({
    sessionHost: root, storedHost: other, authenticatedHost: deploy, followsTerminal: true,
  }), deploy);
  assert.equal(resolveTerminalSftpHost({
    sessionHost: root, storedHost: other, authenticatedHost: deploy, followsTerminal: false,
  }), root);
  assert.equal(resolveTerminalSftpHost({
    sessionHost: root, authenticatedHost: { ...deploy, port: 2222 }, followsTerminal: true,
  }), root);
});
