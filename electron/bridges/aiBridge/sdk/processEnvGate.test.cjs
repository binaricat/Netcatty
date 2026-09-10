const test = require("node:test");
const assert = require("node:assert/strict");
const { withExclusiveProcessEnv } = require("./processEnvGate.cjs");

const TENANT_KEY = "NETCATTY_CLI_CHAT_SESSION_ID";

test("withExclusiveProcessEnv isolates overlapping tenant mutations", async () => {
  const original = process.env[TENANT_KEY];
  delete process.env[TENANT_KEY];
  const seen = [];
  let releaseA;
  const holdA = new Promise((resolve) => { releaseA = resolve; });

  try {
    const turnA = withExclusiveProcessEnv({ [TENANT_KEY]: "chat-a" }, async () => {
      seen.push(["a-start", process.env[TENANT_KEY]]);
      await holdA;
      seen.push(["a-end", process.env[TENANT_KEY]]);
    });

    while (seen.length === 0) await new Promise((resolve) => setImmediate(resolve));

    const turnB = withExclusiveProcessEnv({ [TENANT_KEY]: "chat-b" }, async () => {
      seen.push(["b", process.env[TENANT_KEY]]);
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.env[TENANT_KEY], "chat-a");
    assert.equal(seen.some((row) => row[0] === "b"), false);

    releaseA();
    await Promise.all([turnA, turnB]);

    assert.deepEqual(seen, [
      ["a-start", "chat-a"],
      ["a-end", "chat-a"],
      ["b", "chat-b"],
    ]);
    assert.equal(process.env[TENANT_KEY], undefined);
  } finally {
    if (original === undefined) delete process.env[TENANT_KEY];
    else process.env[TENANT_KEY] = original;
  }
});
