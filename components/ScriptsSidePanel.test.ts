import test from "node:test";
import assert from "node:assert/strict";

import { buildScriptsSidePanelRows } from "./ScriptsSidePanel.tsx";
import type { Snippet } from "../types";

const snippet = (overrides: Partial<Snippet>): Snippet => ({
  id: overrides.id ?? "snippet",
  label: overrides.label ?? "Snippet",
  command: overrides.command ?? "echo ok",
  package: overrides.package ?? "",
  order: overrides.order,
});

test("scripts side panel rows keep manual snippet order inside a package", () => {
  const rows = buildScriptsSidePanelRows({
    snippets: [
      snippet({ id: "alpha", label: "Alpha", package: "ops", order: 3000 }),
      snippet({ id: "zulu", label: "Zulu", package: "ops", order: 1000 }),
      snippet({ id: "beta", label: "Beta", package: "ops", order: 2000 }),
    ],
    packages: ["ops"],
    expandedPaths: new Set(["ops"]),
  });

  assert.deepEqual(
    rows.filter((row) => row.type === "snippet").map((row) => row.id),
    ["zulu", "beta", "alpha"],
  );
});
