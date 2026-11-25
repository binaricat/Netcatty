import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { LocalShellHostDetailsPanel } from "./LocalShellHostDetailsPanel.tsx";
import type { Host } from "../types.ts";

const panelSource = readFileSync(
  new URL("./LocalShellHostDetailsPanel.tsx", import.meta.url),
  "utf8",
);

const existingLocalHost = {
  id: "local-existing",
  label: "Project A CMD",
  hostname: "localhost",
  username: "",
  tags: ["local"],
  group: "Projects/A",
  protocol: "local",
  os: "linux",
  createdAt: 0,
  localShell: "powershell",
  localShellName: "Windows PowerShell",
  localShellIcon: "powershell",
  localStartDir: "/workspace/project-a",
  startupCommand: "npm run dev",
} as unknown as Host;

const noop = () => {};

test("renderToStaticMarkup: create mode shows title, default-shell option, startup command field and Save & Connect", () => {
  const markup = renderToStaticMarkup(
    <LocalShellHostDetailsPanel
      defaultGroup="Projects/A"
      groups={["Projects/A", "Infra"]}
      onSave={noop}
      onSaveAndConnect={noop}
      onCancel={noop}
      layout="inline"
    />,
  );

  assert.match(markup, /localShell\.panel\.title/);
  assert.match(markup, /localShell\.field\.shellDefault/);
  assert.match(markup, /localShell\.saveAndConnect/);
  assert.match(markup, /localShell\.saveAndConnect|common\.save/);
  assert.match(markup, /hostDetails\.startupCommand/);
  assert.match(markup, /localShell\.field\.startupCommandPlaceholder/);
  assert.match(markup, /localShell\.field\.startupCommandDesc/);
  const startDirIdx = markup.indexOf("local-shell-start-dir");
  const startupCmdIdx = markup.indexOf("local-shell-startup-command");
  assert.ok(startDirIdx >= 0 && startupCmdIdx > startDirIdx, "startup command field must render below start directory");
});

test("renderToStaticMarkup: edit mode hides Save & Connect and shows existing shell and startup command", () => {
  const markup = renderToStaticMarkup(
    <LocalShellHostDetailsPanel
      initialData={existingLocalHost}
      groups={["Projects/A"]}
      onSave={noop}
      onCancel={noop}
      layout="inline"
    />,
  );

  assert.match(markup, /localShell\.panel\.title\.edit/);
  assert.doesNotMatch(markup, /localShell\.saveAndConnect/);
  // Existing label, start directory, and startup command are carried into the form
  assert.match(markup, /Project A CMD/);
  assert.match(markup, /local-shell-start-dir/);
  assert.match(markup, /local-shell-startup-command/);
  assert.match(markup, /npm run dev/);
});

test("buildHost forwards startupCommand to createLocalShellHost", () => {
  assert.match(panelSource, /startDir,\s*\n\s*startupCommand,/);
});

test("buildHost preserves the saved OS on edits and detects it only for new entries", () => {
  // Editing must retain initialData.os: entries imported/synced on one
  // platform must not be re-classified as the editor machine's OS on save.
  assert.match(
    panelSource,
    /os:\s*initialData\?\.os \?\? detectLocalOs\(navigator\.userAgent \|\| navigator\.platform\)/,
  );
});

test("unchanged shell selection keeps stored metadata over discovery", () => {
  // A host with custom localShellArgs for a shell id that discovery also
  // matches must keep its stored args/name/icon when an unrelated edit
  // (label, tag, group) is saved; discovered metadata applies only after
  // the user changes the shell selection.
  const unchanged = panelSource.match(
    /const shellMeta =\s*\n[\s\S]*?shell === initialData\?\.localShell\s*\n\s*\?\s*\{[\s\S]*?\}\s*\n\s*: matchedShell;/,
  );
  assert.ok(unchanged, "shellMeta must branch on an unchanged shell selection");
  // Inside the unchanged branch, stored metadata wins per field and
  // matchedShell is only a fallback (never the primary source).
  assert.match(
    unchanged[0],
    /args:\s*initialData\?\.localShellArgs \?\? matchedShell\?\.args/,
  );
  assert.match(
    unchanged[0],
    /name:\s*initialData\?\.localShellName \?\? matchedShell\?\.name/,
  );
  assert.match(
    unchanged[0],
    /icon:\s*initialData\?\.localShellIcon \?\? matchedShell\?\.icon/,
  );
  assert.doesNotMatch(unchanged[0], /matchedShell \?\?/);
});
