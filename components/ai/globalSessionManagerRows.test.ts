import assert from "node:assert/strict";
import test from "node:test";

import type { AISession } from "../../infrastructure/ai/types.ts";
import {
  buildGlobalManagerRebindTargets,
  buildGlobalManagerRows,
  collectGlobalManagerAgentIds,
  filterGlobalManagerRows,
} from "./globalSessionManagerRows.ts";
import { getLoadedLocaleMessages, loadLocaleMessages } from "../../application/i18n/messages.ts";

await loadLocaleMessages("en");
const enMessages = getLoadedLocaleMessages("en")!;
const t = (key: string) => {
  const hit = enMessages[key as keyof typeof enMessages];
  return typeof hit === "string" ? hit : key;
};

const baseSession = (overrides: Partial<AISession>): AISession => ({
  id: "s-1",
  title: "Chat",
  agentId: "catty",
  scope: { type: "terminal", targetId: "t-1" },
  messages: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
} as AISession);

const externalAgents = [
  { id: "codex", name: "Codex" },
] as never[];

const baseInput = () => ({
  sessions: [] as AISession[],
  activeSessionIdMap: {} as Record<string, string | null>,
  currentScopeType: "terminal" as const,
  currentScopeTargetId: "t-1",
  workspaces: [{ id: "w-1", title: "Prod" }],
  terminalInfos: [
    { sessionId: "t-1", hostId: "h-1", label: "edge", hostname: "edge.example", connected: true },
    { sessionId: "t-2", hostId: "h-2", label: "core", hostname: "core.example", connected: true },
  ],
  externalAgents,
  t,
});

test("global rows cover every scope: live terminal, other terminal, workspace, closed/dangling with host fallback, global", () => {
  const input = {
    ...baseInput(),
    hosts: [
      { id: "h-1", label: "edge", hostname: "edge.example" },
      { id: "h-old", label: "prod-web-01", hostname: "10.0.0.5" },
    ],
  };
  input.sessions = [
    baseSession({ id: "s-term", title: "Terminal chat", scope: { type: "terminal", targetId: "t-1" } }),
    baseSession({ id: "s-other", title: "Other terminal chat", scope: { type: "terminal", targetId: "t-2" } }),
    baseSession({ id: "s-ws", title: "Workspace chat", scope: { type: "workspace", targetId: "w-1" } }),
    baseSession({ id: "s-dangling-host", title: "Past host chat", scope: { type: "terminal", targetId: "t-gone", hostIds: ["h-old"] } }),
    baseSession({ id: "s-dangling", title: "Dangling chat", scope: { type: "terminal", targetId: "t-gone" } }),
    baseSession({ id: "s-ws-gone", title: "Dangling ws chat", scope: { type: "workspace", targetId: "w-gone" } }),
    baseSession({ id: "s-global", title: "Global chat", scope: { type: "global" } }),
  ];
  const rows = buildGlobalManagerRows(input);
  assert.equal(rows.length, 7);
  const byId = new Map(rows.map((row) => [row.session.id, row]));

  assert.equal(byId.get("s-term")!.scopeState, "idle");
  assert.equal(byId.get("s-term")!.scopeLabel, "edge");
  assert.equal(byId.get("s-term")!.isCurrentView, true);
  assert.equal(byId.get("s-term")!.canActivate, true);

  assert.equal(byId.get("s-other")!.scopeState, "idle");
  assert.equal(byId.get("s-other")!.scopeLabel, "core");
  assert.equal(byId.get("s-other")!.isCurrentView, false);
  // Every chat is directly openable when the viewing panel has a live scope target.
  assert.equal(byId.get("s-other")!.canActivate, true);

  assert.equal(byId.get("s-ws")!.scopeState, "idle");
  assert.equal(byId.get("s-ws")!.scopeLabel, "Prod");
  assert.equal(byId.get("s-ws")!.canActivate, true);

  // Past/closed terminal chats show their original host label instead of "Detached".
  assert.equal(byId.get("s-dangling-host")!.scopeState, "dangling");
  assert.equal(byId.get("s-dangling-host")!.scopeLabel, "prod-web-01");
  assert.equal(byId.get("s-dangling-host")!.canActivate, true);

  // Without a known host, leave scopeLabel empty rather than showing technical jargon.
  assert.equal(byId.get("s-dangling")!.scopeState, "dangling");
  assert.equal(byId.get("s-dangling")!.scopeLabel, "");
  assert.equal(byId.get("s-ws-gone")!.scopeState, "dangling");
  assert.equal(byId.get("s-ws-gone")!.scopeLabel, "");
  assert.equal(byId.get("s-global")!.scopeState, "idle");
  assert.equal(byId.get("s-global")!.scopeLabel, t("ai.chat.chatsScopeGlobal"));
});

test("active marker distinguishes current panel active chat vs active elsewhere", () => {
  const input = baseInput();
  input.sessions = [
    baseSession({ id: "s-active-here", scope: { type: "terminal", targetId: "t-1" } }),
    baseSession({ id: "s-active-elsewhere", scope: { type: "terminal", targetId: "t-2" } }),
    baseSession({ id: "s-active-workspace", scope: { type: "workspace", targetId: "w-1" } }),
    baseSession({ id: "s-stale-active", scope: { type: "terminal", targetId: "t-dead" } }),
    baseSession({ id: "s-idle", scope: { type: "terminal", targetId: "t-1" } }),
  ];
  input.activeSessionIdMap = {
    "terminal:t-1": "s-active-here",
    "terminal:t-2": "s-active-elsewhere",
    "workspace:w-1": "s-active-workspace",
    "terminal:t-dead": "s-stale-active",
  };
  const rows = buildGlobalManagerRows(input);
  const byId = new Map(rows.map((row) => [row.session.id, row]));
  assert.equal(byId.get("s-active-here")!.scopeState, "active");
  assert.equal(byId.get("s-active-here")!.isCurrentActive, true);
  assert.equal(byId.get("s-active-here")!.isActiveElsewhere, false);
  assert.equal(byId.get("s-active-here")!.activeElsewhereTarget, null);
  assert.equal(byId.get("s-active-elsewhere")!.scopeState, "active");
  assert.equal(byId.get("s-active-elsewhere")!.isCurrentActive, false);
  assert.equal(byId.get("s-active-elsewhere")!.isActiveElsewhere, true);
  assert.deepEqual(byId.get("s-active-elsewhere")!.activeElsewhereTarget, { type: "terminal", targetId: "t-2" });
  assert.equal(byId.get("s-active-workspace")!.scopeState, "active");
  assert.equal(byId.get("s-active-workspace")!.isActiveElsewhere, true);
  assert.deepEqual(byId.get("s-active-workspace")!.activeElsewhereTarget, { type: "workspace", targetId: "w-1" });
  // Stale active map entries for closed scopes must not mark a past chat as active elsewhere.
  assert.equal(byId.get("s-stale-active")!.scopeState, "dangling");
  assert.equal(byId.get("s-stale-active")!.isActiveElsewhere, false);
  assert.equal(byId.get("s-stale-active")!.activeElsewhereTarget, null);
  assert.equal(byId.get("s-idle")!.scopeState, "idle");
  assert.equal(byId.get("s-idle")!.isCurrentActive, false);
  assert.equal(byId.get("s-idle")!.isActiveElsewhere, false);
  assert.equal(byId.get("s-idle")!.activeElsewhereTarget, null);
});

test("workspace member and hidden terminal active pointers are not treated as jumpable elsewhere panels", () => {
  const input = baseInput();
  input.terminalInfos = [
    ...input.terminalInfos,
    { sessionId: "t-member", hostId: "h-3", label: "member", hostname: "member.example", connected: true, workspaceId: "w-1" },
    { sessionId: "t-hidden", hostId: "h-4", label: "popout", hostname: "popout.example", connected: true, hiddenFromTabs: true },
  ];
  input.sessions = [
    baseSession({ id: "s-ws-active", scope: { type: "workspace", targetId: "w-1" } }),
    baseSession({ id: "s-member-retained", scope: { type: "terminal", targetId: "t-member" } }),
    baseSession({ id: "s-hidden-active", scope: { type: "terminal", targetId: "t-hidden" } }),
  ];
  input.activeSessionIdMap = {
    "workspace:w-1": "s-ws-active",
    "terminal:t-member": "s-member-retained",
    "terminal:t-hidden": "s-hidden-active",
  };
  const rows = buildGlobalManagerRows(input);
  const byId = new Map(rows.map((row) => [row.session.id, row]));

  assert.equal(byId.get("s-ws-active")!.isActiveElsewhere, true);
  assert.deepEqual(byId.get("s-ws-active")!.activeElsewhereTarget, { type: "workspace", targetId: "w-1" });

  assert.equal(byId.get("s-member-retained")!.isActiveElsewhere, false);
  assert.equal(byId.get("s-member-retained")!.activeElsewhereTarget, null);
  assert.equal(byId.get("s-member-retained")!.scopeState, "idle");

  assert.equal(byId.get("s-hidden-active")!.isActiveElsewhere, false);
  assert.equal(byId.get("s-hidden-active")!.activeElsewhereTarget, null);
  assert.equal(byId.get("s-hidden-active")!.scopeState, "idle");
});

test("rows sort by updatedAt descending and carry agent labels + counts", () => {
  const input = baseInput();
  input.sessions = [
    baseSession({ id: "old", updatedAt: 1_000, messages: [{ id: "m1", role: "user", timestamp: 0, content: "a" }] }),
    baseSession({ id: "new", updatedAt: 2_000, agentId: "codex", messages: [{ id: "m1", role: "user", timestamp: 0, content: "a" }, { id: "m2", role: "assistant", timestamp: 1, content: "b" }] }),
  ] as AISession[];
  const rows = buildGlobalManagerRows(input);
  assert.deepEqual(rows.map((row) => row.session.id), ["new", "old"]);
  assert.equal(rows[0].agentLabel, "Codex");
  assert.equal(rows[0].messageCount, 2);
});

test("filter: title substring is case-insensitive; agent filter narrows; order preserved", () => {
  const input = baseInput();
  input.sessions = [
    baseSession({ id: "a", title: "Nginx restart", agentId: "catty", updatedAt: 3_000 }),
    baseSession({ id: "b", title: "Prod checklist", agentId: "codex", updatedAt: 2_000 }),
    baseSession({ id: "c", title: "nginx tuning", agentId: "codex", updatedAt: 1_000 }),
  ] as AISession[];
  const rows = buildGlobalManagerRows(input);

  const byTitle = filterGlobalManagerRows(rows, { query: "NGINX", agentId: "all" });
  assert.deepEqual(byTitle.map((row) => row.session.id), ["a", "c"]);

  const byAgent = filterGlobalManagerRows(rows, { query: "", agentId: "codex" });
  assert.deepEqual(byAgent.map((row) => row.session.id), ["b", "c"]);

  const both = filterGlobalManagerRows(rows, { query: "checklist", agentId: "catty" });
  assert.deepEqual(both.map((row) => row.session.id), []);

  assert.deepEqual(collectGlobalManagerAgentIds(rows), ["catty", "codex"]);
});

test("rebind targets carry deduplicated member host IDs for workspaces and terminals", () => {
  const targets = buildGlobalManagerRebindTargets(
    [
      { id: "w-1", title: "Prod", hostIds: ["h-1", "h-2", "h-1", ""] },
      { id: "w-empty", title: "Empty" },
    ],
    [
      { sessionId: "t-1", hostId: "h-1", label: "edge", hostname: "edge.example", connected: true },
      { sessionId: "t-local", hostId: "", label: "Local", hostname: "localhost", connected: true },
    ],
  );
  assert.deepEqual(targets, [
    { type: "workspace", targetId: "w-1", label: "Prod", hostIds: ["h-1", "h-2"] },
    { type: "workspace", targetId: "w-empty", label: "Empty", hostIds: undefined },
    { type: "terminal", targetId: "t-1", label: "edge", hostIds: ["h-1"] },
    { type: "terminal", targetId: "t-local", label: "Local", hostIds: undefined },
  ]);
});
