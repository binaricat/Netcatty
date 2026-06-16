import test from "node:test";
import assert from "node:assert/strict";

import { shouldPreserveTerminalFocusOnMouseDown } from "./toolbarFocus.ts";

test("preserves terminal focus for non-editable overlay clicks", () => {
  const buttonLikeTarget = {
    tagName: "button",
    isContentEditable: false,
    closest() {
      return null;
    },
    getAttribute() {
      return null;
    },
  };

  assert.equal(shouldPreserveTerminalFocusOnMouseDown(buttonLikeTarget as unknown as EventTarget), true);
});

test("allows native focus for direct editable targets", () => {
  const inputTarget = {
    tagName: "input",
    isContentEditable: false,
    closest() {
      return null;
    },
    getAttribute() {
      return null;
    },
  };

  assert.equal(shouldPreserveTerminalFocusOnMouseDown(inputTarget as unknown as EventTarget), false);
});

test("allows native focus for descendants inside editable controls", () => {
  const nestedTarget = {
    tagName: "span",
    isContentEditable: false,
    closest(selector: string) {
      return selector.includes("input") ? { tagName: "INPUT" } : null;
    },
    getAttribute() {
      return null;
    },
  };

  assert.equal(shouldPreserveTerminalFocusOnMouseDown(nestedTarget as unknown as EventTarget), false);
});

test("allows native focus for contenteditable regions", () => {
  const editableTarget = {
    tagName: "div",
    isContentEditable: false,
    closest() {
      return null;
    },
    getAttribute(name: string) {
      return name === "contenteditable" ? "true" : null;
    },
  };

  assert.equal(shouldPreserveTerminalFocusOnMouseDown(editableTarget as unknown as EventTarget), false);
});

test("allows native drag start from the terminal detach drag handle", () => {
  const dragHandleTarget = {
    tagName: "span",
    isContentEditable: false,
    closest(selector: string) {
      return selector.includes("data-terminal-detach-drag-handle") ? { tagName: "DIV" } : null;
    },
    getAttribute() {
      return null;
    },
  };

  assert.equal(shouldPreserveTerminalFocusOnMouseDown(dragHandleTarget as unknown as EventTarget), false);
});
