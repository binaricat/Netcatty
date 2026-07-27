import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AntigravityCliCard } from "./AntigravityCliCard";

const noop = () => {};

test("Antigravity settings shows the detected official agy CLI and login instructions", () => {
  const markup = renderToStaticMarkup(
    <AntigravityCliCard
      pathInfo={{
        path: "/usr/local/bin/agy",
        version: "agy 1.1.7",
        available: true,
        installed: true,
      }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={noop}
      onOpenInstallGuide={noop}
      onRecheckPath={noop}
      onResetPath={noop}
    />,
  );

  assert.match(markup, /\/usr\/local\/bin\/agy/);
  assert.match(markup, /agy 1\.1\.7/);
  assert.match(markup, /ai\.antigravity\.loginHint/);
  assert.doesNotMatch(markup, /type="password"/);
  assert.doesNotMatch(markup, /ai\.antigravity\.installing/);
  assert.doesNotMatch(markup, /ai\.antigravity\.signedIn/);
});

test("Antigravity settings links to official installation when agy is not found", () => {
  const markup = renderToStaticMarkup(
    <AntigravityCliCard
      pathInfo={{ path: null, version: null, available: false }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={noop}
      onOpenInstallGuide={noop}
      onRecheckPath={noop}
      onResetPath={noop}
    />,
  );

  assert.match(markup, /ai\.antigravity\.notFoundHint/);
  assert.match(markup, /ai\.antigravity\.installGuide/);
  assert.match(markup, /ai\.antigravity\.customPathPlaceholder/);
  assert.doesNotMatch(markup, /Download/);
});

test("Antigravity settings shows an installed but unsupported agy version", () => {
  const markup = renderToStaticMarkup(
    <AntigravityCliCard
      pathInfo={{
        path: "C:\\Tools\\agy.exe",
        version: "Antigravity CLI 1.1.3",
        available: false,
        installed: true,
      }}
      isResolvingPath={false}
      customPath="C:\\Tools\\agy.exe"
      onCustomPathChange={noop}
      onOpenInstallGuide={noop}
      onRecheckPath={noop}
      onResetPath={noop}
    />,
  );

  assert.match(markup, /C:\\Tools\\agy\.exe/);
  assert.match(markup, /Antigravity CLI 1\.1\.3/);
  assert.match(markup, /ai\.antigravity\.upgradeRequired/);
  assert.doesNotMatch(markup, /ai\.antigravity\.notFoundHint/);
});
