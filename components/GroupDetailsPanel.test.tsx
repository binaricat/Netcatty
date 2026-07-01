import test from "node:test";
import assert from "node:assert/strict";

import { hasGroupTelnetFields } from "./GroupDetailsPanel.tsx";

test("GroupDetailsPanel treats cleared telnet credentials as explicit settings", () => {
  assert.equal(hasGroupTelnetFields({ telnetUsername: "" }), true);
  assert.equal(hasGroupTelnetFields({ telnetPassword: "" }), true);
  assert.equal(hasGroupTelnetFields({}), false);
});
