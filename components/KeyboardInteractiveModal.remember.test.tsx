import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { Host, Identity } from "../types";
import { handleKeyboardInteractiveSubmitImpl } from "../application/app/AppHandlers";
import { createTerminalSessionStarters } from "./terminal/runtime/createTerminalSessionStarters";
import { createPromptLineBreakState } from "./terminal/runtime/promptLineBreak";
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from "./test-support/renderReactDom";

const noop = () => {};

test("KI remember input preserves the reconnect account and leaves shared hosts unchanged", async (t) => {
  const dom = installDomEnvironment();
  const globals = {
    MutationObserver: dom.window.MutationObserver,
    NodeFilter: dom.window.NodeFilter,
    HTMLInputElement: dom.window.HTMLInputElement,
    localStorage: dom.window.localStorage,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { KeyboardInteractiveModal } = await import("./KeyboardInteractiveModal");
  const { I18nProvider } = await import("../application/i18n/I18nProvider");
  const renderer = await createDomRenderer(dom.document);
  try {
    for (const scenario of [
      { name: "differing usernames", hostUsername: "old-account", identityUsername: "fixtureki", remember: true },
      { name: "blank host username", hostUsername: "", identityUsername: "fixtureki", remember: true },
      { name: "blank identity username", hostUsername: "fixtureki", identityUsername: "  ", remember: true },
      { name: "no identity", hostUsername: "fixtureki", identityUsername: undefined, remember: true },
      { name: "remember unchecked", hostUsername: "old-account", identityUsername: "fixtureki", remember: false },
      { name: "secondary password", hostUsername: "old-account", identityUsername: "fixtureki", remember: true, allowSavePassword: false },
    ]) {
      await t.test(scenario.name, async () => {
        const identity: Identity = {
          id: "shared", label: "Fixture", username: scenario.identityUsername ?? "",
          authMethod: "password", password: "fixture-old", created: 0,
        };
        const identities = scenario.identityUsername === undefined ? [] : [identity];
        const originalIdentity = { ...identity };
        const host: Host = {
          id: "changed", label: "Fixture", hostname: "127.0.0.1", username: scenario.hostUsername,
          tags: [], os: "linux", protocol: "ssh", authMethod: "password",
          password: "fixture-host-old", savePassword: false,
          ...(identities.length ? { identityId: identity.id } : {}),
        };
        const otherHost = { ...host, id: "unchanged", label: "Other fixture" };
        let hosts = [host, otherHost];
        let updates = 0;
        const request = {
          requestId: `ki-${scenario.name}`, sessionId: "fixture-session", hostname: host.hostname,
          name: "Password expiry", instructions: "", prompts: [{ prompt: "New password:", echo: false }],
          allowSavePassword: scenario.allowSavePassword ?? true,
        };
        let queue = [request];
        const responses: unknown[][] = [];
        await renderer.render(
          <I18nProvider locale="en">
            <KeyboardInteractiveModal request={request} onCancel={() => false}
              onSubmit={(requestId, values, savePassword) => handleKeyboardInteractiveSubmitImpl(() => ({
                hosts, identities, keyboardInteractiveQueue: queue,
                sessions: [{ id: "fixture-session", hostId: host.id, hostname: host.hostname }],
                netcattyBridge: { get: () => ({ respondKeyboardInteractive: (...args: unknown[]) => {
                  responses.push(args);
                  return { success: true };
                } }) },
                setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => { queue = updater(queue); },
                updateHosts: (next: Host[]) => { updates += 1; hosts = next; },
                t: (key: string) => key, toast: { error: (message: string) => assert.fail(message) },
              }), requestId, values, savePassword)} />
          </I18nProvider>,
        );
        const input = dom.document.querySelector<HTMLInputElement>("#ki-prompt-0");
        assert.ok(input);
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-new");
        await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
        const checkbox = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (scenario.allowSavePassword === false) assert.equal(checkbox, null);
        else {
          assert.ok(checkbox);
          assert.equal(checkbox.checked, false);
          if (scenario.remember) await dispatchDomEvent(checkbox, new dom.window.MouseEvent("click", { bubbles: true }));
        }
        const submit = [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Submit");
        assert.ok(submit);
        await dispatchDomEvent(submit, new dom.window.MouseEvent("click", { bubbles: true }));
        assert.deepEqual(responses, [[request.requestId, ["fixture-new"], false]]);
        assert.deepEqual(queue, []);
        const saved = scenario.remember && scenario.allowSavePassword !== false;
        assert.equal(updates, saved ? 1 : 0);
        assert.equal(hosts[0].identityId, saved && identities.length ? "" : host.identityId);
        assert.equal(hosts[0].password, saved ? "fixture-new" : host.password);
        assert.equal(hosts[0].savePassword, saved);
        assert.equal(hosts[1], otherHost);
        assert.deepEqual(identity, originalIdentity);

        // Exercise the reconnect launcher that builds the actual SSH bridge request.
        for (const [index, candidate] of hosts.entries()) {
          let started: { username: string; password?: string } | undefined;
          const ctx = {
            host: candidate, identities, keys: [], knownHosts: [], resolvedChainHosts: [],
            sessionId: `reconnect-${index}`, terminalSettings: {},
            sessionRef: { current: null }, hasConnectedRef: { current: true },
            hasRunStartupCommandRef: { current: true }, disposeDataRef: { current: null },
            disposeExitRef: { current: null }, fitAddonRef: { current: null },
            serializeAddonRef: { current: null }, pendingAuthRef: { current: null },
            promptLineBreakStateRef: { current: createPromptLineBreakState() }, sudoAutofillRef: { current: null },
            updateStatus: noop, setStatus: noop, setError: noop, setNeedsAuth: noop,
            setAuthRetryMessage: noop, setAuthPassword: noop, setProgressLogs: noop,
            setProgressValue: noop, setChainProgress: noop,
            terminalBackend: {
              backendAvailable: () => true,
              startSSHSession: async (options: { username: string; password?: string }) => { started = options; return `reconnect-${index}`; },
              onSessionData: () => noop, onSessionExit: () => noop, onChainProgress: () => noop,
              writeToSession: noop, resizeSession: noop,
            },
          };
          await createTerminalSessionStarters(ctx as never).startSSH({
            cols: 80, rows: 24, write: noop, writeln: noop, scrollToBottom: noop,
          } as never);
          assert.ok(started);
          assert.equal(started.username, scenario.identityUsername?.trim() || scenario.hostUsername);
          assert.equal(started.password, saved && index === 0 ? "fixture-new" : identities.length ? "fixture-old" : "fixture-host-old");
        }
        // A fresh request resets the checkbox and submitting state for the next case.
        await renderer.render(<I18nProvider locale="en"><KeyboardInteractiveModal request={null} onSubmit={() => false} onCancel={() => false} /></I18nProvider>);
      });
    }
  } finally {
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  }
});
