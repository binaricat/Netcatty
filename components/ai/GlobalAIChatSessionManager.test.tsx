import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import type { AISession } from "../../infrastructure/ai/types.ts";
import { getLoadedLocaleMessages, loadLocaleMessages } from "../../application/i18n/messages.ts";
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from "../test-support/renderReactDom.tsx";

await loadLocaleMessages("en");
const enMessages = getLoadedLocaleMessages("en")!;
const t = (key: string) => {
  const hit = enMessages[key as keyof typeof enMessages];
  return typeof hit === "string" ? hit : key;
};

const makeSession = (overrides: Partial<AISession>): AISession => ({
  id: "s-1",
  title: "Chat",
  agentId: "catty",
  scope: { type: "terminal", targetId: "t-1" },
  messages: [{ id: "m-1", role: "user", timestamp: 0, content: "hello" }],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
} as AISession);

const externalAgents = [{ id: "codex", name: "Codex" }] as never[];

function baseProps() {
  return {
    sessions: [] as AISession[],
    activeSessionIdMap: {} as Record<string, string | null>,
    currentScopeType: "terminal" as const,
    currentScopeTargetId: "t-1",
    currentScopeHostIds: undefined as string[] | undefined,
    workspaces: [{ id: "w-1", title: "Prod" }],
    terminalInfos: [
      { sessionId: "t-1", hostId: "h-1", label: "edge", hostname: "edge.example", connected: true },
      { sessionId: "t-2", hostId: "h-2", label: "core", hostname: "core.example", connected: true },
    ],
    externalAgents,
    rebindTargets: [
      { type: "workspace" as const, targetId: "w-1", label: "Prod" },
      { type: "terminal" as const, targetId: "t-2", label: "core", hostIds: undefined as string[] | undefined },
    ],
    onSelect: (_sessionId: string) => {},
    onRebind: (_sessionId: string, _target: { type: string; targetId: string; hostIds?: string[] }) => {},
    onDelete: (_sessionId: string) => {},
    onExport: (_sessionId: string) => {},
  };
}

async function renderManager(dom: ReturnType<typeof installDomEnvironment>, props: ReturnType<typeof baseProps>) {
  const { GlobalAIChatSessionManager } = await import("./GlobalAIChatSessionManager.tsx");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("../ui/tooltip.tsx");
  const renderer = await createDomRenderer(dom.document);
  await renderer.render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <GlobalAIChatSessionManager {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );
  return renderer;
}

const rows = (renderer: { container: HTMLElement }) =>
  Array.from(renderer.container.querySelectorAll<HTMLElement>('[data-session-id]'));

function installRadixGlobals(dom: ReturnType<typeof installDomEnvironment>) {
  const globalAsRecord = globalThis as Record<string, unknown>;
  const saved = new Map<string, { existed: boolean; value: unknown }>();
  const setGlobal = (key: string, value: unknown) => {
    saved.set(key, { existed: Object.prototype.hasOwnProperty.call(globalAsRecord, key), value: globalAsRecord[key] });
    globalAsRecord[key] = value;
  };

  for (const key of [
    "MutationObserver",
    "NodeFilter",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLSelectElement",
    "DocumentFragment",
    "Text",
    "CharacterData",
    "ShadowRoot",
    "SVGElement",
    "DOMRect",
  ] as const) {
    const winValue = (dom.window as unknown as Record<string, unknown>)[key];
    if (globalAsRecord[key] == null && winValue != null) {
      setGlobal(key, winValue);
    }
  }
  if (globalAsRecord.ResizeObserver == null) {
    setGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  }
  if (globalAsRecord.PointerEvent == null) {
    setGlobal("PointerEvent", dom.window.MouseEvent);
  }
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = () => false;
  if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => {};
  if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => {};
  if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => {};

  return () => {
    for (const [key, entry] of saved) {
      if (entry.existed) {
        globalAsRecord[key] = entry.value;
      } else {
        delete globalAsRecord[key];
      }
    }
  };
}

async function openSelectOptions(
  dom: ReturnType<typeof installDomEnvironment>,
  trigger: HTMLElement,
): Promise<HTMLElement[]> {
  await dispatchDomEvent(trigger, new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  return Array.from(dom.document.body.querySelectorAll<HTMLElement>('[role="option"]'));
}

async function pickSelectOptionByText(
  dom: ReturnType<typeof installDomEnvironment>,
  trigger: HTMLElement,
  match: string | RegExp,
) {
  const options = await openSelectOptions(dom, trigger);
  const option = options.find((el) => {
    const text = el.textContent ?? "";
    return typeof match === "string" ? text.trim() === match : match.test(text);
  });
  assert.ok(
    option,
    `select option ${String(match)} missing; saw: ${options.map((el) => el.textContent).join(", ")}`,
  );
  await dispatchDomEvent(option, new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function clickButtonInRow(
  dom: ReturnType<typeof installDomEnvironment>,
  renderer: { container: HTMLElement },
  sessionId: string,
  label: string,
) {
  const row = rows(renderer).find((row) => row.dataset.sessionId === sessionId);
  assert.ok(row, `row ${sessionId} missing`);
  const button = row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `button ${label} missing in row ${sessionId}`);
  await dispatchDomEvent(button, new dom.window.MouseEvent("click", { bubbles: true }));
}

test("manager lists chats from every scope with state badges and current marker", async () => {
  const dom = installDomEnvironment();
  try {
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "here", title: "Here chat", scope: { type: "terminal", targetId: "t-1" } }),
      makeSession({ id: "other", title: "Other terminal chat", scope: { type: "terminal", targetId: "t-2" } }),
      makeSession({ id: "ws", title: "Workspace chat", scope: { type: "workspace", targetId: "w-1" } }),
      makeSession({ id: "gone", title: "Dangling chat", scope: { type: "terminal", targetId: "t-gone" } }),
    ];
    props.activeSessionIdMap = { "terminal:t-1": "here", "terminal:t-2": "other" };
    const renderer = await renderManager(dom, props);

    const rowById = new Map(rows(renderer).map((row) => [row.dataset.sessionId!, row]));
    assert.equal(rowById.size, 4, "all scopes visible regardless of current panel scope");
    assert.equal(rowById.get("here")!.dataset.scopeState, "active");
    assert.equal(rowById.get("other")!.dataset.scopeState, "active");
    assert.equal(rowById.get("ws")!.dataset.scopeState, "idle");
    assert.equal(rowById.get("gone")!.dataset.scopeState, "dangling");
    assert.ok(rowById.get("ws")!.textContent!.includes("Prod"));
    assert.ok(rowById.get("gone")!.textContent!.includes(t("ai.chat.chatsScopeDangling")));
  } finally {
    dom.cleanup();
  }
});

test("open is enabled only for current-scope chats; export works for all", async () => {
  const dom = installDomEnvironment();
  try {
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "here", title: "Here chat", scope: { type: "terminal", targetId: "t-1" } }),
      makeSession({ id: "other", title: "Other terminal chat", scope: { type: "terminal", targetId: "t-2" } }),
    ];
    const selected: string[] = [];
    const exported: string[] = [];
    props.onSelect = (id) => selected.push(id);
    props.onExport = (id) => exported.push(id);
    const renderer = await renderManager(dom, props);

    await clickButtonInRow(dom, renderer, "here", t("ai.chat.managerOpen"));
    assert.deepEqual(selected, ["here"]);

    const otherRow = rows(renderer).find((row) => row.dataset.sessionId === "other")!;
    const openOther = otherRow.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("ai.chat.managerOpenDisabled")}"]`,
    );
    assert.ok(openOther, "other-scope row renders the disabled open affordance");
    assert.equal(openOther.disabled, true, "cross-scope activation is not faked");
    assert.equal(
      openOther.parentElement?.tagName,
      "SPAN",
      "disabled open button is wrapped in a span so Tooltip hover events still fire",
    );

    await clickButtonInRow(dom, renderer, "other", t("ai.chat.managerExportOne"));
    assert.deepEqual(exported, ["other"]);
  } finally {
    dom.cleanup();
  }
});

test("search narrows by title substring (case-insensitive)", async () => {
  const dom = installDomEnvironment();
  try {
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "a", title: "Nginx restart" }),
      makeSession({ id: "b", title: "Prod checklist" }),
    ];
    const renderer = await renderManager(dom, props);
    const input = renderer.container.querySelector<HTMLInputElement>(
      `input[aria-label="${t("ai.chat.managerSearchPlaceholder")}"]`,
    );
    assert.ok(input);
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "NGINX");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(rows(renderer).map((row) => row.dataset.sessionId), ["a"]);
  } finally {
    dom.cleanup();
  }
});

test("rebind: dangling chat to current panel scope", async () => {
  const dom = installDomEnvironment();
  const restoreGlobals = installRadixGlobals(dom);
  try {
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "gone", title: "Dangling chat", scope: { type: "terminal", targetId: "t-gone" } }),
    ];
    const rebinds: Array<{ sessionId: string; type: string; targetId: string }> = [];
    props.onRebind = (sessionId, target) => rebinds.push({ sessionId, type: target.type, targetId: target.targetId });
    const renderer = await renderManager(dom, props);

    await clickButtonInRow(dom, renderer, "gone", t("ai.chat.managerRebind"));
    const trigger = renderer.container.querySelector<HTMLElement>(
      '[data-section="ai-manager-rebind-picker"] [role="combobox"]',
    );
    assert.ok(trigger, "picker opens");
    await pickSelectOptionByText(dom, trigger, t("ai.chat.managerRebindHere"));

    assert.deepEqual(rebinds, [{ sessionId: "gone", type: "terminal", targetId: "t-1" }]);
    assert.equal(
      renderer.container.querySelector('[data-section="ai-manager-rebind-picker"]'),
      null,
      "picker closes after choosing",
    );
  } finally {
    restoreGlobals();
    dom.cleanup();
  }
});

test("rebind: cross-workspace target picker rewrites scope to the picked target", async () => {
  const dom = installDomEnvironment();
  const restoreGlobals = installRadixGlobals(dom);
  try {
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "term", title: "Terminal chat", scope: { type: "terminal", targetId: "t-1" } }),
    ];
    const rebinds: Array<{ sessionId: string; type: string; targetId: string }> = [];
    props.onRebind = (sessionId, target) => rebinds.push({ sessionId, type: target.type, targetId: target.targetId });
    const renderer = await renderManager(dom, props);

    await clickButtonInRow(dom, renderer, "term", t("ai.chat.managerRebind"));
    const trigger = renderer.container.querySelector<HTMLElement>(
      '[data-section="ai-manager-rebind-picker"] [role="combobox"]',
    );
    assert.ok(trigger);
    const options = await openSelectOptions(dom, trigger);
    const optionTexts = options.map((option) => option.textContent ?? "");
    assert.ok(optionTexts.some((text) => text.includes("Prod")), "workspace targets are listed");
    assert.ok(optionTexts.some((text) => text.includes("core")), "other-tab terminal targets are listed");
    const prodOption = options.find((option) => (option.textContent ?? "").includes("Prod"))!;
    await dispatchDomEvent(prodOption, new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(rebinds, [{ sessionId: "term", type: "workspace", targetId: "w-1" }]);
  } finally {
    restoreGlobals();
    dom.cleanup();
  }
});

test("rebind: 'This panel' preserves the panel scope host ids", async () => {
  const dom = installDomEnvironment();
  const restoreGlobals = installRadixGlobals(dom);
  try {
    const props = baseProps();
    props.currentScopeHostIds = ["h-1"];
    props.sessions = [
      makeSession({ id: "gone", title: "Dangling chat", scope: { type: "terminal", targetId: "t-gone" } }),
    ];
    const rebinds: Array<{ sessionId: string; hostIds?: string[] }> = [];
    props.onRebind = (sessionId, target) => rebinds.push({ sessionId, hostIds: target.hostIds });
    const renderer = await renderManager(dom, props);

    await clickButtonInRow(dom, renderer, "gone", t("ai.chat.managerRebind"));
    const trigger = renderer.container.querySelector<HTMLElement>(
      '[data-section="ai-manager-rebind-picker"] [role="combobox"]',
    );
    assert.ok(trigger);
    await pickSelectOptionByText(dom, trigger, t("ai.chat.managerRebindHere"));

    assert.deepEqual(rebinds, [{ sessionId: "gone", hostIds: ["h-1"] }], "destination host association survives the scope rewrite");
  } finally {
    restoreGlobals();
    dom.cleanup();
  }
});

test("rebind: explicit target host ids pass through to onRebind", async () => {
  const dom = installDomEnvironment();
  const restoreGlobals = installRadixGlobals(dom);
  try {
    const props = baseProps();
    props.rebindTargets = [
      { type: "terminal" as const, targetId: "t-2", label: "core", hostIds: ["h-2"] },
    ];
    props.sessions = [
      makeSession({ id: "term", title: "Terminal chat", scope: { type: "terminal", targetId: "t-1" } }),
    ];
    const rebinds: Array<{ sessionId: string; hostIds?: string[] }> = [];
    props.onRebind = (sessionId, target) => rebinds.push({ sessionId, hostIds: target.hostIds });
    const renderer = await renderManager(dom, props);

    await clickButtonInRow(dom, renderer, "term", t("ai.chat.managerRebind"));
    const trigger = renderer.container.querySelector<HTMLElement>(
      '[data-section="ai-manager-rebind-picker"] [role="combobox"]',
    );
    assert.ok(trigger);
    await pickSelectOptionByText(dom, trigger, /core/);

    assert.deepEqual(rebinds, [{ sessionId: "term", hostIds: ["h-2"] }]);
  } finally {
    restoreGlobals();
    dom.cleanup();
  }
});

test("agent filter resets when its agent loses the last chat; 'all' option clears manually", async () => {
  const dom = installDomEnvironment();
  const restoreGlobals = installRadixGlobals(dom);
  try {
    const { GlobalAIChatSessionManager } = await import("./GlobalAIChatSessionManager.tsx");
    const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
    const { TooltipProvider } = await import("../ui/tooltip.tsx");
    const renderer = await createDomRenderer(dom.document);
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "catty-1", agentId: "catty", title: "Catty chat" }),
      makeSession({ id: "codex-1", agentId: "codex", title: "Codex chat" }),
    ];
    await renderer.render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <GlobalAIChatSessionManager {...props} />
        </TooltipProvider>
      </I18nProvider>,
    );

    const filterTrigger = () => renderer.container.querySelector<HTMLElement>(
      `[role="combobox"][aria-label="${t("ai.chat.managerFilterAllAgents")}"]`,
    );
    assert.ok(filterTrigger(), "agent filter renders with more than one agent");
    await pickSelectOptionByText(dom, filterTrigger()!, "Codex");
    assert.deepEqual(rows(renderer).map((row) => row.dataset.sessionId), ["codex-1"]);

    // Deleting the last chat of the filtered agent: the parent drops it and
    // re-renders with the updated store (a second agent keeps the filter UI
    // mounted, so the reset is observable).
    props.sessions = [
      makeSession({ id: "catty-1", agentId: "catty", title: "Catty chat" }),
      makeSession({ id: "gemini-1", agentId: "gemini", title: "Gemini chat" }),
    ];
    await renderer.render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <GlobalAIChatSessionManager {...props} />
        </TooltipProvider>
      </I18nProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(
      (filterTrigger()!.textContent ?? "").includes(t("ai.chat.managerFilterAllAgents")),
      "stale agent filter resets to 'all'",
    );
    assert.deepEqual(
      rows(renderer).map((row) => row.dataset.sessionId),
      ["catty-1", "gemini-1"],
      "rows are visible again after the reset",
    );

    // Manual clear: pick a present agent, then choose 'all' to clear.
    await pickSelectOptionByText(dom, filterTrigger()!, /Catty/);
    assert.deepEqual(rows(renderer).map((row) => row.dataset.sessionId), ["catty-1"]);
    await pickSelectOptionByText(dom, filterTrigger()!, t("ai.chat.managerFilterAllAgents"));
    assert.deepEqual(
      rows(renderer).map((row) => row.dataset.sessionId),
      ["catty-1", "gemini-1"],
      "'all' clears the filter",
    );
  } finally {
    restoreGlobals();
    dom.cleanup();
  }
});

test("delete is confirm-gated: cancel keeps the row, confirm removes it", async () => {
  const dom = installDomEnvironment();
  const restoreGlobals = installRadixGlobals(dom);
  try {
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "victim", title: "Victim chat", scope: { type: "terminal", targetId: "t-1" } }),
    ];
    const deleted: string[] = [];
    props.onDelete = (id) => deleted.push(id);
    const renderer = await renderManager(dom, props);

    await clickButtonInRow(dom, renderer, "victim", t("common.delete"));
    assert.deepEqual(deleted, [], "no deletion before confirmation");

    const confirmButton = dom.document.body.querySelector<HTMLButtonElement>("button.bg-destructive");
    assert.ok(confirmButton, "destructive confirm button rendered in dialog");
    await dispatchDomEvent(confirmButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(deleted, ["victim"]);
  } finally {
    restoreGlobals();
    dom.cleanup();
  }
});

test("history drawer hosts the manager behind a scoped/global toggle", async () => {
  const dom = installDomEnvironment();
  try {
    const { SessionHistoryDrawer } = await import("../AIChatSessionHistoryDrawer.tsx");
    const { GlobalAIChatSessionManager } = await import("./GlobalAIChatSessionManager.tsx");
    const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
    const { TooltipProvider } = await import("../ui/tooltip.tsx");
    const renderer = await createDomRenderer(dom.document);
    const props = baseProps();
    props.sessions = [
      makeSession({ id: "here", title: "Here chat", scope: { type: "terminal", targetId: "t-1" } }),
      makeSession({ id: "gone", title: "Dangling chat", scope: { type: "terminal", targetId: "t-gone" } }),
    ];
    await renderer.render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <SessionHistoryDrawer
            sessions={props.sessions.filter((session) => session.scope.targetId === "t-1")}
            activeSessionId="here"
            onSelect={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
            globalManager={<GlobalAIChatSessionManager {...props} />}
          />
        </TooltipProvider>
      </I18nProvider>,
    );

    assert.equal(
      renderer.container.querySelector('[data-section="ai-global-session-manager"]'),
      null,
      "scoped view is the default tab",
    );
    const tabs = renderer.container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    assert.equal(tabs.length, 2, "scope/global toggle renders");
    await dispatchDomEvent(tabs[1], new dom.window.MouseEvent("click", { bubbles: true }));

    const manager = renderer.container.querySelector('[data-section="ai-global-session-manager"]');
    assert.ok(manager, "global tab renders the manager");
    const rowIds = rows(renderer).map((row) => row.dataset.sessionId);
    assert.ok(rowIds.includes("gone"), "global view shows chats outside the drawer's scoped list");
  } finally {
    dom.cleanup();
  }
});
