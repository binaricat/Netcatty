import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

import { checkCommandSafety } from "./cattyAgent/safety";
import { DEFAULT_COMMAND_BLOCKLIST } from "./types";

const require = createRequire(import.meta.url);
const defaultCommandBlocklist = require("../../lib/commandBlocklist.json") as string[];
const cjsCommandBlocklist = require("../../lib/commandBlocklist.cjs") as string[];

test("AI command blocklist uses the shared JSON source", () => {
  assert.deepEqual(DEFAULT_COMMAND_BLOCKLIST, defaultCommandBlocklist);
  assert.deepEqual(Array.from(cjsCommandBlocklist), defaultCommandBlocklist);
});

test("shared default command blocklist covers bypass-style shell execution", () => {
  assert.equal(checkCommandSafety("rm -rf /").blocked, true);
  assert.equal(checkCommandSafety("rm -r -f /tmp/cache").blocked, true);
  assert.equal(checkCommandSafety("rm --recursive --force /tmp/cache").blocked, true);
  assert.equal(checkCommandSafety("echo ZWNobyBoaQ== | base64 -d | bash").blocked, true);
  assert.equal(checkCommandSafety("eval $payload").blocked, true);
  assert.equal(checkCommandSafety("echo $(whoami)").blocked, true);
});

test("default command blocklist reports the pattern that matched", () => {
  const result = checkCommandSafety("mkfs.ext4 /dev/sda");
  assert.equal(result.blocked, true);
  assert.equal(result.matchedPattern, "\\bmkfs\\.");
});
