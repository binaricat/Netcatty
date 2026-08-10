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

test("toggleTaskListItemAtIndex ignores checkboxes inside fenced code", () => {
  const src = [
    "- [ ] real",
    "```",
    "- [ ] fake",
    "```",
    "- [ ] second",
  ].join("\n");
  assert.equal(countTaskListItems(src), 2);
  const next = toggleTaskListItemAtIndex(src, 1);
  assert.match(next, /^- \[ \] real$/m);
  assert.match(next, /^- \[ \] fake$/m);
  assert.match(next, /^- \[x\] second$/m);
});

test("toggleTaskListItemAtIndex handles blockquote task lines", () => {
  const src = "> - [ ] quoted\n- [ ] plain";
  assert.equal(countTaskListItems(src), 2);
  assert.match(toggleTaskListItemAtIndex(src, 0), /^> - \[x\] quoted$/m);
});

test("toggleTaskListItemAtIndex recognizes parenthesized ordered markers", () => {
  const src = "1) [ ] first\n2. [ ] second";
  assert.equal(countTaskListItems(src), 2);
  assert.match(toggleTaskListItemAtIndex(src, 0), /^1\) \[x\] first$/m);
});

test("toggleTaskListItemAtIndex counts nested list tasks", () => {
  const src = "- parent\n    - [ ] child\n- [ ] later";
  assert.equal(countTaskListItems(src), 2);
  assert.match(toggleTaskListItemAtIndex(src, 0), / {4}- \[x\] child/);
  assert.match(toggleTaskListItemAtIndex(src, 1), /^- \[x\] later$/m);
});

test("toggleTaskListItemAtIndex ignores tasks without space after bracket", () => {
  const src = "- [ ]foo\n- [ ] real";
  assert.equal(countTaskListItems(src), 1);
  assert.match(toggleTaskListItemAtIndex(src, 0), /^- \[x\] real$/m);
  assert.match(toggleTaskListItemAtIndex(src, 0), /^- \[ \]foo$/m);
});

test("toggleTaskListItemAtIndex ignores tasks inside HTML comments", () => {
  const src = "<!--\n- [ ] hidden\n-->\n- [ ] visible";
  assert.equal(countTaskListItems(src), 1);
  const next = toggleTaskListItemAtIndex(src, 0);
  assert.match(next, /<!--\n- \[ \] hidden\n-->/);
  assert.match(next, /^- \[x\] visible$/m);
});

test("isPointerOnTaskCheckbox only accepts the left hit box", () => {
  const rect = { left: 100, right: 400 };
  assert.equal(isPointerOnTaskCheckbox(rect, 100), true);
  assert.equal(isPointerOnTaskCheckbox(rect, 120), true);
  assert.equal(isPointerOnTaskCheckbox(rect, 128), true);
  assert.equal(isPointerOnTaskCheckbox(rect, 129), false);
  assert.equal(isPointerOnTaskCheckbox(rect, 99), false);
});
