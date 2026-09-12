import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  VaultTreeGroupRow,
  VaultTreeInlineRenameInput,
  VaultTreeItemRow,
} from "./VaultTreeRow.tsx";

test("VaultTreeGroupRow exposes shared selected and expanded tree row state", () => {
  const markup = renderToStaticMarkup(
    <VaultTreeGroupRow
      name="Production"
      depth={1}
      expanded={true}
      selected={true}
      count={3}
      onClick={() => undefined}
      onToggle={() => undefined}
    />,
  );

  assert.match(markup, /data-vault-tree-row="group"/);
  assert.match(markup, /data-selected="true"/);
  assert.match(markup, /data-expanded="true"/);
  assert.match(markup, /Production/);
  assert.match(markup, /3/);
});

test("VaultTreeGroupRow can render an action beside the group label", () => {
  const markup = renderToStaticMarkup(
    <VaultTreeGroupRow
      name="Production"
      depth={1}
      count={3}
      labelActions={<button data-label-action="edit">Edit</button>}
      actions={<span data-row-action="count">Row action</span>}
    />,
  );

  const labelIndex = markup.indexOf("Production");
  const labelActionIndex = markup.indexOf('data-label-action="edit"');
  const countIndex = markup.indexOf(">3<", labelActionIndex);
  const rowActionIndex = markup.indexOf('data-row-action="count"', countIndex);

  assert.ok(labelIndex >= 0);
  assert.ok(labelActionIndex > labelIndex);
  assert.ok(countIndex > labelActionIndex);
  assert.ok(rowActionIndex > countIndex);
});


test("VaultTreeItemRow exposes shared selected item state", () => {
  const markup = renderToStaticMarkup(
    <VaultTreeItemRow
      label="Failover checklist"
      depth={2}
      selected={true}
      onClick={() => undefined}
    />,
  );

  assert.match(markup, /data-vault-tree-row="item"/);
  assert.match(markup, /data-selected="true"/);
  assert.match(markup, /Failover checklist/);
});

test("VaultTree rows can tighten the icon-to-label gap per surface", () => {
  const groupMarkup = renderToStaticMarkup(
    <VaultTreeGroupRow name="Production" depth={0} iconClassName="mr-1" />,
  );
  const itemMarkup = renderToStaticMarkup(
    <VaultTreeItemRow label="Failover checklist" depth={0} iconClassName="mr-1" />,
  );

  assert.match(groupMarkup, /<div class="flex shrink-0 items-center[^"]*mr-1">/);
  assert.match(itemMarkup, /<div class="flex shrink-0 items-center[^"]*mr-1">/);
  assert.doesNotMatch(groupMarkup, /<div class="[^"]*mr-2[^"]*flex shrink-0/);
  assert.doesNotMatch(itemMarkup, /<div class="[^"]*mr-2[^"]*flex shrink-0/);
});

test("VaultTree labels use CJK-safe line-height under truncate", () => {
  const groupMarkup = renderToStaticMarkup(
    <VaultTreeGroupRow name="服务器配置" depth={0} count={1} />,
  );
  const itemMarkup = renderToStaticMarkup(
    <VaultTreeItemRow label="机器安全检查报告" depth={0} />,
  );

  // leading-none clips CJK (PingFang etc.) when truncate applies overflow:hidden.
  assert.match(groupMarkup, /leading-5/);
  assert.doesNotMatch(groupMarkup, /leading-none/);
  assert.match(itemMarkup, /leading-5/);
  assert.doesNotMatch(itemMarkup, /leading-none/);
  assert.match(groupMarkup, /flex min-w-0 flex-1 items-center/);
  assert.match(itemMarkup, /min-w-0 flex-1 truncate leading-5/);
  assert.match(groupMarkup, /min-w-0 truncate translate-y-px/);
  assert.match(itemMarkup, /min-w-0 flex-1 truncate leading-5 translate-y-px/);
  assert.doesNotMatch(groupMarkup, /-translate-y-px/);
  assert.doesNotMatch(itemMarkup, /-translate-y-px/);
});

test("VaultTreeItemRow does not clip the inline rename input", () => {
  const markup = renderToStaticMarkup(
    <VaultTreeItemRow
      label="机器安全检查报告"
      depth={0}
      editing={true}
      onRenameCommit={() => undefined}
      onRenameCancel={() => undefined}
    />,
  );

  const document = new JSDOM(markup).window.document;
  const input = document.querySelector<HTMLInputElement>('[data-vault-tree-inline-edit="true"]');
  assert.ok(input);
  assert.equal(input.parentElement?.classList.contains("h-5"), false);
});

test("VaultTree labels expose full title and keep actions from shrinking", () => {
  const groupMarkup = renderToStaticMarkup(
    <VaultTreeGroupRow
      name="Dokploy服务信息"
      depth={0}
      actions={<button type="button" data-row-action="menu">…</button>}
    />,
  );
  const itemMarkup = renderToStaticMarkup(
    <VaultTreeItemRow
      label="Security Audit Report - 完整版"
      depth={1}
      actions={<button type="button" data-row-action="menu">…</button>}
    />,
  );

  assert.match(groupMarkup, /title="Dokploy服务信息"/);
  assert.match(groupMarkup, /min-w-0 truncate/);
  assert.match(groupMarkup, /shrink-0[^>]*>[\s\S]*data-row-action="menu"/);
  assert.match(itemMarkup, /title="Security Audit Report - 完整版"/);
  assert.match(itemMarkup, /min-w-0 flex-1 truncate leading-5/);
  assert.match(itemMarkup, /shrink-0[^>]*>[\s\S]*data-row-action="menu"/);
});

test("VaultTreeInlineRenameInput uses shared inline edit marker", () => {
  const markup = renderToStaticMarkup(
    <VaultTreeInlineRenameInput
      initialName="Ops"
      onCommit={() => undefined}
      onCancel={() => undefined}
    />,
  );

  assert.match(markup, /data-vault-tree-inline-edit="true"/);
  assert.match(markup, /value="Ops"/);
});

test("VaultTreeInlineRenameInput can retry after an asynchronous commit failure", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | null = null;
  let attempts = 0;

  try {
    await act(async () => {
      renderer = create(
        <VaultTreeInlineRenameInput
          initialName="Ops"
          onCommit={async () => {
            attempts += 1;
            return attempts > 1;
          }}
          onCancel={() => undefined}
        />,
      );
    });
    const input = renderer!.root.findByType("input");
    const pressEnter = async () => {
      input.props.onKeyDown({
        key: "Enter",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
      await Promise.resolve();
    };
    await act(pressEnter);
    await act(pressEnter);
    assert.equal(attempts, 2);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
