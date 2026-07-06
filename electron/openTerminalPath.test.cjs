const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectOpenTerminalPathArgs,
  expandHomePath,
  resolveOpenTerminalPath,
  resolveOpenTerminalPathsFromArgs,
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

test("resolveOpenTerminalPath resolves relative paths against the provided base directory", () => {
  const seen = [];
  const fsModule = {
    statSync: (target) => {
      seen.push(target);
      return {
        isDirectory: () => true,
        isFile: () => false,
      };
    },
  };

  assert.equal(
    resolveOpenTerminalPath("project", {
      baseDirectory: "/Users/alice",
      fsModule,
      logWarn: () => {},
    }),
    "/Users/alice/project",
  );
  assert.deepEqual(seen, ["/Users/alice/project"]);
});

test("resolveOpenTerminalPathsFromArgs resolves second-instance relative paths against its working directory", () => {
  const fsModule = {
    statSync: () => ({
      isDirectory: () => true,
      isFile: () => false,
    }),
  };

  assert.deepEqual(
    resolveOpenTerminalPathsFromArgs([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--open-terminal-path",
      ".",
    ], {
      baseDirectory: "/Users/alice/project",
      fsModule,
      logWarn: () => {},
    }),
    ["/Users/alice/project"],
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
