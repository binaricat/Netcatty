import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { HostTreeGroupInlineRenameInput } from "../host/HostTreeGroupInlineRenameInput";
import { SessionInlineRenameInput } from "../terminal/SessionInlineRenameInput";
import { VaultTreeInlineRenameInput } from "../vault/VaultTreeRow";
import { InlineRenameInput } from "./inline-rename-input";

test("inline rename wrappers preserve exact data attributes", () => {
  const groupMarkup = renderToStaticMarkup(
    <HostTreeGroupInlineRenameInput initialName="Prod" onCommit={() => {}} onCancel={() => {}} />,
  );
  assert.match(groupMarkup, /data-inline-group-edit="true"/);
  assert.doesNotMatch(groupMarkup, /data-vault-tree-inline-edit/);

  const vaultTreeMarkup = renderToStaticMarkup(
    <VaultTreeInlineRenameInput initialName="Staging" onCommit={() => {}} onCancel={() => {}} />,
  );
  assert.match(vaultTreeMarkup, /data-vault-tree-inline-edit="true"/);
  assert.match(vaultTreeMarkup, /data-inline-group-edit="true"/);

  const sessionMarkup = renderToStaticMarkup(
    <SessionInlineRenameInput initialName="web-1" onCommit={() => {}} onCancel={() => {}} />,
  );
  assert.match(sessionMarkup, /data-session-inline-rename="true"/);
});

test("InlineRenameInput handles Enter, Escape, blur queueMicrotask, stopPropagation, and async retry", async () => {
  const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = actEnv.IS_REACT_ACT_ENVIRONMENT;
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | null = null;

  try {
    // 1. Escape cancels once and suppresses subsequent blur commit.
    let commits = 0;
    let cancels = 0;
    await act(async () => {
      renderer = create(
        <InlineRenameInput
          initialName="alpha"
          onCommit={() => {
            commits += 1;
          }}
          onCancel={() => {
            cancels += 1;
          }}
        />,
      );
    });
    const input = renderer!.root.findByType("input");
    let stopped = 0;
    let prevented = 0;
    const stopPropagation = () => { stopped += 1; };
    const preventDefault = () => { prevented += 1; };
    input.props.onClick({ stopPropagation });
    input.props.onDoubleClick({ stopPropagation });
    input.props.onMouseDown({ stopPropagation });
    input.props.onPointerDown({ stopPropagation });
    input.props.onDragStart({ stopPropagation, preventDefault });
    assert.equal(stopped, 5);
    assert.equal(prevented, 1);

    await act(async () => {
      input.props.onKeyDown({ key: "Escape", stopPropagation, preventDefault });
      input.props.onBlur();
      await Promise.resolve();
    });
    assert.equal(cancels, 1);
    assert.equal(commits, 0);

    // 2. Blur commits via queueMicrotask and resets submittingRef when onCommit rejects or returns false.
    let blurAttempts = 0;
    let committedValue = "";
    await act(async () => {
      renderer!.unmount();
      renderer = create(
        <InlineRenameInput
          initialName="beta"
          onCommit={async (name) => {
            blurAttempts += 1;
            committedValue = name;
            if (blurAttempts === 1) return false;
            if (blurAttempts === 2) throw new Error("transient");
            return true;
          }}
          onCancel={() => {}}
        />,
      );
    });
    const input2 = renderer!.root.findByType("input");
    await act(async () => {
      input2.props.onChange({ target: { value: "gamma" } });
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        input2.props.onBlur();
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    // Attempts 1 (false) and 2 (throw) unlock; attempt 3 (true) locks so attempt 4 is skipped.
    assert.equal(blurAttempts, 3);
    assert.equal(committedValue, "gamma");
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnv.IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});
