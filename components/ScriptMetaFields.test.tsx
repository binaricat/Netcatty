import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { Snippet } from "../domain/models.ts";
import { ScriptMetaFields } from "./scripts/ScriptMetaFields.tsx";

const snippet: Snippet = {
  id: "script",
  label: "Deploy",
  command: "echo ok",
  trigger: "onOutput",
  triggerPattern: "ready",
};

test("toolbar script metadata keeps output trigger fields on a full row", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <ScriptMetaFields snippet={snippet} onChange={() => {}} layout="toolbar" />
    </I18nProvider>,
  );

  assert.match(
    markup,
    /sm:grid-cols-\[minmax\(0,1fr\)_148px\]/,
  );
  assert.match(markup, /col-span-full space-y-1/);
});
