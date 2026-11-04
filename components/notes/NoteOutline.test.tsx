import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import { loadLocaleMessages } from "../../application/i18n/messages.ts";
import { NoteOutline } from "./NoteOutline.tsx";

test("note outline renders a borderless hierarchy without heading-level labels", async () => {
  // Static rendering runs no effects, so load the dictionary explicitly.
  await loadLocaleMessages("zh-CN");
  const markup = renderToStaticMarkup(
    <I18nProvider locale="zh-CN">
      <NoteOutline
        content={"## 第一节\n\n### 子章节\n\n## 第二节"}
        onClose={() => undefined}
        onSelectHeading={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /data-note-outline="true"/);
  assert.equal(markup.match(/data-note-outline-item=/g)?.length, 3);
  assert.match(markup, /padding-left:10px/);
  assert.match(markup, /padding-left:22px/);
  assert.doesNotMatch(markup, />H[1-6]</);
  assert.doesNotMatch(markup, /border-l|border-b|uppercase|tracking-wider/);
});
