import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AntigravitySdkCard } from "./AntigravitySdkCard";

test("Antigravity settings exposes SDK status, Python path, and API key", () => {
  const markup = renderToStaticMarkup(
    <AntigravitySdkCard
      pathInfo={{
        path: "/usr/bin/python3",
        version: "Antigravity SDK 0.1.8 (Python 3.12.4)",
        available: true,
        installed: true,
      }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
      onSaveApiKey={async () => {}}
    />,
  );

  assert.match(markup, /Antigravity SDK 0\.1\.8/);
  assert.match(markup, /\/usr\/bin\/python3/);
  assert.match(markup, /type="password"/);
});

test("Antigravity settings disables save while loading a stored API key", () => {
  const markup = renderToStaticMarkup(
    <AntigravitySdkCard
      pathInfo={{ available: true, sdkReady: true }}
      isResolvingPath={false}
      customPath=""
      encryptedApiKey="encrypted"
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
      onSaveApiKey={async () => {}}
    />,
  );

  assert.match(markup, /<input type="password"[^>]*disabled=""/);
  assert.match(markup, /disabled="">ai\.antigravity\.saveApiKey<\/button>/);
});

test("Antigravity settings reports an unsupported installed SDK as unavailable", () => {
  const markup = renderToStaticMarkup(
    <AntigravitySdkCard
      pathInfo={{
        path: "/usr/bin/python3",
        version: "Antigravity SDK 0.1.7 (Python 3.12.4)",
        installed: true,
        sdkReady: false,
        available: false,
      }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
      onSaveApiKey={async () => {}}
    />,
  );

  assert.match(markup, /ai\.antigravity\.notFound/);
  assert.match(markup, /ai\.antigravity\.notFoundHint/);
});
