import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSessionState } from "../../application/state/useSessionState";
import { createPromptHostnameSessionSignalController } from "../../application/state/promptHostnameSessionSignalController";
import { sessionPresentationStore } from "../../application/state/sessionPresentationStore";
import { extractTerminalPromptHostname } from "../../domain/terminalPromptSecurity";
import type { DynamicTabTitleMode, Host, TerminalSession, Workspace } from "../../domain/models";
import { SessionTopTab, WorkspaceTopTab } from "../../components/top-tabs/TopTabItems";
import { TooltipProvider } from "../../components/ui/tooltip";

const hosts: Host[] = [
  { id: "production", label: "\u751f\u4ea7", hostname: "203.0.113.10", username: "fixture", port: 22, protocol: "ssh", os: "linux", tags: [] },
  { id: "database", label: "Database", hostname: "198.51.100.20", username: "fixture", port: 22, protocol: "ssh", os: "linux", tags: [] },
  { id: "jump", label: "Jump fleet", hostname: "jump.example.test", username: "fixture", port: 22, protocol: "ssh", os: "linux", tags: [] },
];
const noop = () => {};
type SessionState = ReturnType<typeof useSessionState>;
let state: SessionState;
let setMode: React.Dispatch<React.SetStateAction<DynamicTabTitleMode | undefined>>;
let setRevision: React.Dispatch<React.SetStateAction<number>>;
let revision = 0;
let fixtureRenderCount = 0;

function workspace(id: string, sessions: TerminalSession[], title: string, autoTitle: boolean, generatedTitle = false): Workspace {
  return {
    id, title, autoTitle, generatedTitle, focusedSessionId: sessions[0].id,
    root: { id: `${id}-root`, type: "split", direction: "vertical", children: sessions.map(session => ({ id: `${id}-${session.id}`, type: "pane", sessionId: session.id })) },
  };
}

function Fixture() {
  fixtureRenderCount += 1;
  state = useSessionState({ persistSessionRestore: false });
  const [mode, updateMode] = useState<DynamicTabTitleMode>();
  const [commit, updateRevision] = useState(0);
  setMode = updateMode;
  setRevision = updateRevision;
  const members = state.sessions.slice(0, 2);
  const shared = {
    isBeingDragged: false, isDraggingForReorder: false, shiftStyle: {},
    showDropIndicatorBefore: false, showDropIndicatorAfter: false,
    onTabDragStart: noop, onTabDragEnd: noop, onTabDragOver: noop, onTabDragLeave: noop, onTabDrop: noop,
    tabDoubleClickBehavior: "disabled" as const, dynamicTabTitleMode: mode,
    renderBulkCloseItems: () => null, t: (key: string) => key,
  };
  const workspaces = members.length === 2 ? [
    workspace("auto", members, "Workspace", true),
    workspace("generated", members, members.map(session => session.hostLabel).join("/"), false, true),
    workspace("explicit", members, "My Cluster", false),
  ] : [];
  return <TooltipProvider>
    <main data-fixture-commit={commit}>
      <h1>Production SSH tab title policy</h1>
      <section aria-label="Session tabs" style={{ display: "flex", gap: 8 }}>
        {state.sessions.map(session => <SessionTopTab key={session.id} {...shared}
          session={session} host={hosts.find(host => host.id === session.hostId)}
          onCloseSession={noop} onRenameSession={state.startSessionRename}
          onCopySession={noop} onCopySessionToNewWindow={noop} />)}
      </section>
      <section aria-label="Workspace tabs" style={{ display: "flex", gap: 8, marginTop: 16 }}>
        {workspaces.map(item => <WorkspaceTopTab key={item.id} {...shared}
          workspace={item} workspaceSessions={members} workspaceSessionIds={members.map(session => session.id)}
          paneCount={members.length} isHostDropTarget={false}
          onRenameWorkspace={noop} onCopyWorkspace={noop} onCloseWorkspace={noop} />)}
      </section>
    </main>
  </TooltipProvider>;
}

function waitForCommit(expected: number): Promise<void> {
  const ready = () => document.querySelector(`[data-fixture-commit="${expected}"]`) !== null;
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`React commit ${expected} was not observed within 60 seconds`));
    }, 60_000);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  });
}

async function change(action: () => void): Promise<void> {
  revision += 1;
  flushSync(() => { action(); setRevision(revision); });
  await waitForCommit(revision);
}

export type TitleMeasurement = { scenario: string; tabId: string; actual: string; expected: string };

function titleSpan(tabId: string): Element {
  const span = document.querySelector(`[data-tab-id="${tabId}"] span.truncate.leading-5`);
  if (!span) throw new Error(`Missing production title span for ${tabId}`);
  return span;
}

function title(tabId: string): string {
  return titleSpan(tabId).textContent ?? "";
}

function waitForTitleMutation(tabId: string, action: () => void): Promise<void> {
  const span = titleSpan(tabId);
  const before = span.textContent;
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (span.textContent === before) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Production title ${tabId} did not mutate after a store-only update within 60 seconds`));
    }, 60_000);
    observer.observe(span, { characterData: true, childList: true, subtree: true });
    try { action(); } catch (error) {
      observer.disconnect();
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function promptHost(prompt: string): string {
  const hostname = extractTerminalPromptHostname(prompt);
  if (!hostname) throw new Error(`Fixture prompt was not parsed: ${JSON.stringify(prompt)}`);
  return hostname;
}

export async function runSshTabTitlePolicy(): Promise<{ rows: TitleMeasurement[]; promptOnlyParentRenders: number }> {
  const node = document.getElementById("root");
  if (!node) throw new Error("Missing fixture root");
  const root = createRoot(node);
  const rows: TitleMeasurement[] = [];
  const record = (scenario: string, tabId: string, expected: string) => {
    rows.push({ scenario, tabId, actual: title(tabId), expected });
  };
  const controller = createPromptHostnameSessionSignalController({
    getSession: id => state.sessions.find(session => session.id === id),
    onChange: (id, hostname) => state.updateSessionPromptHost(id, hostname),
  });
  let first = "";
  let second = "";
  let jump = "";
  try {
    flushSync(() => root.render(<Fixture />));
    await waitForCommit(0);
    await change(() => {
      first = state.connectToHost(hosts[0]);
      second = state.connectToHost(hosts[1]);
    });
    await change(() => {
      state.updateSessionStatus(first, "connected");
      state.updateSessionStatus(second, "connected");
    });
    record("initial saved host name", first, hosts[0].label);
    const firstPrompt = "[fixture@VM-0-8-centos ~]# ";
    const secondPrompt = "[fixture@db-target ~]# ";
    const firstObserved = promptHost(firstPrompt);
    const secondObserved = promptHost(secondPrompt);
    await change(() => {
      controller.handleTerminalOutput(first, firstPrompt);
      controller.handleTerminalOutput(second, secondPrompt);
    });
    // Do not call the title resolver for expectations: names come from the
    // saved host entities; dynamic hostnames come from the prompt parser.
    const recordGroup = (scenario: string, firstName: string, secondName: string) => {
      record(scenario, first, firstName);
      record(scenario, second, secondName);
      record(scenario, "auto", `${firstName} +1`);
      record(scenario, "generated", `${firstName}/${secondName}`);
      record(scenario, "explicit", "My Cluster");
    };
    for (const mode of [undefined, "off", "agent", "all"] as const) {
      await change(() => setMode(mode));
      recordGroup(`ordinary SSH mode=${mode ?? "default"}`,
        mode === "all" ? firstObserved : hosts[0].label,
        mode === "all" ? secondObserved : hosts[1].label);
    }
    const updatedPrompt = "[fixture@production-next ~]# ";
    const parentRendersBefore = fixtureRenderCount;
    // This action deliberately bypasses change(), setRevision and flushSync:
    // only the production store subscriptions may update these mounted tabs.
    await waitForTitleMutation(first, () => controller.handleTerminalOutput(first, `\r\n${updatedPrompt}`));
    const promptOnlyParentRenders = fixtureRenderCount - parentRendersBefore;
    recordGroup("all-mode prompt-only store subscription", promptHost(updatedPrompt), secondObserved);
    const agentTitle = "claude: deploy";
    await change(() => {
      state.updateSessionCodingCliProvider(first, "claude");
      state.updateSessionDynamicTitle(first, agentTitle);
    });
    for (const mode of ["off", "agent", "all"] as const) {
      await change(() => setMode(mode));
      recordGroup(`Agent title mode=${mode}`, mode === "off" ? hosts[0].label : agentTitle,
        mode === "all" ? secondObserved : hosts[1].label);
    }
    const manualName = "Manual production";
    await change(() => state.submitSessionRename(first, manualName));
    for (const mode of ["off", "agent", "all"] as const) {
      await change(() => setMode(mode));
      const renamed = state.sessions.find(session => session.id === first);
      if (!renamed?.customName) throw new Error("Production rename hook did not set customName");
      recordGroup(`manual title mode=${mode}`, renamed.customName,
        mode === "all" ? secondObserved : hosts[1].label);
    }
    await change(() => { jump = state.connectToHost(hosts[2]); setMode("all"); });
    await change(() => state.updateSessionStatus(jump, "connected"));
    const targetPrompt = "[fixture@app-target ~]# ";
    const targetObserved = promptHost(targetPrompt);
    await change(() => controller.handleTerminalOutput(jump, targetPrompt));
    record("JumpServer first output is target", jump, targetObserved);
    for (const mode of ["off", "agent", "all"] as const) {
      await change(() => setMode(mode));
      record(`JumpServer direct target mode=${mode}`, jump, mode === "all" ? targetObserved : hosts[2].label);
    }
    for (const menu of ["Opt> ", "[Host]> ", "\x1b[32mOpt> \x1b[0m"]) {
      await change(() => controller.handleTerminalOutput(jump, `\r\nlogout\r\n${menu}`));
      record(`JumpServer return to menu ${JSON.stringify(menu)}`, jump, hosts[2].label);
      await change(() => controller.handleTerminalOutput(jump, `\r\n${targetPrompt}`));
      record("JumpServer re-enter target", jump, targetObserved);
    }
    await change(() => controller.handleTerminalOutput(jump, "\r\nOpt> "));
    await change(() => state.updateSessionStatus(jump, "disconnected"));
    await change(() => { state.updateSessionStatus(jump, "connecting"); setMode("off"); });
    record("same-session reconnect preserves saved name in off", jump, hosts[2].label);
    await change(() => { state.updateSessionStatus(jump, "connected"); setMode("all"); });
    await change(() => controller.handleTerminalOutput(jump, `\r\n${targetPrompt}`));
    record("first target after reconnect is observed again", jump, targetObserved);
    return { rows, promptOnlyParentRenders };
  } finally {
    flushSync(() => root.unmount());
    for (const id of [first, second, jump]) {
      if (id) { controller.forgetSession(id); sessionPresentationStore.clearSession(id); }
    }
  }
}
