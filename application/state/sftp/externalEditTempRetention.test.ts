import assert from "node:assert/strict";
import test from "node:test";
import { createExternalEditTempRetention } from "./externalEditTempRetention";

test("remembers distinct temps per sftp session and forgets one session without touching others", () => {
  const retention = createExternalEditTempRetention();

  assert.equal(retention.remember("sftp-a", "/tmp/a.txt"), true);
  assert.equal(retention.remember("sftp-a", "/tmp/a.txt"), false);
  assert.equal(retention.remember("sftp-b", "/tmp/b.txt"), true);
  assert.equal(retention.size, 2);

  assert.equal(retention.forgetSftp("sftp-a"), true);
  assert.equal(retention.size, 1);
  assert.equal(retention.forgetSftp("sftp-a"), false);
  assert.equal(retention.forgetPath("/tmp/b.txt"), true);
  assert.equal(retention.size, 0);
});

test("clear drops every retainer after session-wide cleanup", () => {
  const retention = createExternalEditTempRetention();
  retention.remember("sftp-1", "/tmp/one.txt");
  retention.remember("sftp-2", "/tmp/two.txt");

  assert.equal(retention.clear(), true);
  assert.equal(retention.size, 0);
  assert.equal(retention.clear(), false);
});
