import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocalShellHostDetailsPanel } from "./LocalShellHostDetailsPanel.tsx";
import type { Host } from "../types.ts";

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
} as unknown as Host;

const noop = () => {};

test("renderToStaticMarkup: create mode shows title, default-shell option and Save & Connect", () => {
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
});

test("renderToStaticMarkup: edit mode hides Save & Connect and shows existing shell", () => {
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
  // Existing label and local tag are carried into the form
  assert.match(markup, /Project A CMD/);
  assert.match(markup, />local</);
});
