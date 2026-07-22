import test from "node:test";
import assert from "node:assert/strict";

import type { TerminalSession } from "../domain/models";
import {
  buildAiSilentSessionPopupPayload,
  handleTrayJumpToSessionImpl,
} from "./app/AppHandlers";

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: "session-1",
  hostId: "host-1",
  hostLabel: "AI Box",
  hostname: "10.0.0.1",
  username: "root",
  status: "connected",
  protocol: "ssh",
  port: 22,
  ...overrides,
});

test("buildAiSilentSessionPopupPayload attaches the same live session PTY", () => {
  const payload = buildAiSilentSessionPopupPayload(
    session({ hiddenFromTabs: true }),
  );

  assert.equal(payload.parentSessionId, "session-1");
  assert.equal(payload.attachSessionId, "session-1");
  assert.equal(payload.title, "AI Box");
  assert.equal(payload.startupCommand, "");
  assert.equal(payload.sourceSession.hiddenFromTabs, undefined);
  assert.equal(payload.sourceSession.reuseConnectionFromSessionId, undefined);
});

test("handleTrayJumpToSessionImpl opens a terminal popup for AI silent sessions", async () => {
  const opened: unknown[] = [];
  let activeTabId = "session-1";

  await handleTrayJumpToSessionImpl(
    () => ({
      sessions: [session({ hiddenFromTabs: true })],
      setActiveTabId: (id: string) => {
        activeTabId = id;
      },
      getActiveTabId: () => activeTabId,
      setWorkspaceFocusedSession: () => {
        throw new Error("should not focus workspace for silent sessions");
      },
      netcattyBridge: {
        get: () => ({
          openTerminalPopup: async (payload: unknown) => {
            opened.push(payload);
            return { success: true, popupId: "popup-1" };
          },
        }),
      },
    }),
    "session-1",
  );

  assert.equal(opened.length, 1);
  assert.equal(activeTabId, "vault");
  assert.deepEqual(opened[0], buildAiSilentSessionPopupPayload(session({ hiddenFromTabs: true })));
});

test("handleTrayJumpToSessionImpl still activates normal solo sessions in the main window", async () => {
  let activeTabId = "vault";
  let openedMain = 0;

  await handleTrayJumpToSessionImpl(
    () => ({
      sessions: [session()],
      setActiveTabId: (id: string) => {
        activeTabId = id;
      },
      setWorkspaceFocusedSession: () => {
        throw new Error("solo sessions should not use workspace focus");
      },
      netcattyBridge: {
        get: () => ({
          openMainWindow: async () => {
            openedMain += 1;
            return { success: true };
          },
          openTerminalPopup: async () => {
            throw new Error("should not open popup for visible sessions");
          },
        }),
      },
    }),
    "session-1",
  );

  assert.equal(activeTabId, "session-1");
  assert.equal(openedMain, 1);
});

test("handleTrayJumpToSessionImpl focuses workspace sessions without opening a popup", async () => {
  let activeTabId = "vault";
  let focused: { workspaceId: string; sessionId: string } | null = null;
  let openedMain = 0;

  await handleTrayJumpToSessionImpl(
    () => ({
      sessions: [session({ workspaceId: "ws-1" })],
      setActiveTabId: (id: string) => {
        activeTabId = id;
      },
      setWorkspaceFocusedSession: (workspaceId: string, sessionId: string) => {
        focused = { workspaceId, sessionId };
      },
      netcattyBridge: {
        get: () => ({
          openMainWindow: async () => {
            openedMain += 1;
            return { success: true };
          },
          openTerminalPopup: async () => {
            throw new Error("should not open popup for workspace sessions");
          },
        }),
      },
    }),
    "session-1",
  );

  assert.equal(activeTabId, "ws-1");
  assert.equal(openedMain, 1);
  assert.deepEqual(focused, { workspaceId: "ws-1", sessionId: "session-1" });
});
