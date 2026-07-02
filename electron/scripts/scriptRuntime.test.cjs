"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createScriptRuntime, wrapScriptSource, interruptibleSleep } = require("./scriptRuntime.cjs");
const { SessionOutputBuffer } = require("./sessionOutputBuffer.cjs");

test("wrapScriptSource wraps async main scripts in async IIFE", () => {
  const wrapped = wrapScriptSource(`
// generated
async function main() {
  await nct.log('hi');
}

await main();
`);
  assert.match(wrapped, /^\(async \(\) => \{/);
  assert.match(wrapped, /await main\(\);\n\}\)\(\);$/);
});

test("wrapScriptSource wraps bare statements in async IIFE", () => {
  const wrapped = wrapScriptSource("await nct.log('hi');");
  assert.match(wrapped, /async \(\) =>/);
});

test("interruptibleSleep rejects when aborted", async () => {
  let aborted = false;
  const pending = interruptibleSleep(5000, () => aborted);
  setTimeout(() => {
    aborted = true;
  }, 50);
  await assert.rejects(pending, /Script stopped/);
});

test("createScriptRuntime executes async main script", async () => {
  const logs = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  await runtime.execute(`
async function main() {
  nct.log('from-main');
}

await main();
`);
  assert.deepEqual(logs, ["from-main"]);
});

test("createScriptRuntime executes simple log script", async () => {
  const logs = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  await runtime.execute("nct.log('hello');");
  assert.deepEqual(logs, ["hello"]);
});

test("createScriptRuntime supports regex waits over multiline output", async () => {
  const logs = [];
  const buffer = new SessionOutputBuffer("s1");
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: () => {},
    getOutputBuffer: () => buffer,
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  const run = runtime.execute(`
    await nct.screen.waitForRegex(".*SSH资源.*登录方式.*", 1000);
    nct.log("matched");
  `);
  buffer.append("1. SSH资源\n请选择SSH资源\n'zxadmin'登录方式:");

  await run;
  assert.deepEqual(logs, ["matched"]);
});

test("createScriptRuntime reports activity labels for loops without X/Y totals", async () => {
  const statuses = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: (_id, patch) => statuses.push(patch),
  });

  await runtime.execute("for (let i = 0; i < 3; i += 1) { nct.log(`step ${i}`); }");

  const last = statuses.at(-1);
  assert.equal(last.stepIndex, 3);
  assert.equal(last.activityLabel, "log");
  assert.equal(last.progressMode, "activity");
  assert.equal(last.totalSteps, undefined);
  assert.equal(last.currentStep, "log");
});

test("createScriptRuntime supports explicit determinate progress API", async () => {
  const statuses = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: (_id, patch) => statuses.push(patch),
  });

  await runtime.execute(`
    nct.progress.start('Sampling', 3);
    for (let i = 0; i < 3; i += 1) {
      nct.progress.step('item ' + i);
    }
    nct.progress.done();
    nct.log('finished');
  `);

  const during = statuses.find((patch) => patch.progressMode === "determinate" && patch.progressCurrent === 2);
  assert.ok(during);
  assert.equal(during.progressLabel, "Sampling");
  assert.equal(during.progressTotal, 3);
  assert.equal(during.activityLabel, "item 1");

  const afterDone = statuses.filter((patch) => patch.progressMode === "activity").at(-1);
  assert.ok(afterDone);
  assert.equal(afterDone.progressCurrent, undefined);
  assert.equal(afterDone.progressTotal, undefined);
});
