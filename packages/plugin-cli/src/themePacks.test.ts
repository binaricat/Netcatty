import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateManifestValue } from "./manifest.js";
import { checkPluginCompatibility } from "./compatibility.js";
const manifest = JSON.parse(
  await readFile(
    new URL(
      "../../../examples/plugins/forest-theme-pack/netcatty.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
test("static theme admission requires explicit feature, namespaces, JSON entries and no executable or permission mixture", () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  assert.equal(
    checkPluginCompatibility(manifest, {
      netcattyVersion: "1.0.0",
      apiVersion: "0.1.0-internal.1",
      features: [],
    }).compatible,
    false,
  );
  for (const change of [
    { main: { data: "theme", browser: "index.js" } },
    { permissions: { required: ["network"] } },
    { activationEvents: ["onStartupFinished"] },
    {
      contributes: {
        ...manifest.contributes,
        commands: [{ id: manifest.id + ".run", title: "Run" }],
      },
    },
    { features: { required: [] } },
    {
      contributes: {
        themes: [
          { ...manifest.contributes.themes[0], id: "another.plugin.theme" },
        ],
      },
    },
    {
      contributes: {
        themes: [{ ...manifest.contributes.themes[0], entry: "theme.css" }],
      },
    },
  ])
    assert.equal(
      validateManifestValue({ ...manifest, ...change }).valid,
      false,
      JSON.stringify(change),
    );
});
