const test = require("node:test");
const assert = require("node:assert/strict");
const { patchContextRelease, anchors } = require("./patch-xterm-webgl-context.cjs");

for (const [format, anchor] of Object.entries(anchors)) {
  test(`${format}: teardown releases its context after removing the atlas owner`, () => {
    const calls = [];
    const context = {
      _terminal: {},
      _canvas: { parentElement: { removeChild: () => calls.push("detach") } },
      _gl: { getExtension: (name) => {
        assert.equal(name, "WEBGL_lose_context");
        return { loseContext: () => calls.push("release") };
      } },
    };
    const source = `function dispose(){${anchor}}`;
    const patched = patchContextRelease(source, anchor);
    const dispose = new Function("r", "be", `${patched}; return dispose;`)(
      { removeTerminalFromCache: () => calls.push("atlas") },
      () => calls.push("atlas"),
    );
    dispose.call(context);
    assert.deepEqual(calls, ["detach", "atlas", "release"]);
    assert.equal(patchContextRelease(patched, anchor), patched);
    context._gl.getExtension = () => null;
    assert.doesNotThrow(() => dispose.call(context));
  });
}

test("unknown or ambiguous teardown fails closed", () => {
  for (const anchor of Object.values(anchors)) {
    assert.throws(() => patchContextRelease("unrecognized build", anchor), /Unknown/);
    assert.throws(() => patchContextRelease(anchor + anchor, anchor), /Unknown/);
  }
});
