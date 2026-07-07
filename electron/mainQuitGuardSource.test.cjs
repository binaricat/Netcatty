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

test("before-quit dirty editor guard foregrounds dirty windows through the focus recovery helper", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const beforeQuitIndex = source.indexOf('app.on("before-quit"');
  const dirtyResultsIndex = source.indexOf(".then((dirtyResults) => {", beforeQuitIndex);
  const loopIndex = source.indexOf("for (const win of dirtyWindows)", dirtyResultsIndex);
  const hasDirtyCommentIndex = source.indexOf("// hasDirty:", loopIndex);
  const foregroundBlock = source.slice(loopIndex, hasDirtyCommentIndex);

  assert.notEqual(beforeQuitIndex, -1);
  assert.notEqual(dirtyResultsIndex, -1);
  assert.notEqual(loopIndex, -1);
  assert.notEqual(hasDirtyCommentIndex, -1);
  assert.match(foregroundBlock, /wm\.showAndFocusMainWindow\?\.\(win\)/);
  assert.match(foregroundBlock, /try\s*\{[\s\S]*wm\.showAndFocusMainWindow\?\.\(win\);[\s\S]*\}\s*catch\s*\{/);
  assert.doesNotMatch(foregroundBlock, /commitQuit\(\)/);
  assert.doesNotMatch(foregroundBlock, /win\.show\(\)/);
  assert.doesNotMatch(foregroundBlock, /win\.focus\(\)/);
});
