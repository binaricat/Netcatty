import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "./models";
import {
  canElevateSftpForTerminalDrop,
  hasUsableSftpSudoPassword,
  normalizePosixAbsolutePath,
  posixPathNeedsLoginUserElevation,
  resolveTerminalDropSftpHost,
  TerminalDropNeedsSudoError,
} from "./sftpDropElevation";

const host = {
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  port: 22,
  username: "alice",
  protocol: "ssh",
} as Host;

const encryptedPassword = (() => {
  const blob = Buffer.alloc(19, 0);
  Buffer.from("v10", "utf8").copy(blob, 0);
  return `enc:v1:${blob.toString("base64")}`;
})();

test("normalizePosixAbsolutePath collapses slashes and trailing separators", () => {
  assert.equal(normalizePosixAbsolutePath("/root/"), "/root");
  assert.equal(normalizePosixAbsolutePath("/root//bin/"), "/root/bin");
  assert.equal(normalizePosixAbsolutePath("/"), "/");
  assert.equal(normalizePosixAbsolutePath("root"), null);
  assert.equal(normalizePosixAbsolutePath("  "), null);
});

test("posixPathNeedsLoginUserElevation only flags /root for non-root logins", () => {
  assert.equal(posixPathNeedsLoginUserElevation("/root", "alice"), true);
  assert.equal(posixPathNeedsLoginUserElevation("/root/bin", "alice"), true);
  assert.equal(posixPathNeedsLoginUserElevation("/root/", "alice"), true);
  assert.equal(posixPathNeedsLoginUserElevation("/home/alice", "alice"), false);
  assert.equal(posixPathNeedsLoginUserElevation("/tmp", "alice"), false);
  assert.equal(posixPathNeedsLoginUserElevation("/root", "root"), false);
  assert.equal(posixPathNeedsLoginUserElevation("/root", "  "), false);
  assert.equal(posixPathNeedsLoginUserElevation("/root", undefined), false);
});

test("hasUsableSftpSudoPassword ignores missing and encrypted placeholders", () => {
  assert.equal(hasUsableSftpSudoPassword("secret"), true);
  assert.equal(hasUsableSftpSudoPassword(""), false);
  assert.equal(hasUsableSftpSudoPassword(undefined), false);
  assert.equal(hasUsableSftpSudoPassword(encryptedPassword), false);
});

test("canElevateSftpForTerminalDrop rejects SCP and missing passwords", () => {
  assert.equal(canElevateSftpForTerminalDrop({ sftpSudo: true }), true);
  assert.equal(canElevateSftpForTerminalDrop({}, "secret"), true);
  assert.equal(canElevateSftpForTerminalDrop({ sftpFileProtocol: "scp" }, "secret"), false);
  assert.equal(canElevateSftpForTerminalDrop({}), false);
});

test("resolveTerminalDropSftpHost clones sudo only for unelevated /root drops", () => {
  const elevated = resolveTerminalDropSftpHost(host, "/root", { password: "secret" });
  assert.equal(elevated.sftpSudo, true);
  assert.notEqual(elevated, host);

  const alreadySudo = { ...host, sftpSudo: true };
  assert.equal(resolveTerminalDropSftpHost(alreadySudo, "/root"), alreadySudo);

  assert.equal(resolveTerminalDropSftpHost(host, "/home/alice", { password: "secret" }), host);
});

test("resolveTerminalDropSftpHost uses a resolved identity password when host.password is empty", () => {
  const identityHost = { ...host, identityId: "id-1", password: undefined };
  const elevated = resolveTerminalDropSftpHost(identityHost, "/root", { password: "identity-secret" });
  assert.equal(elevated.sftpSudo, true);
  assert.equal(elevated.password, undefined);
  assert.equal(elevated.identityId, "id-1");
});

test("resolveTerminalDropSftpHost uses the resolved identity username over a stale host username", () => {
  const staleRootHost = { ...host, username: "root" };
  const elevated = resolveTerminalDropSftpHost(staleRootHost, "/root", {
    password: "secret",
    username: "alice",
  });
  assert.equal(elevated.sftpSudo, true);

  const staleAliceHost = { ...host, username: "alice" };
  assert.equal(
    resolveTerminalDropSftpHost(staleAliceHost, "/root", {
      password: "secret",
      username: "root",
    }),
    staleAliceHost,
  );
});

test("resolveTerminalDropSftpHost asks the user to enable sudo when no password is saved", () => {
  assert.throws(
    () => resolveTerminalDropSftpHost(host, "/root"),
    TerminalDropNeedsSudoError,
  );
  assert.throws(
    () => resolveTerminalDropSftpHost({ ...host, sftpFileProtocol: "scp" }, "/root", { password: "secret" }),
    TerminalDropNeedsSudoError,
  );
});
