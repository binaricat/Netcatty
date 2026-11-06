const assert = require('node:assert/strict');
const test = require('node:test');
const schema = require('../packages/plugin-contract/schema/plugin-contract.schema.json');
const { PERMISSION_DESCRIPTIONS, describePluginPermission } = require('./pluginPermissionDescriptions.cjs');
test('permission explanation coverage cannot drift from the canonical permission catalog', () => {
  assert.deepEqual(Object.keys(PERMISSION_DESCRIPTIONS).sort(), [...schema.$defs.PluginPermission.enum].sort());
  for (const id of schema.$defs.PluginPermission.enum) {
    for (const locale of ['en', 'zh-CN']) {
      const description = describePluginPermission(id, locale);
      assert.equal(description.known, true); assert.ok(description.description.length > 5);
    }
  }
  assert.equal(describePluginPermission('unknown.permission').sensitive, true);
  assert.equal(describePluginPermission('unknown.permission').known, false);
});
