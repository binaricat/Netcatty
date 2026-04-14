import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_HISTORY_ROW_CLASSNAMES,
} from "./sessionHistoryLayout.ts";

test("session history row keeps metadata pinned to the end while title truncates", () => {
  assert.match(SESSION_HISTORY_ROW_CLASSNAMES.row, /\bgrid\b/);
  assert.ok(SESSION_HISTORY_ROW_CLASSNAMES.row.includes('grid-cols-[minmax(0,1fr)_auto]'));
  assert.match(SESSION_HISTORY_ROW_CLASSNAMES.title, /\btruncate\b/);
  assert.match(SESSION_HISTORY_ROW_CLASSNAMES.title, /\bmin-w-0\b/);
  assert.match(SESSION_HISTORY_ROW_CLASSNAMES.meta, /\bjustify-self-end\b/);
  assert.match(SESSION_HISTORY_ROW_CLASSNAMES.meta, /\bshrink-0\b/);
});
