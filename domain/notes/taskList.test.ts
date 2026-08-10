import assert from "node:assert/strict";
import test from "node:test";

import {
  countTaskListItems,
  isPointerOnTaskCheckbox,
  toggleTaskListItemAtIndex,
} from "./taskList";

test("toggleTaskListItemAtIndex flips the Nth GFM checkbox", () => {
  const src = [
    "# List",
    "",
    "- [ ] one",
    "- [x] two",
    "* [ ] three",
    "1. [ ] four",
  ].join("\n");

  assert.equal(countTaskListItems(src), 4);
  assert.match(toggleTaskListItemAtIndex(src, 0), /^- \[x\] one$/m);
  assert.match(toggleTaskListItemAtIndex(src, 1), /^- \[ \] two$/m);
  assert.match(toggleTaskListItemAtIndex(src, 2), /^\* \[x\] three$/m);
  assert.match(toggleTaskListItemAtIndex(src, 3), /^1\. \[x\] four$/m);
  assert.equal(toggleTaskListItemAtIndex(src, 9), src);
  assert.equal(toggleTaskListItemAtIndex(src, -1), src);
});

test("toggleTaskListItemAtIndex preserves indentation and surrounding text", () => {
  const src = "  - [ ] nested code `apt`\n- [x] done";
  const next = toggleTaskListItemAtIndex(src, 0);
  assert.equal(next, "  - [x] nested code `apt`\n- [x] done");
});

test("isPointerOnTaskCheckbox only accepts the left hit box", () => {
  const rect = { left: 100, right: 400 };
  assert.equal(isPointerOnTaskCheckbox(rect, 100), true);
  assert.equal(isPointerOnTaskCheckbox(rect, 120), true);
  assert.equal(isPointerOnTaskCheckbox(rect, 128), true);
  assert.equal(isPointerOnTaskCheckbox(rect, 129), false);
  assert.equal(isPointerOnTaskCheckbox(rect, 99), false);
});
