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
