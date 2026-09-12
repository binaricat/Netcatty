import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComboboxWheelScroll,
  comboboxNextRenderLimit,
  comboboxWheelDeltaToPixels,
  filterComboboxOptions,
  focusComboboxInput,
  selectComboboxInputIfFocused,
  canComboboxOpen,
  getNextComboboxActiveIndex,
  shouldExpandComboboxWindow,
  shouldResetComboboxWindow,
  comboboxWindowStartForActiveIndex,
  COMBOBOX_INITIAL_RENDER_LIMIT,
  COMBOBOX_RENDER_LIMIT_STEP,
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
  assert.match(source, /<ComboboxOptionsList id=\{listboxId\} listbox scrollRef=\{optionsScrollRef\} onScrollCapture=\{handleOptionsScrollCapture\}>/);
  assert.match(source, /<ComboboxOptionsList>\s*\{/);
  assert.match(source, /role="option"/);
  assert.match(source, /open && !disabled && hasActiveOption/);
  assert.match(source, /const handleSelect = \(optValue: string\) => \{[\s\S]*?setOpen\(false\)\s*setActiveIndex\(-1\)/);
  assert.match(source, /const handleCreate = \(\) => \{[\s\S]*?setOpen\(false\)\s*setActiveIndex\(-1\)/);
});

test("combobox render window grows in bounded steps and stops at the end", () => {
  assert.equal(comboboxNextRenderLimit(COMBOBOX_INITIAL_RENDER_LIMIT, 10), null);
  assert.equal(
    comboboxNextRenderLimit(COMBOBOX_INITIAL_RENDER_LIMIT, 500),
    COMBOBOX_INITIAL_RENDER_LIMIT + COMBOBOX_RENDER_LIMIT_STEP,
  );
  assert.equal(comboboxNextRenderLimit(480, 500), 500);
  assert.equal(comboboxNextRenderLimit(500, 500), null);
  assert.equal(comboboxNextRenderLimit(600, 500), null);
});

test("combobox render window expands when the list is scrolled near its bottom", () => {
  const target = (scrollTop: number): ComboboxScrollableTarget => ({
    clientHeight: 280,
    scrollHeight: 500 * 40,
    scrollTop,
  });

  // Far from the bottom: keep the window as-is.
  assert.equal(shouldExpandComboboxWindow(target(0), COMBOBOX_INITIAL_RENDER_LIMIT, 500), false);
  // Near the bottom of the mounted slice: expand it.
  assert.equal(
    shouldExpandComboboxWindow(target(500 * 40 - 280 - 10), COMBOBOX_INITIAL_RENDER_LIMIT, 500),
    true,
  );
  // Everything already rendered: never expand.
  assert.equal(shouldExpandComboboxWindow(target(0), 500, 500), false);
  // Empty list cannot expand.
  assert.equal(shouldExpandComboboxWindow(target(0), 0, 0), false);
});

test("combobox slid windows reset when the list is scrolled back to its top", () => {
  const target = (scrollTop: number): ComboboxScrollableTarget => ({
    clientHeight: 280,
    scrollHeight: 60 * 40,
    scrollTop,
  });

  assert.equal(shouldResetComboboxWindow(target(0)), true);
  assert.equal(shouldResetComboboxWindow(target(40)), true);
  assert.equal(shouldResetComboboxWindow(target(120)), false);
});

test("combobox keyboard scrolling into view does not reset a slid window", () => {
  // The scroll-into-view effect marks its scroll events as navigational so
  // sliding toward the top by ArrowUp cannot trigger the manual-scroll
  // reset (which would clear the active option and lose backward reach).
  assert.match(source, /const navigationalScrollRef = React\.useRef\(false\)/);
  assert.match(
    source,
    /React\.useEffect\(\(\) => \{\s*\/\/ Scrolling the active option into view emits scroll events[\s\S]*?navigationalScrollRef\.current = true\s*activeOptionRef\.current\?\.scrollIntoView\(\{ block: 'nearest' \}\)\s*requestAnimationFrame\(\(\) => \{\s*navigationalScrollRef\.current = false\s*\}\)/,
  );
  assert.match(
    source,
    /if \(windowStart > 0 && shouldResetComboboxWindow\(scrollTarget\)\) \{\s*if \(navigationalScrollRef\.current\) return\s*setActiveIndex\(-1\)/,
  );
});

test("combobox keyboard scrolling into view does not expand a slid window", () => {
  // Programmatic scrolls from scrolling the active option into view can land
  // near the bottom of the last window; they are not manual scrolls, so the
  // keyboard window must stay a fixed size instead of growing on every
  // ArrowUp/ArrowDown wrap boundary.
  assert.match(
    source,
    /\/\/ skip expansion to keep the keyboard window at a fixed size instead[\s\S]*?if \(navigationalScrollRef\.current\) return\s*if \(!shouldExpandComboboxWindow\(/,
  );
});

test("combobox render window resets during render, before committing a changed result set", () => {
  // The reset must not live in a post-commit effect, otherwise a cleared or
  // changed query commits the new result sliced with a stale oversized
  // window before the effect can shrink it back.
  assert.doesNotMatch(
    source.slice(source.indexOf("const [windowKey, setWindowKey]"),
      source.indexOf("const renderedOptions")),
    /useEffect/,
  );
  assert.match(
    source,
    /if \(windowKey\.open !== open \|\| windowKey\.filteredOptions !== filteredOptions\) \{\s*setWindowKey\(\{ open, filteredOptions \}\)\s*setRenderLimit\(COMBOBOX_INITIAL_RENDER_LIMIT\)\s*setWindowStart\(0\)/,
  );
});

test("combobox resets the listbox scroll position alongside the render window", () => {
  // The render-window reset only touches React state; the listbox DOM node
  // would keep (or clamp) its previous scrollTop, so a fresh initial slice
  // would be displayed near its bottom instead of at its first match.
  assert.match(source, /const optionsScrollRef = React\.useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /ref=\{scrollRef\}/);
  assert.match(
    source,
    /\/\/ Resetting the render window alone is not enough[\s\S]*?React\.useEffect\(\(\) => \{\s*if \(optionsScrollRef\.current\) optionsScrollRef\.current\.scrollTop = 0\s*\}, \[open, filteredOptions\]\)/,
  );
});

test("combobox renders options incrementally so large font lists cannot freeze the picker", () => {
  assert.match(source, /const \[renderLimit, setRenderLimit\] = React\.useState\(COMBOBOX_INITIAL_RENDER_LIMIT\)/);
  assert.match(source, /filteredOptions\.slice\(windowStart, windowStart \+ renderLimit\)/);
  assert.match(source, /renderedOptions\.map\(\(option, optionIndex\)/);
  assert.match(source, /onScrollCapture=\{handleOptionsScrollCapture\}/);
  assert.match(
    source,
    /const nextWindowStart = comboboxWindowStartForActiveIndex\(\s*optionIndex,\s*windowStart,\s*renderLimit,\s*filteredOptions\.length,\s*\)\s*if \(nextWindowStart !== null\) setWindowStart\(nextWindowStart\)/,
  );
});

test("combobox keyboard navigation slides a bounded window instead of mounting the whole list", () => {
  // Within the initial window: no shift.
  assert.equal(comboboxWindowStartForActiveIndex(10, 0, 60, 500), null);
  // ArrowUp wrap to the last option: slide so it is mounted, without
  // growing the mounted count beyond the window size.
  assert.equal(comboboxWindowStartForActiveIndex(499, 0, 60, 500), 440);
  // Already mounted at the window edge: no further shift.
  assert.equal(comboboxWindowStartForActiveIndex(499, 440, 60, 500), null);
  // ArrowUp wrap back above the window start: slide so it is mounted.
  assert.equal(comboboxWindowStartForActiveIndex(0, 440, 60, 500), 0);
  // Small lists never need a window.
  assert.equal(comboboxWindowStartForActiveIndex(2, 0, 60, 10), null);
  // No active option or empty list: no shift.
  assert.equal(comboboxWindowStartForActiveIndex(-1, 0, 60, 500), null);
  assert.equal(comboboxWindowStartForActiveIndex(0, 0, 60, 0), null);
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
