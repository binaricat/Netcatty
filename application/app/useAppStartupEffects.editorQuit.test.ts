import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppStartupEffects } from "./useAppStartupEffects.ts";
import { editorTabStore } from "../state/editorTabStore.ts";
import { popOutEditorTab } from "../state/editorWindowClient.ts";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge.ts";
import { toast } from "../../components/ui/toast.tsx";

test("app Quit sees the source's unsaved contents until the detached receiver accepts them", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  let renderer: ReactTestRenderer | undefined;
  const editorId = "quit-during-editor-handoff";
  t.after(async () => {
    await act(async () => renderer?.unmount());
    editorTabStore.close(editorId);
    if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  let query!: () => Promise<void>;
  let accept!: (result: { success: boolean }) => void;
  const receipt = new Promise<{ success: boolean }>((resolve) => { accept = resolve; });
  const reports: boolean[] = [];
  t.mock.method(toast, "warning", () => {});
  t.mock.method(netcattyBridge, "get", () => ({
    openEditorWindow: () => receipt,
    onCheckDirtyEditors: (callback: typeof query) => { query = callback; return () => {}; },
    reportDirtyEditorsResult: (dirty: boolean) => reports.push(dirty),
  }));
  function SourceWindow() {
    useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(SourceWindow)); });
  editorTabStore.upsertFromSnapshot({ editorId, sessionId: "source", sftpTabId: "sftp", hostId: "fixture", remotePath: "/alpha.txt", fileName: "alpha.txt", languageId: "plaintext", content: "unsaved", baselineContent: "original", wordWrap: false, viewState: null });
  const opening = popOutEditorTab(editorId);
  assert.equal(editorTabStore.getTab(editorId)?.placement, "window");
  await query();
  assert.deepEqual(reports, [true], "a cold receiver must not make the only owned unsaved copy invisible to Quit");
  accept({ success: true });
  assert.equal(await opening, true);
  assert.equal(editorTabStore.getTab(editorId)?.content, "");
  await query();
  assert.deepEqual(reports, [true, false], "after receipt the destination owns dirty reporting; the source copy is released");
});
