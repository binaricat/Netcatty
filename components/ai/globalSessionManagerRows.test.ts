import assert from "node:assert/strict";
import test from "node:test";

import type { AISession } from "../../infrastructure/ai/types.ts";
import {
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

test("global rows cover every scope: live terminal, other terminal, workspace, dangling, global", () => {
  const input = baseInput();
  input.sessions = [
    baseSession({ id: "s-term", title: "Terminal chat", scope: { type: "terminal", targetId: "t-1" } }),
    baseSession({ id: "s-other", title: "Other terminal chat", scope: { type: "terminal", targetId: "t-2" } }),
    baseSession({ id: "s-ws", title: "Workspace chat", scope: { type: "workspace", targetId: "w-1" } }),
    baseSession({ id: "s-dangling", title: "Dangling chat", scope: { type: "terminal", targetId: "t-gone" } }),
    baseSession({ id: "s-ws-gone", title: "Dangling ws chat", scope: { type: "workspace", targetId: "w-gone" } }),
    baseSession({ id: "s-global", title: "Global chat", scope: { type: "global" } }),
  ];
  const rows = buildGlobalManagerRows(input);
  assert.equal(rows.length, 6);
  const byId = new Map(rows.map((row) => [row.session.id, row]));

  assert.equal(byId.get("s-term")!.scopeState, "idle");
  assert.ok(byId.get("s-term")!.scopeLabel.includes("edge"));
  assert.equal(byId.get("s-term")!.canActivate, true);

  assert.equal(byId.get("s-other")!.scopeState, "idle");
  assert.ok(byId.get("s-other")!.scopeLabel.includes("core"));
  // Bound to another open terminal: live, but not activatable here.
  assert.equal(byId.get("s-other")!.canActivate, false);

  assert.equal(byId.get("s-ws")!.scopeState, "idle");
  assert.ok(byId.get("s-ws")!.scopeLabel.includes("Prod"));
  assert.equal(byId.get("s-ws")!.canActivate, false);

  assert.equal(byId.get("s-dangling")!.scopeState, "dangling");
  assert.equal(byId.get("s-ws-gone")!.scopeState, "dangling");
  assert.equal(byId.get("s-global")!.scopeState, "idle");
  assert.equal(byId.get("s-global")!.scopeLabel, t("ai.chat.chatsScopeGlobal"));
});

test("active marker follows activeSessionIdMap across scopes", () => {
  const input = baseInput();
  input.sessions = [
    baseSession({ id: "s-active-here", scope: { type: "terminal", targetId: "t-1" } }),
    baseSession({ id: "s-active-elsewhere", scope: { type: "terminal", targetId: "t-2" } }),
    baseSession({ id: "s-idle", scope: { type: "terminal", targetId: "t-1" } }),
  ];
  input.activeSessionIdMap = { "terminal:t-1": "s-active-here", "terminal:t-2": "s-active-elsewhere" };
  const rows = buildGlobalManagerRows(input);
  const byId = new Map(rows.map((row) => [row.session.id, row]));
  assert.equal(byId.get("s-active-here")!.scopeState, "active");
  assert.equal(byId.get("s-active-elsewhere")!.scopeState, "active");
  assert.equal(byId.get("s-idle")!.scopeState, "idle");
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
