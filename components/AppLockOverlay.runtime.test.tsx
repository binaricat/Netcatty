import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { APP_LOCK_AUTO_PROMPT_DELAY_MS, AppLockOverlay } from "./AppLockOverlay.tsx";
import {
  createDomRenderer,
  dispatchDomEvent,
  flushEffects,
  installDomEnvironment,
  runWithAct,
} from "./test-support/renderReactDom.tsx";

async function waitForAutoPrompt(dom: ReturnType<typeof installDomEnvironment>) {
  await runWithAct(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, APP_LOCK_AUTO_PROMPT_DELAY_MS + 50));
  });
  await flushEffects();
  await flushEffects();
}

test("AppLockOverlay shows incorrect-password error and clears it after editing", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const unlockAttempts: string[] = [];

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async (password) => {
            unlockAttempts.push(password);
            return { ok: false, error: "incorrect" as const };
          },
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    const form = dom.document.querySelector("form");
    const passwordLabel = dom.document.querySelector('label[for="app-lock-password"]');
    const lockIcon = dom.document.querySelector('[data-testid="app-lock-password-lock-icon"]');
    assert.ok(input);
    assert.ok(form);
    assert.ok(passwordLabel);
    assert.ok(lockIcon);
    assert.equal(input.getAttribute("placeholder"), "Enter password to unlock");
    assert.match(passwordLabel.getAttribute("class") ?? "", /sr-only/);
    assert.equal(lockIcon.getAttribute("aria-hidden"), "true");
    assert.doesNotMatch(lockIcon.getAttribute("class") ?? "", /border-l/);

    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, "wrong");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await dispatchDomEvent(form, new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushEffects();
    await flushEffects();

    assert.deepEqual(unlockAttempts, ["wrong"]);
    assert.match(dom.document.body.textContent ?? "", /Incorrect lock password/i);

    setInputValue.call(input, "wrong-again");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await flushEffects();

    assert.doesNotMatch(dom.document.body.textContent ?? "", /Incorrect lock password/i);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay submits a whitespace-only password unchanged", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const unlockAttempts: string[] = [];

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async (password) => {
            unlockAttempts.push(password);
            return { ok: true as const };
          },
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    const form = dom.document.querySelector("form");
    assert.ok(input);
    assert.ok(form);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, " ");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await dispatchDomEvent(form, new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushEffects();
    await flushEffects();

    assert.deepEqual(unlockAttempts, [" "]);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay reveals reset action after clicking Netcatty logo five times", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const resetAttempts: string[] = [];

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false, error: "incorrect" as const }),
          onResetAppLock: async (currentPassword) => {
            resetAttempts.push(currentPassword);
          },
        }),
      ),
    );
    await flushEffects();

    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, "secret");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));

    assert.doesNotMatch(dom.document.body.textContent ?? "", /Reset App Lock/i);
    const logoButton = dom.document.querySelector("[data-testid='app-lock-logo-easter-egg']");
    assert.ok(logoButton);

    for (let index = 0; index < 5; index += 1) {
      await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
      await flushEffects();
    }

    assert.match(dom.document.body.textContent ?? "", /Reset App Lock/i);

    const resetButton = [...dom.document.querySelectorAll("button")]
      .find((button) => /Reset App Lock/i.test(button.textContent ?? ""));
    assert.ok(resetButton);
    await dispatchDomEvent(resetButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();

    assert.deepEqual(resetAttempts, ["secret"]);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay only reveals reset after five quick logo clicks", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false, error: "incorrect" as const }),
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    const logoButton = dom.document.querySelector("[data-testid='app-lock-logo-easter-egg']");
    assert.ok(logoButton);
    await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 1600));
    await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();

    assert.doesNotMatch(dom.document.body.textContent ?? "", /Reset App Lock/i);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay reset controls do not submit the unlock form", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let unlockCount = 0;
  const resetAttempts: string[] = [];

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => {
            unlockCount += 1;
            return { ok: false, error: "incorrect" as const };
          },
          onResetAppLock: async (currentPassword) => {
            resetAttempts.push(currentPassword);
          },
        }),
      ),
    );
    await flushEffects();

    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, "secret");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));

    assert.doesNotMatch(dom.document.body.textContent ?? "", /forgot password/i);
    const logoButton = dom.document.querySelector("[data-testid='app-lock-logo-easter-egg']");
    assert.ok(logoButton);
    for (let index = 0; index < 5; index += 1) {
      await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    }
    await flushEffects();

    const cancelButton = [...dom.document.querySelectorAll("button")]
      .find((button) => /Cancel/i.test(button.textContent ?? ""));
    assert.ok(cancelButton);
    await dispatchDomEvent(cancelButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    assert.equal(unlockCount, 0);
    assert.deepEqual(resetAttempts, []);

    for (let index = 0; index < 5; index += 1) {
      await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
    }
    await flushEffects();
    const resetButton = [...dom.document.querySelectorAll("button")]
      .find((button) => /Reset App Lock/i.test(button.textContent ?? ""));
    assert.ok(resetButton);
    await dispatchDomEvent(resetButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();

    assert.equal(unlockCount, 0);
    assert.deepEqual(resetAttempts, ["secret"]);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay renders platform-specific system unlock button", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let systemUnlockCount = 0;

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "win32",
            label: "Windows Hello",
            reason: null,
          },
          onSystemUnlock: async () => {
            systemUnlockCount += 1;
            return { ok: true as const };
          },
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(systemUnlockCount, 0);
    assert.equal(dom.document.getElementById("app-lock-password"), null);
    assert.ok(dom.document.querySelector('[data-testid="app-lock-system-unlock-windows-icon"]'));

    const button = [...dom.document.querySelectorAll("button")]
      .find((candidate) => /Unlock with Windows Hello/i.test(candidate.textContent ?? ""));
    assert.ok(button);
    await dispatchDomEvent(button, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();
    assert.equal(systemUnlockCount, 1);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay localizes the system unlock button label", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "zh-CN" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "darwin",
            label: "Touch ID",
            reason: null,
          },
          onSystemUnlock: async () => ({ ok: true as const }),
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    assert.match(dom.document.body.textContent ?? "", /使用 Touch ID 解锁/i);
    assert.doesNotMatch(dom.document.body.textContent ?? "", /Unlock with Touch ID/i);
    assert.equal(dom.document.getElementById("app-lock-password"), null);
    assert.ok(dom.document.querySelector('[data-testid="app-lock-system-unlock-touch-id-icon"]'));
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay does not automatically request system unlock by default", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let systemUnlockCount = 0;

  try {
    const props = {
      locked: true,
      reason: "manual" as const,
      onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
      systemUnlockStatus: {
        supported: true,
        available: true,
        enabled: true,
        platform: "darwin" as const,
        label: "Touch ID" as const,
        reason: null,
      },
      onSystemUnlock: async () => {
        systemUnlockCount += 1;
        return { ok: true as const };
      },
      onResetAppLock: async () => {},
    };

    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, props),
      ),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(systemUnlockCount, 0);
    assert.equal(dom.document.getElementById("app-lock-password"), null);
    assert.match(dom.document.body.textContent ?? "", /Use password instead/i);

    const button = [...dom.document.querySelectorAll("button")]
      .find((candidate) => /Unlock with Touch ID/i.test(candidate.textContent ?? ""));
    assert.ok(button);
    await dispatchDomEvent(button, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();

    assert.equal(systemUnlockCount, 1);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay reveals password fallback and cancels a delayed automatic prompt", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let systemUnlockCount = 0;

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          autoPromptSystemUnlock: true,
          onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "darwin" as const,
            label: "Touch ID" as const,
            reason: null,
          },
          onSystemUnlock: async () => {
            systemUnlockCount += 1;
            return { ok: true as const };
          },
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("app-lock-password"), null);
    assert.match(dom.document.body.textContent ?? "", /Preparing Touch ID/i);
    const usePasswordButton = [...dom.document.querySelectorAll("button")]
      .find((candidate) => /Use password instead/i.test(candidate.textContent ?? ""));
    assert.ok(usePasswordButton);
    await dispatchDomEvent(usePasswordButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();

    assert.ok(dom.document.getElementById("app-lock-password"));
    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 0);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay shows animated feedback while system unlock is in flight", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let resolveSystemUnlock: ((result: { ok: true }) => void) | null = null;

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "darwin" as const,
            label: "Touch ID" as const,
            reason: null,
          },
          onSystemUnlock: async () => new Promise<{ ok: true }>((resolve) => {
            resolveSystemUnlock = resolve;
          }),
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    const systemButton = [...dom.document.querySelectorAll("button")]
      .find((candidate) => /Unlock with Touch ID/i.test(candidate.textContent ?? ""));
    assert.ok(systemButton);
    await dispatchDomEvent(systemButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();

    assert.match(dom.document.body.textContent ?? "", /Waiting for Touch ID/i);
    assert.ok(dom.document.querySelector('[data-testid="app-lock-system-unlock-loading"]'));
    assert.ok(resolveSystemUnlock);
    await runWithAct(async () => {
      resolveSystemUnlock?.({ ok: true });
    });
    await flushEffects();
    await flushEffects();
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay automatically requests system unlock once when auto prompt is enabled", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let systemUnlockCount = 0;

  try {
    const props = {
      locked: true,
      reason: "manual" as const,
      onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
      systemUnlockStatus: {
        supported: true,
        available: true,
        enabled: true,
        platform: "darwin" as const,
        label: "Touch ID" as const,
        reason: null,
      },
      autoPromptSystemUnlock: true,
      onSystemUnlock: async () => {
        systemUnlockCount += 1;
        return { ok: true as const };
      },
      onResetAppLock: async () => {},
    };

    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, props),
      ),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(systemUnlockCount, 0);
    assert.match(dom.document.body.textContent ?? "", /Preparing Touch ID/i);
    assert.ok(dom.document.querySelector('[data-testid="app-lock-system-unlock-loading"]'));

    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 1);

    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, props),
      ),
    );
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);

    assert.equal(systemUnlockCount, 1);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay waits until the document is visible before auto system unlock", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let systemUnlockCount = 0;

  try {
    Object.defineProperty(dom.document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "darwin" as const,
            label: "Touch ID" as const,
            reason: null,
          },
          autoPromptSystemUnlock: true,
          onSystemUnlock: async () => {
            systemUnlockCount += 1;
            return { ok: true as const };
          },
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(systemUnlockCount, 0);

    Object.defineProperty(dom.document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await dispatchDomEvent(dom.document, new dom.window.Event("visibilitychange"));
    await flushEffects();
    await flushEffects();

    assert.equal(systemUnlockCount, 0);
    assert.match(dom.document.body.textContent ?? "", /Preparing Touch ID/i);
    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 1);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay waits for window focus before auto system unlock", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let focused = false;
  let systemUnlockCount = 0;

  Object.defineProperty(dom.document, "hasFocus", {
    configurable: true,
    value: () => focused,
  });

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "darwin" as const,
            label: "Touch ID" as const,
            reason: null,
          },
          autoPromptSystemUnlock: true,
          onSystemUnlock: async () => {
            systemUnlockCount += 1;
            return { ok: true as const };
          },
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();
    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 0);

    focused = true;
    await dispatchDomEvent(dom.window, new dom.window.FocusEvent("focus"));
    await flushEffects();
    assert.match(dom.document.body.textContent ?? "", /Preparing Touch ID/i);
    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 1);

    await dispatchDomEvent(dom.window, new dom.window.FocusEvent("focus"));
    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 1);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay retries a reopen presentation after an in-flight auto prompt finishes", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let systemUnlockCount = 0;
  let resolveFirstUnlock: ((result: { ok: false; error: "cancelled" }) => void) | null = null;

  try {
    const createOverlay = (reopenSignal: number) => React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(AppLockOverlay, {
        locked: true,
        reason: "background",
        reopenSignal,
        autoPromptSystemUnlock: true,
        onUnlock: async () => ({ ok: false as const, error: "incorrect" as const }),
        systemUnlockStatus: {
          supported: true,
          available: true,
          enabled: true,
          platform: "darwin" as const,
          label: "Touch ID" as const,
          reason: null,
        },
        onSystemUnlock: async () => {
          systemUnlockCount += 1;
          if (systemUnlockCount === 1) {
            return new Promise<{ ok: false; error: "cancelled" }>((resolve) => {
              resolveFirstUnlock = resolve;
            });
          }
          return { ok: false as const, error: "cancelled" as const };
        },
        onResetAppLock: async () => {},
      }),
    );

    await renderer.render(createOverlay(1));
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);
    assert.equal(systemUnlockCount, 1);

    await renderer.render(createOverlay(2));
    await flushEffects();
    await flushEffects();
    assert.equal(systemUnlockCount, 1);

    assert.ok(resolveFirstUnlock);
    await runWithAct(async () => {
      resolveFirstUnlock?.({ ok: false, error: "cancelled" });
    });
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);

    assert.equal(systemUnlockCount, 2);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay hides system unlock when unavailable", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false, error: "incorrect" as const }),
          systemUnlockStatus: {
            supported: true,
            available: false,
            enabled: true,
            platform: "darwin",
            label: "Touch ID",
            reason: "unavailable",
          },
          onSystemUnlock: async () => ({ ok: true as const }),
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    assert.doesNotMatch(dom.document.body.textContent ?? "", /Unlock with Touch ID/i);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay keeps password fallback after system unlock failure", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const unlockAttempts: string[] = [];

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async (password) => {
            unlockAttempts.push(password);
            return { ok: true as const };
          },
          systemUnlockStatus: {
            supported: true,
            available: true,
            enabled: true,
            platform: "darwin",
            label: "Touch ID",
            reason: null,
          },
          onSystemUnlock: async () => ({ ok: false as const, error: "cancelled" as const }),
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("app-lock-password"), null);
    const systemButton = [...dom.document.querySelectorAll("button")]
      .find((candidate) => /Unlock with Touch ID/i.test(candidate.textContent ?? ""));
    assert.ok(systemButton);
    await dispatchDomEvent(systemButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();
    assert.match(dom.document.body.textContent ?? "", /System unlock was not completed/i);

    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    const form = dom.document.querySelector("form");
    assert.ok(input);
    assert.ok(form);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, "secret");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await dispatchDomEvent(form, new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushEffects();

    assert.deepEqual(unlockAttempts, ["secret"]);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});

test("AppLockOverlay keeps a window drag region while lock controls stay interactive", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);

  try {
    await renderer.render(
      React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(AppLockOverlay, {
          locked: true,
          reason: "manual",
          onUnlock: async () => ({ ok: false, error: "incorrect" as const }),
          onResetAppLock: async () => {},
        }),
      ),
    );
    await flushEffects();

    const overlay = dom.document.querySelector("[data-app-lock-overlay]");
    const form = overlay?.querySelector("form");
    assert.ok(overlay);
    assert.ok(form);
    assert.match(overlay.getAttribute("class") ?? "", /\bapp-drag\b/);
    assert.match(form.getAttribute("class") ?? "", /\bapp-no-drag\b/);
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});
