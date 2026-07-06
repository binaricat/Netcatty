const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectOpenTerminalPathArgs,
  expandHomePath,
  resolveOpenTerminalPath,
} = require("./openTerminalPath.cjs");

test("collectOpenTerminalPathArgs extracts explicit open terminal paths", () => {
  assert.deepEqual(
    collectOpenTerminalPathArgs([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--open-terminal-path",
      "/Users/alice/project",
      "--open-terminal-path=/tmp/demo",
      "--ignored",
    ]),
    ["/Users/alice/project", "/tmp/demo"],
  );
});

test("resolveOpenTerminalPath accepts directories", () => {
  const fsModule = {
    statSync: (target) => ({
      target,
      isDirectory: () => true,
      isFile: () => false,
    }),
  };

  assert.equal(
    resolveOpenTerminalPath("/tmp/project", { fsModule, logWarn: () => {} }),
    "/tmp/project",
  );
});

test("expandHomePath expands home-relative terminal paths", () => {
  assert.equal(
    expandHomePath("~/project", { osHomedir: () => "/Users/alice" }),
    "/Users/alice/project",
  );
  assert.equal(
    expandHomePath("~", { osHomedir: () => "/Users/alice" }),
    "/Users/alice",
  );
});

test("resolveOpenTerminalPath uses parent directory for files", () => {
  const fsModule = {
    statSync: () => ({
      isDirectory: () => false,
      isFile: () => true,
    }),
  };

  assert.equal(
    resolveOpenTerminalPath("/tmp/project/readme.md", { fsModule, logWarn: () => {} }),
    "/tmp/project",
  );
});

test("resolveOpenTerminalPath rejects missing paths", () => {
  const warnings = [];
  const fsModule = {
    statSync: () => {
      throw new Error("missing");
    },
  };

  assert.equal(
    resolveOpenTerminalPath("/tmp/missing", {
      fsModule,
      logWarn: (...args) => warnings.push(args),
    }),
    null,
  );
  assert.equal(warnings.length, 1);
});
