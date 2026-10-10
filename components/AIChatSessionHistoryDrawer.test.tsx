import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import type { AISession } from "../infrastructure/ai/types.ts";
import { MESSAGES_BY_LOCALE } from "../application/i18n/messages.ts";
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from "./test-support/renderReactDom.tsx";

test("history drawer filters, pages, clears and explains the bounded search in every locale", async () => {
  const dom = installDomEnvironment();
  const { SessionHistoryDrawer } = await import("./AIChatSessionHistoryDrawer.tsx");
  const { I18nProvider } = await import("../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const renderer = await createDomRenderer(dom.document);
  const sessions: AISession[] = Array.from({ length: 141 }, (_, i) => ({
    id: `s-${i}`,
    title: `Session ${i}`,
    agentId: "catty",
    scope: { type: "terminal", targetId: "terminal-1" },
    messages: [{
      id: `m-${i}`, role: "user", timestamp: 0,
      content: i === 140 ? "needle [prod].json" : "ordinary content",
    }],
    createdAt: 0,
    updatedAt: 0,
  }));
  const selected: string[] = [];
  const deleted: string[] = [];
  let closed = 0;
  const render = (items = sessions, locale = "en") => renderer.render(
    <I18nProvider locale={locale}>
      <TooltipProvider>
        <SessionHistoryDrawer
          sessions={items}
          activeSessionId="s-140"
          onSelect={(id) => selected.push(id)}
          onDelete={(event, id) => { event.stopPropagation(); deleted.push(id); }}
          onClose={() => { closed += 1; }}
        />
      </TooltipProvider>
    </I18nProvider>,
  );
  const rows = () => renderer.container.querySelectorAll('[role="button"]');
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await dispatchDomEvent(element, new dom.window.MouseEvent("click", { bubbles: true }));
  };
  const enterQuery = async (query: string) => {
    const input = renderer.container.querySelector("input");
    assert.ok(input);
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, query);
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
  };
  const loadMore = () => [...renderer.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("Load more"));

  try {
    await render();
    assert.equal(rows().length, 80);
    assert.match(loadMore()?.textContent ?? "", /61/);
    await click(loadMore());
    assert.equal(rows().length, 140);
    await enterQuery("[prod].json");
    assert.equal(rows().length, 1);
    assert.match(rows()[0].textContent ?? "", /Session 140/);
    assert.equal(loadMore(), undefined);
    await click(rows()[0]);
    await dispatchDomEvent(rows()[0], new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await click(rows()[0].querySelector("button"));
    assert.deepEqual(selected, ["s-140", "s-140"]);
    assert.deepEqual(deleted, ["s-140"]);

    await enterQuery("[](){}");
    assert.equal(rows().length, 0);
    assert.match(renderer.container.textContent ?? "", /No matches in titles or recent retained content/);
    assert.match(renderer.container.textContent ?? "", /Long content may not be searched in full/);
    await click(renderer.container.querySelector("input")?.parentElement?.querySelector("button"));
    assert.equal(renderer.container.querySelector("input")?.value, "");
    assert.equal(rows().length, 80);
    assert.match(loadMore()?.textContent ?? "", /61/);
    await enterQuery("  \t");
    assert.equal(rows().length, 80);
    await click(renderer.container.querySelector("button"));
    assert.equal(closed, 1);

    for (const locale of ["en", "zh-CN", "zh-TW", "es", "ru"]) {
      await render(sessions, locale);
      await enterQuery("no-such-content");
      const messages = MESSAGES_BY_LOCALE[locale];
      const input = renderer.container.querySelector("input")!;
      const hint = dom.document.getElementById(input.getAttribute("aria-describedby")!);
      for (const key of ["ai.chat.searchSessions", "ai.chat.searchSessionsHint", "ai.chat.noMatchingSessions"]) {
        assert.ok(messages[key], `${locale} is missing ${key}`);
      }
      assert.equal(input.placeholder, messages["ai.chat.searchSessions"]);
      assert.equal(input.getAttribute("aria-label"), messages["ai.chat.searchSessions"]);
      assert.equal(hint?.textContent, messages["ai.chat.searchSessionsHint"]);
      assert.ok(renderer.container.textContent?.includes(messages["ai.chat.noMatchingSessions"]));
      await render([], locale);
      assert.ok(renderer.container.textContent?.includes(messages["ai.chat.noSessions"]));
      assert.ok(!renderer.container.textContent?.includes(messages["ai.chat.noMatchingSessions"]));
    }
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});
