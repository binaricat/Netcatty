import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComboboxWheelScroll,
  comboboxWheelDeltaToPixels,
  filterComboboxOptions,
  focusComboboxInput,
  selectComboboxInputIfFocused,
  canComboboxOpen,
  getNextComboboxActiveIndex,
  type ComboboxScrollableTarget,
} from "./ui/combobox.tsx";

const source = readFileSync(new URL("./ui/combobox.tsx", import.meta.url), "utf8");

test("combobox wheel deltas normalize to pixels", () => {
  assert.equal(comboboxWheelDeltaToPixels(12, 0), 12);
  assert.equal(comboboxWheelDeltaToPixels(3, 1), 48);
  assert.equal(comboboxWheelDeltaToPixels(1, 2), 280);
});

test("combobox wheel input scrolls the overflowing option list", () => {
  const target: ComboboxScrollableTarget = {
    clientHeight: 100,
    scrollHeight: 300,
    scrollTop: 20,
  };

  assert.equal(applyComboboxWheelScroll(target, 5, 1), true);
  assert.equal(target.scrollTop, 100);
});

test("combobox wheel input is ignored when the option list does not overflow", () => {
  const target: ComboboxScrollableTarget = {
    clientHeight: 300,
    scrollHeight: 300,
    scrollTop: 20,
  };

  assert.equal(applyComboboxWheelScroll(target, 5, 1), false);
  assert.equal(target.scrollTop, 20);
});

test("combobox search filters font-like options by name and value without case sensitivity", () => {
  const options = [
    { value: "jetbrains-mono", label: "JetBrains Mono" },
    { value: "local-maple-mono", label: "Maple Mono NF", sublabel: "Installed font" },
    { value: "system-ui", label: "System Default" },
  ];

  assert.deepEqual(filterComboboxOptions(options, "JETBRAINS", true), [options[0]]);
  assert.deepEqual(filterComboboxOptions(options, "  JETBRAINS  ", true), [options[0]]);
  assert.deepEqual(filterComboboxOptions(options, "local-maple", true), [options[1]]);
  assert.deepEqual(filterComboboxOptions(options, "installed", true), [options[1]]);
  assert.deepEqual(filterComboboxOptions(options, "missing", true), []);
  assert.equal(filterComboboxOptions(options, "JetBrains Mono", false), options);
});

test("combobox option popovers capture wheel events inside the popup list", () => {
  assert.match(source, /onWheelCapture=\{handleWheelCapture\}/);
  assert.match(source, /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)[\s\S]*event\.nativeEvent\.stopImmediatePropagation\(\)/);
  assert.match(source, /app-no-drag p-0 border-border\/60/);
  assert.doesNotMatch(source, /from "\.\/scroll-area"/);
});

test("Escape closes the picker through the preview-reset path", () => {
  assert.match(
    source,
    /else if \(e\.key === 'Escape'\) \{\s*handleOpenChange\(false\)\s*\}/,
  );
});

test("combobox arrow navigation wraps through every selectable option", () => {
  assert.equal(getNextComboboxActiveIndex(-1, 3, 1), 0);
  assert.equal(getNextComboboxActiveIndex(0, 3, 1), 1);
  assert.equal(getNextComboboxActiveIndex(2, 3, 1), 0);
  assert.equal(getNextComboboxActiveIndex(-1, 3, -1), 2);
  assert.equal(getNextComboboxActiveIndex(0, 3, -1), 2);
  assert.equal(getNextComboboxActiveIndex(0, 0, 1), -1);
});

test("combobox exposes active-option semantics for keyboard navigation", () => {
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /role=\{listbox \? "listbox" : undefined\}/);
  assert.match(source, /<ComboboxOptionsList id=\{listboxId\} listbox>/);
  assert.match(source, /<ComboboxOptionsList>\s*\{/);
  assert.match(source, /role="option"/);
  assert.match(source, /open && !disabled && hasActiveOption/);
  assert.match(source, /const handleSelect = \(optValue: string\) => \{[\s\S]*?setOpen\(false\)\s*setActiveIndex\(-1\)/);
  assert.match(source, /const handleCreate = \(\) => \{[\s\S]*?setOpen\(false\)\s*setActiveIndex\(-1\)/);
});

test("combobox trigger shows a focus-within ring for keyboard users", () => {
  assert.match(source, /focus-within:outline-none focus-within:ring-1 focus-within:ring-ring/);
});

test("combobox makes select-on-focus opt-in so editable controls keep normal caret behavior", () => {
  assert.match(source, /selectValueOnFocus\?: boolean/);
  assert.match(source, /selectValueOnFocus = false/);
  assert.match(source, /onFocus=\{handleInputFocus\}/);
  assert.match(source, /if \(selectValueOnFocus\) focusAndSelectInput\(\)/);
});

test("combobox focus helper selects only when the caller opts in", () => {
  let focusCount = 0;
  let selectCount = 0;
  const input = {
    focus: () => { focusCount += 1; },
    select: () => { selectCount += 1; },
  };

  focusComboboxInput(input, false);
  assert.equal(focusCount, 1);
  assert.equal(selectCount, 0);

  focusComboboxInput(input, true);
  assert.equal(focusCount, 2);
  assert.equal(selectCount, 1);
});

test("combobox reselects a restored value only while its input remains focused", () => {
  let selectCount = 0;
  const input = {
    focus: () => {},
    select: () => { selectCount += 1; },
  };

  selectComboboxInputIfFocused(input, null);
  assert.equal(selectCount, 0);

  selectComboboxInputIfFocused(input, input as unknown as Element);
  assert.equal(selectCount, 1);

  assert.match(source, /const wasOpen = wasOpenRef\.current[\s\S]*wasOpenRef\.current = open/);
  assert.match(source, /if \(wasOpen && selectValueOnFocus\) \{[\s\S]*requestAnimationFrame/);
});

test("disabled comboboxes cannot open or commit a selection", () => {
  assert.equal(canComboboxOpen(false, true), true);
  assert.equal(canComboboxOpen(true, true), false);
  assert.equal(canComboboxOpen(true, false), true);
  assert.match(source, /<Popover open=\{open && !disabled\}/);
  assert.match(source, /const handleSelect = \(optValue: string\) => \{\s*if \(disabled\) return/);
  assert.match(source, /const handleCreate = \(\) => \{\s*if \(disabled\) return/);
  assert.match(source, /const handleClear = \(e: React\.MouseEvent\) => \{\s*if \(disabled\) return/);
  assert.match(source, /clearable && !disabled && inputValue/);
  assert.match(source, /aria-expanded=\{open && !disabled\}/);
  assert.match(source, /disabled && "cursor-not-allowed opacity-50 hover:bg-background"/);
});
