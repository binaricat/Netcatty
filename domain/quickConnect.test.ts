import test from "node:test";
import assert from "node:assert/strict";
import {
  isQuickConnectInput,
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
    },
  );
});

test("quick connect applies a suffix port to the JumpServer endpoint", () => {
  assert.deepEqual(parseQuickConnectInput("chenyi@root@10.2.0.8@jump:2222"), {
    hostname: "jump",
    username: "chenyi@root@10.2.0.8",
    port: 2222,
  });
});

test("ssh command ports apply to the JumpServer endpoint", () => {
  assert.deepEqual(parseQuickConnectInput("ssh -p 2222 chenyi@root@10.2.0.8@jump.corp.example"), {
    hostname: "jump.corp.example",
    username: "chenyi@root@10.2.0.8",
    port: 2222,
  });
  assert.deepEqual(parseQuickConnectInput("ssh -o Port=2200 chenyi@root@10.2.0.8@jump"), {
    hostname: "jump",
    username: "chenyi@root@10.2.0.8",
    port: 2200,
  });
});

test("ssh HostName override keeps the JumpServer login name", () => {
  assert.deepEqual(
    parseQuickConnectInput("ssh -o HostName=actual-jump.example -p 2222 chenyi@root@10.2.0.8@jump"),
    {
      hostname: "actual-jump.example",
      username: "chenyi@root@10.2.0.8",
      port: 2222,
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
});

test("quick connect rejects malformed multi-@ inputs", () => {
  assert.equal(parseQuickConnectInput("a@b@c@d@e"), null);
  assert.equal(parseQuickConnectInput("bad user@10.2.0.8@jump"), null);
  assert.equal(parseQuickConnectInput("root@10.2.0.8@"), null);
  assert.equal(parseQuickConnectInput("root@bad host@jump"), null);
});
