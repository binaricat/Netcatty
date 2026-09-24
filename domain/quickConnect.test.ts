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
  assert.equal("jumps" in (parseQuickConnectInput("root@10.2.0.8") ?? {}), false);
});

test("quick connect parses user@target@jump as a jump chain", () => {
  assert.deepEqual(parseQuickConnectInput("root@10.2.0.8@jump.corp.example"), {
    hostname: "10.2.0.8",
    username: "root",
    port: undefined,
    jumps: [{ hostname: "jump.corp.example", username: undefined, port: undefined }],
  });
  assert.equal(isQuickConnectInput("root@10.2.0.8@jump.corp.example"), true);
});

test("quick connect parses jumpUser@targetUser@target@jump", () => {
  assert.deepEqual(
    parseQuickConnectInput("chenyi@root@10.2.0.8@devjumpserver.example.cn"),
    {
      hostname: "10.2.0.8",
      username: "root",
      port: undefined,
      jumps: [{ hostname: "devjumpserver.example.cn", username: "chenyi", port: undefined }],
    },
  );
});

test("quick connect accepts per-hop ports in a jump chain", () => {
  assert.deepEqual(parseQuickConnectInput("root@10.2.0.8:2222@jump:2200"), {
    hostname: "10.2.0.8",
    username: "root",
    port: 2222,
    jumps: [{ hostname: "jump", username: undefined, port: 2200 }],
  });
});

test("quick connect parses jump chains inside ssh commands", () => {
  assert.deepEqual(parseQuickConnectInput("ssh -p 22 root@10.2.0.8@jump.corp.example"), {
    hostname: "10.2.0.8",
    username: "root",
    port: 22,
    jumps: [{ hostname: "jump.corp.example", username: undefined, port: undefined }],
  });
});

test("quick connect rejects malformed jump chains", () => {
  assert.equal(parseQuickConnectInput("a@b@c@d@e"), null);
  assert.equal(parseQuickConnectInput("bad user@10.2.0.8@jump"), null);
  assert.equal(parseQuickConnectInput("root@10.2.0.8@"), null);
  assert.equal(parseQuickConnectInput("root@bad host@jump"), null);
});
