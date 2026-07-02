"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { countScriptSteps } = require("./scriptStepCounter.cjs");

test("countScriptSteps counts common nct calls", () => {
  const source = `
await nct.screen.waitFor('$ ', 5000);
await nct.screen.waitForText('ready', 5000);
await nct.screen.waitForRegex('READY.*', 5000);
await nct.screen.sendLine('ls');
nct.log('done');
`;
  assert.equal(countScriptSteps(source), 5);
});
