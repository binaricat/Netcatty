import assert from "node:assert/strict";
import test, { before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider";
import { loadLocaleMessages } from "../application/i18n/messages";
import type { Host, TerminalSession } from "../types";
import { QuickSwitcher } from "./QuickSwitcher";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "saved-1",
  label: "core-switch",
  hostname: "10.1.1.1",
  username: "admin",
  tags: [],
  os: "linux",
  protocol: "ssh",
  ...overrides,
}) as Host;

const renderSwitcher = (
  query: string,
  results: Host[] = [],
  locale = "en",
) => renderToStaticMarkup(
  <I18nProvider locale={locale}>
    <QuickSwitcher
      isOpen
      query={query}
      results={results}
      sessions={[]}
      workspaces={[]}
      onQueryChange={() => undefined}
      onSelect={() => undefined}
      onSelectTab={() => undefined}
      onClose={() => undefined}
      onQuickConnect={() => undefined}
      showSftpTab={false}
    />
  </I18nProvider>,
);

// Non-English dictionaries load on demand; static rendering runs no effects.
before(async () => {
  await loadLocaleMessages("zh-TW");
  await loadLocaleMessages("zh-CN");
});

test("quick switcher keeps a matching host ahead of an address row", () => {
  const markup = renderSwitcher("10.1.1.1", [host()]);
  const quickConnectAt = markup.indexOf("Quick connect to 10.1.1.1");
  const hostAt = markup.indexOf("core-switch");
  const selectedAt = markup.indexOf("bg-primary/15");

  assert.ok(selectedAt >= 0);
  assert.ok(hostAt > selectedAt);
  assert.ok(quickConnectAt > hostAt);
  assert.equal(markup.indexOf("bg-primary/15", selectedAt + 1), -1);
});

test("quick switcher does not steal Enter from a saved host label", () => {
  for (const label of ["lab", "web01", "prod", "lab-switch"]) {
    const markup = renderSwitcher(label, [host({ id: label, label, hostname: "10.0.0.5" })]);
    const hostAt = markup.indexOf(`>${label}<`);
    const selectedAt = markup.indexOf("bg-primary/15");

    assert.equal(markup.includes("Quick connect to"), false, label);
    assert.ok(selectedAt >= 0 && hostAt > selectedAt, label);
  }
});

test("quick switcher keeps a matching open session ahead of an address row", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickSwitcher
        isOpen
        query="10.4.4.4"
        results={[]}
        sessions={[{
          id: "sess-1",
          hostId: "host-1",
          hostLabel: "open-core",
          username: "admin",
          hostname: "10.4.4.4",
          status: "connected",
        } as TerminalSession]}
        workspaces={[]}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onSelectTab={() => undefined}
        onClose={() => undefined}
        onQuickConnect={() => undefined}
        showSftpTab={false}
      />
    </I18nProvider>,
  );
  const sessionAt = markup.indexOf("open-core");
  const quickConnectAt = markup.indexOf("Quick connect to 10.4.4.4");
  const selectedAt = markup.indexOf("bg-primary/15");

  assert.ok(selectedAt >= 0);
  assert.ok(sessionAt > selectedAt);
  assert.ok(quickConnectAt > sessionAt);
  assert.equal(markup.indexOf("bg-primary/15", selectedAt + 1), -1);
});

test("quick switcher offers quick connect when nothing else matches", () => {
  const markup = renderSwitcher("root@10.2.0.8:2222");

  assert.match(markup, /Quick connect to root@10\.2\.0\.8:2222/);
  assert.match(markup, /bg-primary\/15[\s\S]*Quick connect to root@10\.2\.0\.8:2222/);
});

test("quick switcher does not offer quick connect for ordinary search text", () => {
  const markup = renderSwitcher("core switch");

  assert.doesNotMatch(markup, /Quick connect to/);
});

test("quick switcher quick connect row uses zh-TW wording", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <QuickSwitcher
        isOpen
        query="10.0.0.8"
        results={[host()]}
        sessions={[]}
        workspaces={[]}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onSelectTab={() => undefined}
        onClose={() => undefined}
        onQuickConnect={() => undefined}
        onCreateWorkspace={() => undefined}
        showSftpTab={false}
      />
    </I18nProvider>,
  );

  assert.match(markup, /快速連線到 10\.0\.0\.8/);
  assert.match(markup, />主機</);
  assert.match(markup, />新增工作區</);
  assert.doesNotMatch(markup, /New Workspace/);
});

test("quick switcher section labels use zh-CN wording", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="zh-CN">
      <QuickSwitcher
        isOpen
        query=""
        results={[host()]}
        sessions={[]}
        workspaces={[]}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onSelectTab={() => undefined}
        onClose={() => undefined}
        onQuickConnect={() => undefined}
        onCreateWorkspace={() => undefined}
        showSftpTab={false}
      />
    </I18nProvider>,
  );

  assert.match(markup, />主机</);
  assert.match(markup, />标签页</);
  assert.match(markup, />新建工作区</);
});
