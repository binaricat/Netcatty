import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
