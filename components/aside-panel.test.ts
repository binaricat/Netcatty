import test from "node:test";
import assert from "node:assert/strict";

import { invokeAsideActionMenuItemClick } from "./ui/aside-panel.tsx";

test("AsideActionMenuItem closes its menu before running the action", () => {
  const events: string[] = [];

  invokeAsideActionMenuItemClick(
    () => events.push("close"),
    () => events.push("action"),
  );

  assert.deepEqual(events, ["close", "action"]);
});

test("AsideActionMenuItem still closes when no action is provided", () => {
  const events: string[] = [];

  invokeAsideActionMenuItemClick(() => events.push("close"));

  assert.deepEqual(events, ["close"]);
});
