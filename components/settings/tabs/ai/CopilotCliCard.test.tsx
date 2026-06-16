import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopilotCliCard } from "./CopilotCliCard";

function firstButton(markup: string): string {
  const match = markup.match(/<button\b[^>]*>/);
  return match?.[0] ?? "";
}

test("Cursor check button stays enabled without a custom path", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: null, version: null, available: false }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      i18nPrefix="ai.cursor"
      allowEmptyCheck
    />,
  );

  assert.equal(firstButton(markup).includes("disabled=\"\""), false);
});

test("Copilot check button still requires a custom path", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: null, version: null, available: false }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
    />,
  );

  assert.equal(firstButton(markup).includes("disabled=\"\""), true);
});
