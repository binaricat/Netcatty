const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

test("before-quit dirty editor guard queries hidden app content windows", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const beforeQuitIndex = source.indexOf('app.on("before-quit"');
  const queryableIndex = source.indexOf("const queryableWebContents", beforeQuitIndex);
  const queryCallIndex = source.indexOf("queryDirtyEditors", queryableIndex);
  const guardSetup = source.slice(beforeQuitIndex, queryCallIndex);

  assert.notEqual(beforeQuitIndex, -1);
  assert.notEqual(queryableIndex, -1);
  assert.match(guardSetup, /const queryableWindows = mainWindows\.filter/);
  assert.match(source.slice(queryableIndex, queryCallIndex), /queryableWindows\s*\n?\s*\.map\(\(candidate\) => candidate\.webContents\)/);
  assert.doesNotMatch(guardSetup, /isVisible|isMinimized/);
});
