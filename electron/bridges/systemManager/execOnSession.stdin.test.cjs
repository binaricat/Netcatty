"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createExecOnSessionApi } = require("./execOnSession.cjs");

test("execOnSession closes ssh exec stdin after writing provided input", async () => {
  const writes = [];
  let ended = false;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = (data) => {
    writes.push(data);
    return true;
  };
  stream.end = () => {
    ended = true;
  };

  const conn = {
    exec(_command, callback) {
      callback(null, stream);
      process.nextTick(() => stream.emit("close", 0));
    },
  };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const result = await execApi.execOnSession(null, "s1", "sudo -S -p '' docker ps", 1000, {
    stdin: "secret\n",
  });

  assert.equal(result.success, true);
  assert.deepEqual(writes, ["secret\n"]);
  assert.equal(ended, true);
});
