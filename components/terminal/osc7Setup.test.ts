import test from "node:test";
import assert from "node:assert/strict";

import { OSC7_MARKER, buildOsc7SetupCommand } from "./osc7Setup";

test("buildOsc7SetupCommand includes an idempotent marker and supported shell targets", () => {
  const command = buildOsc7SetupCommand();

  assert.match(command, new RegExp(OSC7_MARKER));
  assert.match(command, /bash\)/);
  assert.match(command, /\.bashrc/);
  assert.match(command, /zsh\)/);
  assert.match(command, /\.zshrc/);
  assert.match(command, /fish\)/);
  assert.match(command, /config\.fish/);
  assert.match(command, /grep -F/);
});

test("buildOsc7SetupCommand detects the current interactive shell and refreshes immediately", () => {
  const command = buildOsc7SetupCommand();

  assert.match(command, /ps -p "\$PPID" -o comm=/);
  assert.match(command, /\$\{SHELL:-sh\}/);
  assert.match(command, /osc7_cwd/);
  assert.match(command, /host=\$\(hostname 2>\/dev\/null \|\| printf localhost\)/);
  assert.match(command, /printf "\\033\]7;file:\/\/%s%s\\033\\\\/);
  assert.match(command, /Netcatty OSC 7 cwd tracking configured/);
  assert.equal(command.endsWith("\n"), true);
});
