const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { validatePluginStylesheet } = require("../../domain/pluginViewStylePolicy.cjs");
test("official view examples inherit host tokens and all authored styles pass the host policy", () => {
  for (const name of ['starter-netcatty', 'vault-scratchpad', 'session-scratchpad', 'hello-vault', 'hello-world-v2', 'settings-view-fixture', 'assistant', 'global-agent', 'database-minimal', 'database-rfam-readonly']) {
    const root = path.join(__dirname, '../../examples/plugins', name);
    const css = fs.readFileSync(path.join(root, 'view.css'), 'utf8');
    assert.ok(validatePluginStylesheet(css), name);
    assert.match(css, /var\(--foreground\)/);
    assert.doesNotMatch(css, /--background\s*:/);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'netcatty.plugin.json'), 'utf8'));
    for (const view of manifest.contributes.views) { assert.equal(view.entry, undefined); assert.equal(view.rendering, undefined); }
  }
});
