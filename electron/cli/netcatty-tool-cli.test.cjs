"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("./netcatty-tool-cli.cjs");

test("parseArgs consumes snippet multi-line run mode flag", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "snippets",
    "update",
    "--snippet-id",
    "snippet-1",
    "--multi-line-run-mode",
    "lineDelay",
    "--json",
  ]);

  assert.deepEqual(positionals, ["snippets", "update"]);
  assert.equal(opts.snippetId, "snippet-1");
  assert.equal(opts.multiLineRunMode, "lineDelay");
  assert.equal(opts.json, true);
});
