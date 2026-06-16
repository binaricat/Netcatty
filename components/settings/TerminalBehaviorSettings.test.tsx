import assert from "node:assert/strict";
import test from "node:test";

import * as terminalBehaviorSettings from "./tabs/TerminalBehaviorSettings.tsx";

const middleClickBehaviorOptions = (
  terminalBehaviorSettings as {
    MIDDLE_CLICK_BEHAVIOR_OPTIONS?: Array<{ value: string; labelKey: string }>;
  }
).MIDDLE_CLICK_BEHAVIOR_OPTIONS;

test("middle-click settings expose only supported behaviors", () => {
  assert.ok(Array.isArray(middleClickBehaviorOptions));
  assert.deepEqual(
    middleClickBehaviorOptions.map((option) => option.value),
    ["context-menu", "paste", "disabled"],
  );
});
