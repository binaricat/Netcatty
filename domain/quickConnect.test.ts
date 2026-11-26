import test from "node:test";
import assert from "node:assert/strict";
import {
  isQuickConnectInput,
  isSwitcherQuickConnectInput,
  parseQuickConnectInput,
} from "./quickConnect";

test("quick connect keeps plain user@host targets unchanged", () => {
  assert.deepEqual(parseQuickConnectInput("root@10.2.0.8"), {
    hostname: "10.2.0.8",
    username: "root",
    port: undefined,
  });
  assert.deepEqual(parseQuickConnectInput("10.2.0.8:2200"), {
    hostname: "10.2.0.8",
    username: undefined,
    port: 2200,
  });
});

test("quick connect keeps the asset selector in the JumpServer username", () => {
  assert.deepEqual(parseQuickConnectInput("root@10.2.0.8@jump.corp.example"), {
    hostname: "jump.corp.example",
    username: "root@10.2.0.8",
    port: undefined,
    isJumpServerLogin: true,
  });
  assert.equal(isQuickConnectInput("root@10.2.0.8@jump.corp.example"), true);
});

test("quick connect parses the four-part JumpServer login from issue 3523", () => {
  assert.deepEqual(
    parseQuickConnectInput("chenyi@root@10.2.0.8@devjumpserver.example.cn"),
    {
      hostname: "devjumpserver.example.cn",
      username: "chenyi@root@10.2.0.8",
      port: undefined,
      isJumpServerLogin: true,
    },
  );
});

test("quick connect applies a suffix port to the JumpServer endpoint", () => {
  assert.deepEqual(parseQuickConnectInput("chenyi@root@10.2.0.8@jump:2222"), {
    hostname: "jump",
    username: "chenyi@root@10.2.0.8",
    port: 2222,
    isJumpServerLogin: true,
  });
});

test("ssh command ports apply to the JumpServer endpoint", () => {
  assert.deepEqual(parseQuickConnectInput("ssh -p 2222 chenyi@root@10.2.0.8@jump.corp.example"), {
    hostname: "jump.corp.example",
    username: "chenyi@root@10.2.0.8",
    port: 2222,
    isJumpServerLogin: true,
  });
  assert.deepEqual(parseQuickConnectInput("ssh -o Port=2200 chenyi@root@10.2.0.8@jump"), {
    hostname: "jump",
    username: "chenyi@root@10.2.0.8",
    port: 2200,
    isJumpServerLogin: true,
  });
});

test("ssh HostName override keeps the JumpServer login name", () => {
  assert.deepEqual(
    parseQuickConnectInput("ssh -o HostName=actual-jump.example -p 2222 chenyi@root@10.2.0.8@jump"),
    {
      hostname: "actual-jump.example",
      username: "chenyi@root@10.2.0.8",
      port: 2222,
      isJumpServerLogin: true,
    },
  );
  assert.deepEqual(
    parseQuickConnectInput("ssh -o HostName=actual-jump.example chenyi@root@10.2.0.8@alias_name"),
    {
      hostname: "actual-jump.example",
      username: "chenyi@root@10.2.0.8",
      port: undefined,
      isJumpServerLogin: true,
    },
  );
});

test("ordinary SSH options still resolve single-@ targets", () => {
  assert.deepEqual(parseQuickConnectInput("ssh -p 2200 deploy@host.example"), {
    hostname: "host.example",
    username: "deploy",
    port: 2200,
  });
  assert.deepEqual(parseQuickConnectInput("ssh -o HostName=actual.example -l deploy alias"), {
    hostname: "actual.example",
    username: "deploy",
    port: undefined,
  });
  assert.deepEqual(parseQuickConnectInput("ssh -o HostName=actual.example deploy@alias_name"), {
    hostname: "actual.example",
    username: "deploy",
    port: undefined,
  });
  assert.deepEqual(parseQuickConnectInput("ssh -l user@realm host.example"), {
    hostname: "host.example",
    username: "user@realm",
    port: undefined,
  });
  assert.deepEqual(parseQuickConnectInput("ssh -o User=user@realm host.example"), {
    hostname: "host.example",
    username: "user@realm",
    port: undefined,
  });
});

test("quick connect rejects malformed multi-@ inputs", () => {
  assert.equal(parseQuickConnectInput("a@b@c@d@e"), null);
  assert.equal(parseQuickConnectInput("bad user@10.2.0.8@jump"), null);
  assert.equal(parseQuickConnectInput("root@10.2.0.8@"), null);
  assert.equal(parseQuickConnectInput("root@bad host@jump"), null);
});

test("switcher quick connect accepts only address-like input", () => {
  for (const label of ["lab", "web01", "prod", "lab-switch", "localhost"]) {
    assert.equal(isQuickConnectInput(label), true);
    assert.equal(isSwitcherQuickConnectInput(label), false);
  }

  for (const address of [
    "10.1.1.1",
    "root@10.2.0.8:2222",
    "example.com",
    "host:2222",
    "user@lab",
    "[::1]",
    "fe80::1",
    "[2001:db8::1]:2222",
  ]) {
    assert.equal(isSwitcherQuickConnectInput(address), true, address);
  }

  assert.equal(isSwitcherQuickConnectInput("core switch"), false);
  assert.equal(isSwitcherQuickConnectInput("host:99999"), false);
});

test("quick connect parses rdp:// and vnc:// URIs with domain, display port, IPv6, and JumpServer pipe user", () => {
  assert.deepEqual(parseQuickConnectInput("rdp://CORP\\Administrator@10.0.0.5:3390"), {
    protocol: "rdp",
    hostname: "10.0.0.5",
    username: "Administrator",
    domain: "CORP",
    port: 3390,
  });
  assert.deepEqual(parseQuickConnectInput("rdp://alice|uuid-123@razor.example.com:33890"), {
    protocol: "rdp",
    hostname: "razor.example.com",
    username: "alice|uuid-123",
    port: 33890,
  });
  assert.deepEqual(parseQuickConnectInput("vnc://10.0.0.9:1"), {
    protocol: "vnc",
    hostname: "10.0.0.9",
    username: undefined,
    port: 5901,
  });
  assert.deepEqual(parseQuickConnectInput("vnc://alice@[2001:db8::1]:5902"), {
    protocol: "vnc",
    hostname: "2001:db8::1",
    username: "alice",
    port: 5902,
  });
  assert.equal(isSwitcherQuickConnectInput("rdp://win-box"), true);
  assert.equal(isSwitcherQuickConnectInput("vnc://mac-mini"), true);
});
