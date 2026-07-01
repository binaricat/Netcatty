import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalEncodingStorageKey,
  resolveInitialTerminalEncoding,
  resolveTerminalEncodingFromCharset,
  shouldSyncTerminalEncodingOnAttach,
  terminalEncodingPreferenceToCharset,
} from "./terminalEncodingPreference";

test("resolves GB18030-compatible charset labels", () => {
  assert.equal(resolveTerminalEncodingFromCharset("GB18030"), "gb18030");
  assert.equal(resolveTerminalEncodingFromCharset("GBK"), "gb18030");
  assert.equal(resolveTerminalEncodingFromCharset("zh_CN.GB18030"), "gb18030");
  assert.equal(resolveTerminalEncodingFromCharset("zh_CN.GBK@variant"), "gb18030");
});

test("resolves UTF-8 charset labels", () => {
  assert.equal(resolveTerminalEncodingFromCharset("UTF-8"), "utf-8");
  assert.equal(resolveTerminalEncodingFromCharset("en_US.UTF-8"), "utf-8");
});

test("per-host remembered terminal encoding wins for supported or empty host charsets", () => {
  assert.equal(resolveInitialTerminalEncoding("UTF-8", "gb18030"), "gb18030");
  assert.equal(resolveInitialTerminalEncoding(undefined, "gb18030"), "gb18030");
});

test("missing per-host remembered encoding preserves configured GB18030 charset", () => {
  assert.equal(resolveInitialTerminalEncoding("GB18030", null), "gb18030");
});

test("per-host remembered UTF-8 can override a supported GB18030 host charset", () => {
  assert.equal(resolveInitialTerminalEncoding("GB18030", "utf-8"), "utf-8");
});

test("unsupported charsets ignore remembered encoding", () => {
  assert.equal(resolveInitialTerminalEncoding("latin1", "gb18030"), "utf-8");
});

test("maps terminal encoding preferences back to host charset labels", () => {
  assert.equal(terminalEncodingPreferenceToCharset("utf-8"), "UTF-8");
  assert.equal(terminalEncodingPreferenceToCharset("gb18030"), "GB18030");
});

test("syncs remembered serial encoding preferences on attach", () => {
  assert.equal(
    shouldSyncTerminalEncodingOnAttach({
      connection: "serial",
      userPickedEncoding: false,
      hasRememberedEncoding: true,
    }),
    true,
  );
  assert.equal(
    shouldSyncTerminalEncodingOnAttach({
      connection: "serial",
      userPickedEncoding: false,
      hasRememberedEncoding: false,
    }),
    false,
  );
});

test("syncs SSH encoding on attach and leaves unrelated sessions alone", () => {
  assert.equal(
    shouldSyncTerminalEncodingOnAttach({
      connection: "ssh",
      userPickedEncoding: false,
      hasRememberedEncoding: false,
    }),
    true,
  );
  assert.equal(
    shouldSyncTerminalEncodingOnAttach({
      connection: "other",
      userPickedEncoding: true,
      hasRememberedEncoding: true,
    }),
    false,
  );
});

test("creates isolated terminal encoding storage keys per host", () => {
  const prefix = "netcatty_terminal_encoding_by_host_v1:";
  const first = createTerminalEncodingStorageKey(prefix, {
    id: "host-a",
    protocol: "ssh",
    hostname: "10.0.0.1",
    username: "root",
    port: 22,
  });
  const second = createTerminalEncodingStorageKey(prefix, {
    id: "host-b",
    protocol: "ssh",
    hostname: "10.0.0.2",
    username: "root",
    port: 22,
  });

  assert.notEqual(first, second);
  assert.equal(first, `${prefix}host-a`);
  assert.equal(second, `${prefix}host-b`);
});

test("falls back to a connection fingerprint when a host id is unavailable", () => {
  const prefix = "netcatty_terminal_encoding_by_host_v1:";
  assert.equal(
    createTerminalEncodingStorageKey(prefix, {
      protocol: "ssh",
      hostname: "example.com",
      username: "deploy",
      port: 2222,
    }),
    `${prefix}ssh%7Cdeploy%7Cexample.com%7C2222`,
  );
});
