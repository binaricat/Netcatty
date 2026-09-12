"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { PATCHES, patchXtermSource } = require("./patch-xterm-foreground-intense.cjs");

for (const patch of PATCHES) {
  test(`${patch.file}: ${patch.original.slice(0, 24)} patches once and rejects drift`, () => {
    const first = patchXtermSource(`before;${patch.original}after`, patch);
    assert.equal(first.changed, true);
    assert.equal(first.source, `before;${patch.replacement}after`);
    assert.deepEqual(patchXtermSource(first.source, patch), { source: first.source, changed: false });
    assert.throws(() => patchXtermSource("upstream changed", patch));
    assert.throws(() => patchXtermSource(patch.original.repeat(2), patch));
    assert.throws(() => patchXtermSource(patch.replacement.repeat(2), patch));
    assert.throws(() => patchXtermSource(patch.replacement + patch.original, patch));
  });
}

for (const patch of PATCHES.filter(p => p.file.startsWith("addon-webgl"))) {
  test(`${patch.file}: renderer color resolution preserves cell flags and buffer`, () => {
    const expression = patch.replacement.slice("this.result.fg=".length, -",this.result.ext=".length);
    const resolve = (fg, intense) => {
      const cell = { fg, isBold: () => fg & 0x08000000, getFgColorMode: () => fg & 0x03000000 };
      const context = { t: cell, e: cell, _themeService: { colors: { foregroundIntense: intense } } };
      const result = vm.runInNewContext(expression, context);
      assert.equal(cell.fg, fg, "must not alter the stored cell");
      return result;
    };
    const color = { rgba: 0xff6000ff };
    assert.equal(resolve(0, color), 0);
    assert.equal(resolve(0x08000000, undefined), 0x08000000);
    assert.equal(resolve(0x08000000, color), 0x0bff6000);
    assert.equal(resolve(0x0c000000, color), 0x0fff6000, "inverse flag remains set");
    assert.equal(resolve(0x09000002, color), 0x09000002, "ANSI color preserved");
    assert.equal(resolve(0x0b123456, color), 0x0b123456, "truecolor preserved");
  });
}
