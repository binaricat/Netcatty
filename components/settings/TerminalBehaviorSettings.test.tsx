import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as terminalBehaviorSettings from "./tabs/TerminalBehaviorSettings.tsx";

const source = readFileSync(new URL("./tabs/TerminalBehaviorSettings.tsx", import.meta.url), "utf8");

const middleClickBehaviorOptions = (
  terminalBehaviorSettings as {
    MIDDLE_CLICK_BEHAVIOR_OPTIONS?: Array<{ value: string; labelKey: string }>;
  }
).MIDDLE_CLICK_BEHAVIOR_OPTIONS;

const dynamicTabTitleModeOptions = (
  terminalBehaviorSettings as {
    DYNAMIC_TAB_TITLE_MODE_OPTIONS?: Array<{ value: string; labelKey: string }>;
  }
).DYNAMIC_TAB_TITLE_MODE_OPTIONS;

test("middle-click settings expose only supported behaviors", () => {
  assert.ok(Array.isArray(middleClickBehaviorOptions));
  assert.deepEqual(
    middleClickBehaviorOptions.map((option) => option.value),
    ["context-menu", "paste", "disabled"],
  );
});

test("dynamic tab title settings expose off, agent-only, and all modes", () => {
  assert.ok(Array.isArray(dynamicTabTitleModeOptions));
  assert.deepEqual(
    dynamicTabTitleModeOptions.map((option) => option.value),
    ["off", "agent", "all"],
  );
});

test("terminal behavior settings expose word separator editing", () => {
  assert.match(source, /settings\.terminal\.behavior\.wordSeparators/);
  assert.match(source, /terminalSettings\.wordSeparators/);
  assert.match(source, /updateTerminalSetting\("wordSeparators", e\.target\.value\)/);
});

test("terminal behavior settings expose Shift+Enter text controls", () => {
  assert.match(source, /settings\.terminal\.behavior\.shiftEnterNewline/);
  assert.match(source, /terminalSettings\.shiftEnterNewlineEnabled/);
  assert.match(source, /updateTerminalSetting\("shiftEnterNewlineEnabled", v\)/);
  assert.match(source, /terminalSettings\.shiftEnterNewlineText/);
  assert.match(source, /updateTerminalSetting\("shiftEnterNewlineText", e\.target\.value\)/);
});
