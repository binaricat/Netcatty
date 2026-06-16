import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { ChatMessage } from "../../infrastructure/ai/types.ts";
import ChatMessageList from "./ChatMessageList.tsx";

const makeMessage = (index: number): ChatMessage => ({
  id: `msg-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message-${index}`,
  timestamp: index,
});

test("ChatMessageList only renders the recent message batch by default", () => {
  const messages = Array.from({ length: 60 }, (_value, index) => makeMessage(index));

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ChatMessageList, { messages }),
    ),
  );

  assert.match(markup, /Load earlier messages \(10 more\)/);
  assert.doesNotMatch(markup, /message-0/);
  assert.match(markup, /message-10/);
  assert.match(markup, /message-59/);
});
