import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from "../../test-support/renderReactDom";

test("custom arguments input preserves trailing spaces while typing and tokenizes on blur", async (t) => {
  const env = installDomEnvironment();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    DocumentFragment: env.window.DocumentFragment,
    MutationObserver: env.window.MutationObserver,
    Element: env.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const {
    getExternalEditorSettingsSnapshot,
    updateExternalEditorSettings,
  } = await import("../../../application/state/useExternalEditorSettings");
  const { I18nProvider } = await import("../../../application/i18n/I18nProvider");
  const { TooltipProvider } = await import("../../ui/tooltip");
  const { ExternalEditorSettingsSection } = await import("./ExternalEditorSettingsSection");

  const originalSettings = getExternalEditorSettingsSnapshot();
  updateExternalEditorSettings((prev) => ({
    ...prev,
    defaultEditor: "custom",
    editors: {
      ...prev.editors,
      custom: {
        ...prev.editors.custom,
        customArgs: ["{sshUri}"],
      },
    },
  }));

  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    updateExternalEditorSettings(() => originalSettings);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    env.cleanup();
  });

  await renderer.render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ExternalEditorSettingsSection />
      </TooltipProvider>
    </I18nProvider>,
  );

  const input = env.document.querySelector('input[placeholder="{sshUri}"]') as HTMLInputElement | null;
  assert.ok(input, "expected custom arguments input to be rendered");

  const setInputValue = (value: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, value);
  };

  await dispatchDomEvent(input, new env.window.FocusEvent("focusin", { bubbles: true }));

  // Typing a trailing space must NOT be stripped before the next token is entered.
  setInputValue("--remote ");
  await dispatchDomEvent(input, new env.window.Event("input", { bubbles: true }));
  assert.equal(input.value, "--remote ");

  setInputValue("--remote {sshTarget} {remotePath}");
  await dispatchDomEvent(input, new env.window.Event("input", { bubbles: true }));
  assert.equal(input.value, "--remote {sshTarget} {remotePath}");

  // Blur commits tokenized arguments to settings.
  await dispatchDomEvent(input, new env.window.FocusEvent("focusout", { bubbles: true }));
  assert.deepEqual(
    getExternalEditorSettingsSnapshot().editors.custom.customArgs,
    ["--remote", "{sshTarget}", "{remotePath}"],
  );
  assert.equal(input.value, "--remote {sshTarget} {remotePath}");
});

test("executable path input preserves spaces while typing and commits trimmed value on blur", async (t) => {
  const env = installDomEnvironment();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    DocumentFragment: env.window.DocumentFragment,
    MutationObserver: env.window.MutationObserver,
    Element: env.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const {
    getExternalEditorSettingsSnapshot,
    updateExternalEditorSettings,
  } = await import("../../../application/state/useExternalEditorSettings");
  const { I18nProvider } = await import("../../../application/i18n/I18nProvider");
  const { TooltipProvider } = await import("../../ui/tooltip");
  const { ExternalEditorSettingsSection } = await import("./ExternalEditorSettingsSection");

  const originalSettings = getExternalEditorSettingsSnapshot();
  updateExternalEditorSettings((prev) => ({
    ...prev,
    defaultEditor: "vscode",
    editors: {
      ...prev.editors,
      vscode: {
        ...prev.editors.vscode,
        executablePath: "",
      },
    },
  }));

  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    updateExternalEditorSettings(() => originalSettings);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    env.cleanup();
  });

  await renderer.render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ExternalEditorSettingsSection />
      </TooltipProvider>
    </I18nProvider>,
  );

  const input = env.document.querySelector('input[class*="flex-1"]') as HTMLInputElement | null;
  assert.ok(input, "expected executable path input to be rendered");

  const setInputValue = (value: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, value);
  };

  await dispatchDomEvent(input, new env.window.FocusEvent("focusin", { bubbles: true }));

  setInputValue("/Applications/Visual ");
  await dispatchDomEvent(input, new env.window.Event("input", { bubbles: true }));
  assert.equal(input.value, "/Applications/Visual ");

  setInputValue("  /Applications/Visual Studio Code.app  ");
  await dispatchDomEvent(input, new env.window.Event("input", { bubbles: true }));
  assert.equal(input.value, "  /Applications/Visual Studio Code.app  ");

  await dispatchDomEvent(input, new env.window.FocusEvent("focusout", { bubbles: true }));
  assert.equal(
    getExternalEditorSettingsSnapshot().editors.vscode.executablePath,
    "/Applications/Visual Studio Code.app",
  );
  assert.equal(input.value, "/Applications/Visual Studio Code.app");
});
