import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyPane } from "./types.ts";
import {
  closeSftpTabStateImmediately,
  removeSftpTabFromState,
} from "./useSftpTabsState.ts";

test("closing the active SFTP tab selects its nearest remaining neighbor", () => {
  const left = createEmptyPane("left");
  const middle = createEmptyPane("middle");
  const right = createEmptyPane("right");

  assert.deepEqual(removeSftpTabFromState({
    tabs: [left, middle, right],
    activeTabId: middle.id,
  }, middle.id), {
    tabs: [left, right],
    activeTabId: right.id,
  });
});

test("closing a background SFTP tab preserves the active tab", () => {
  const active = createEmptyPane("active");
  const background = createEmptyPane("background");

  assert.deepEqual(removeSftpTabFromState({
    tabs: [active, background],
    activeTabId: active.id,
  }, background.id), {
    tabs: [active],
    activeTabId: active.id,
  });
});

test("closing a tab updates the live ref before React commits the state update", () => {
  const closing = createEmptyPane("closing");
  const remaining = createEmptyPane("remaining");
  const initial = {
    tabs: [closing, remaining],
    activeTabId: closing.id,
  };
  const tabsRef = { current: initial };
  let queuedUpdate: ((prev: typeof initial) => typeof initial) | undefined;

  closeSftpTabStateImmediately({
    tabsRef,
    tabId: closing.id,
    setTabs: (update) => {
      queuedUpdate = update;
    },
  });

  assert.deepEqual(tabsRef.current.tabs, [remaining]);
  assert.equal(tabsRef.current.activeTabId, remaining.id);
  assert.deepEqual(queuedUpdate?.(initial), tabsRef.current);
});
