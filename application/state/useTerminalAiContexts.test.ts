import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAllTerminalAiInfos } from "./useTerminalAiContexts.ts";
import type { Host, TerminalSession } from "../../types";

const makeSession = (overrides: Partial<TerminalSession> & { id: string }): TerminalSession => ({
  hostId: "",
  hostLabel: "",
  username: "",
  hostname: "host.example",
  status: "connected",
  ...overrides,
} as TerminalSession);

const makeHost = (overrides: Partial<Host> & { id: string }): Host => ({
  label: overrides.id,
  hostname: `${overrides.id}.example`,
  ...overrides,
} as Host);

test("buildAllTerminalAiInfos lists every live terminal, including those without a mounted AI context", () => {
  // t-1 belongs to a tab with a mounted AI panel context; t-2's tab never
  // mounted one. Both must appear so the global session manager offers t-2
  // as a rebind target (rebinding creates the association on demand).
  const sessionHostsMap = new Map([
    ["t-1", makeHost({ id: "h-1" })],
  ]);
  const infos = buildAllTerminalAiInfos(
    [makeSession({ id: "t-1", hostId: "h-1" }), makeSession({ id: "t-2", hostId: "h-2", customName: "core" })],
    sessionHostsMap,
    [makeHost({ id: "h-1" })],
    [],
    "linux",
  );

  assert.deepEqual(infos.map((info) => info.sessionId), ["t-1", "t-2"]);
  const contextless = infos.find((info) => info.sessionId === "t-2")!;
  assert.equal(contextless.hostId, "h-2", "context-less terminal keeps its host linkage for the rebind");
  assert.equal(contextless.label, "core");
  assert.equal(contextless.connected, true);
});

test("buildAllTerminalAiInfos skips id-less entries and dedupes session ids", () => {
  const infos = buildAllTerminalAiInfos(
    [
      makeSession({ id: "t-1" }),
      makeSession({ id: "t-1", hostId: "h-9" }),
      makeSession({ id: "", hostId: "h-3" }),
    ],
    new Map(),
    [],
    [],
    "linux",
  );
  assert.deepEqual(infos.map((info) => info.sessionId), ["t-1"]);
});

test("AIChatPanelsHost receives store-derived terminal infos instead of deriving them from mounted AI contexts", () => {
  const supportSource = readFileSync(
    new URL("../../components/terminalLayer/TerminalLayerSupport.tsx", import.meta.url),
    "utf8",
  );
  assert.match(supportSource, /appTerminalSessions=\{appTerminalSessions\}/);
  assert.doesNotMatch(
    supportSource,
    /for \(const context of contextsByTabId\.values\(\)\)/,
    "rebind targets must not be limited to tabs with a mounted AI context",
  );

  const bridgeSource = readFileSync(
    new URL("../../components/terminalLayer/TerminalLayerTabBridge.tsx", import.meta.url),
    "utf8",
  );
  assert.match(bridgeSource, /appTerminalInfos/);
});
