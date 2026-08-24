import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { useAppLockBridge } from "../application/state/useAppLockBridge.ts";
import { useAppLockState } from "../application/state/useAppLockState.ts";
import { createAppLockGate } from "./AppLockGate.tsx";
import { APP_LOCK_AUTO_PROMPT_DELAY_MS } from "./AppLockOverlay.tsx";
import { createAppLockBridgeHarness } from "./test-support/createAppLockBridgeHarness.ts";
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

test("startup-locked gate reveals children after successful unlock", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "unlocked-content" }, "Unlocked"),
      }),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("unlocked-content"), null);

    const form = dom.document.querySelector("form");
    assert.ok(form);
    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, "secret");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await dispatchDomEvent(form, new dom.window.Event("submit", { bubbles: true, cancelable: true }));

    await flushEffects();
    await flushEffects();

    assert.deepEqual(bridgeHarness.getUnlockAttempts(), ["secret"]);
    assert.equal(bridgeHarness.getRuntimeState().locked, false);
    assert.equal(dom.document.getElementById("unlocked-content")?.textContent, "Unlocked");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("startup-locked gate reveals children after successful system unlock", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
    systemUnlockStatus: {
      supported: true,
      available: true,
      enabled: true,
      platform: "darwin",
      label: "Touch ID",
      reason: null,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        systemUnlockEnabled: true,
        systemUnlockAutoPromptEnabled: true,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "unlocked-content" }, "Unlocked"),
      }),
    );
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);

    assert.equal(bridgeHarness.getSystemUnlockCount(), 1);
    assert.equal(bridgeHarness.getRuntimeState().locked, false);
    assert.equal(dom.document.getElementById("unlocked-content")?.textContent, "Unlocked");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("startup-locked gate does not automatically system unlock when auto prompt is disabled", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
    systemUnlockStatus: {
      supported: true,
      available: true,
      enabled: true,
      platform: "darwin",
      label: "Touch ID",
      reason: null,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        systemUnlockEnabled: true,
        systemUnlockAutoPromptEnabled: false,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "unlocked-content" }, "Unlocked"),
      }),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(bridgeHarness.getSystemUnlockCount(), 0);
    assert.equal(bridgeHarness.getRuntimeState().locked, true);
    assert.equal(dom.document.getElementById("unlocked-content"), null);

    const button = [...dom.document.querySelectorAll("button")]
      .find((candidate) => /Unlock with Touch ID/i.test(candidate.textContent ?? ""));
    assert.ok(button);
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("background-locked gate waits for reopen before automatic system unlock", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "background",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
    systemUnlockStatus: {
      supported: true,
      available: true,
      enabled: true,
      platform: "darwin",
      label: "Touch ID",
      reason: null,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        systemUnlockEnabled: true,
        systemUnlockAutoPromptEnabled: true,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "unlocked-content" }, "Unlocked"),
      }),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(bridgeHarness.getSystemUnlockCount(), 0);
    assert.equal(bridgeHarness.getRuntimeState().locked, true);

    await runWithAct(async () => {
      bridgeHarness.emitReopen();
    });
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);

    assert.equal(bridgeHarness.getSystemUnlockCount(), 1);
    assert.equal(bridgeHarness.getRuntimeState().locked, false);
    assert.equal(dom.document.getElementById("unlocked-content")?.textContent, "Unlocked");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("background-locked gate retries automatic system unlock on each reopen while still locked", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "background",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
    systemUnlockStatus: {
      supported: true,
      available: true,
      enabled: true,
      platform: "darwin",
      label: "Touch ID",
      reason: null,
    },
    systemUnlockResult: { ok: false, error: "cancelled" },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        systemUnlockEnabled: true,
        systemUnlockAutoPromptEnabled: true,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "unlocked-content" }, "Unlocked"),
      }),
    );
    await flushEffects();
    await flushEffects();

    assert.equal(bridgeHarness.getSystemUnlockCount(), 0);

    await runWithAct(async () => {
      bridgeHarness.emitReopen();
    });
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);

    assert.equal(bridgeHarness.getSystemUnlockCount(), 1);
    assert.equal(bridgeHarness.getRuntimeState().locked, true);

    await runWithAct(async () => {
      bridgeHarness.emitReopen();
    });
    await flushEffects();
    await flushEffects();
    await waitForAutoPrompt(dom);

    assert.equal(bridgeHarness.getSystemUnlockCount(), 2);
    assert.equal(bridgeHarness.getRuntimeState().locked, true);
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("startup-locked gate reveals children after hidden app lock reset", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "reset-unlocked-content" }, "Unlocked"),
      }),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("reset-unlocked-content"), null);

    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    setInputValue.call(input, "secret");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));

    const logoButton = dom.document.querySelector("[data-testid='app-lock-logo-easter-egg']");
    assert.ok(logoButton);
    for (let index = 0; index < 5; index += 1) {
      await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
      await flushEffects();
    }

    const resetButton = [...dom.document.querySelectorAll("button")]
      .find((button) => /Reset App Lock/i.test(button.textContent ?? ""));
    assert.ok(resetButton);
    await dispatchDomEvent(resetButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();

    assert.equal(bridgeHarness.getResetCount(), 1);
    assert.deepEqual(bridgeHarness.getResetAttempts(), ["secret"]);
    assert.equal(bridgeHarness.getRuntimeState().locked, false);
    assert.equal(dom.document.getElementById("reset-unlocked-content")?.textContent, "Unlocked");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("hidden app lock reset stays locked when reset bridge is unavailable", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  const bridgeWithoutReset = { ...bridgeHarness.bridge };
  delete bridgeWithoutReset.requestAppLockReset;
  dom.window.netcatty = bridgeWithoutReset;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "reset-missing-content" }, "Unlocked"),
      }),
    );
    await flushEffects();

    const logoButton = dom.document.querySelector("[data-testid='app-lock-logo-easter-egg']");
    assert.ok(logoButton);
    for (let index = 0; index < 5; index += 1) {
      await dispatchDomEvent(logoButton, new dom.window.MouseEvent("click", { bubbles: true }));
      await flushEffects();
    }

    const resetButton = [...dom.document.querySelectorAll("button")]
      .find((button) => /Reset App Lock/i.test(button.textContent ?? ""));
    assert.ok(resetButton);
    await dispatchDomEvent(resetButton, new dom.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await flushEffects();

    assert.match(dom.document.body.textContent ?? "", /Could not reset App Lock/i);
    assert.equal(bridgeHarness.getRuntimeState().locked, true);
    assert.equal(dom.document.getElementById("reset-missing-content"), null);
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("mounted locked gate uses the latest unlock password without remounting", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  // Start unlocked so children mount once, then re-lock under the overlay
  // (first-paint locks withhold children entirely).
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: false,
      reason: null,
      version: 1,
      lastLockedAt: null,
      lastUnlockedAt: 1_000,
      lastActivityAt: 1_000,
    },
    unlockPassword: "alpha",
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "latest-password-content" }, "Unlocked"),
      }),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("latest-password-content")?.textContent, "Unlocked");

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: true,
        reason: "manual",
        lastLockedAt: 2_000,
      });
    });
    await flushEffects();

    bridgeHarness.setUnlockPassword("bravo");

    const form = dom.document.querySelector("form");
    assert.ok(form);
    const input = dom.document.getElementById("app-lock-password") as HTMLInputElement | null;
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);

    setInputValue.call(input, "alpha");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await dispatchDomEvent(form, new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushEffects();

    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 1);
    // Children stay mounted under the overlay while re-locked.
    assert.equal(dom.document.getElementById("latest-password-content")?.textContent, "Unlocked");

    setInputValue.call(input, "bravo");
    await dispatchDomEvent(input, new dom.window.Event("input", { bubbles: true }));
    await dispatchDomEvent(form, new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushEffects();
    await flushEffects();

    assert.deepEqual(bridgeHarness.getUnlockAttempts(), ["alpha", "bravo"]);
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.document.getElementById("latest-password-content")?.textContent, "Unlocked");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("relocked gate marks mounted background content inert", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: false,
      reason: null,
      version: 1,
      lastLockedAt: null,
      lastUnlockedAt: 1_000,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "background-app" },
          React.createElement("button", { id: "bg-action", type: "button" }, "Do work"),
        ),
      }),
    );
    await flushEffects();

    const unlockedBackground = dom.document.querySelector("[data-app-lock-background]");
    assert.ok(unlockedBackground);
    assert.equal(unlockedBackground.getAttribute("data-app-lock-background"), "unlocked");
    assert.equal(unlockedBackground.hasAttribute("inert"), false);
    assert.equal(unlockedBackground.getAttribute("aria-hidden"), null);

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: true,
        reason: "idle",
        lastLockedAt: 2_000,
      });
    });
    await flushEffects();

    const lockedBackground = dom.document.querySelector("[data-app-lock-background]");
    assert.ok(lockedBackground);
    assert.equal(lockedBackground.getAttribute("data-app-lock-background"), "locked");
    assert.equal(lockedBackground.hasAttribute("inert"), true);
    assert.equal(lockedBackground.getAttribute("aria-hidden"), "true");
    assert.ok(
      String(lockedBackground.className || "").includes("pointer-events-none"),
      "locked background should block pointer events",
    );
    assert.equal(dom.document.getElementById("background-app")?.textContent?.includes("Do work"), true);
    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 1);
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("runtime unlock and relock broadcasts update multiple mounted gates together", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  // Mount while unlocked so children exist, then lock/unlock both gates together.
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: false,
      reason: null,
      version: 1,
      lastLockedAt: null,
      lastUnlockedAt: 1_000,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(React.Fragment, null,
        React.createElement(AppLockGate, {
          notifyRendererReady: false,
          children: () => React.createElement("div", { id: "gate-a" }, "Gate A"),
        }),
        React.createElement(AppLockGate, {
          notifyRendererReady: false,
          children: () => React.createElement("div", { id: "gate-b" }, "Gate B"),
        }),
      ),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("gate-a")?.textContent, "Gate A");
    assert.equal(dom.document.getElementById("gate-b")?.textContent, "Gate B");
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: true,
        reason: "manual",
        lastLockedAt: 2_000,
      });
    });
    await flushEffects();

    assert.equal(dom.document.getElementById("gate-a")?.textContent, "Gate A");
    assert.equal(dom.document.getElementById("gate-b")?.textContent, "Gate B");
    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 2);

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: false,
        reason: null,
        lastUnlockedAt: 3_000,
        lastActivityAt: 3_000,
      });
    });
    await flushEffects();

    assert.equal(dom.document.querySelector('[role="dialog"]'), null);

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: true,
        reason: "manual",
        lastLockedAt: 4_000,
      });
    });
    await flushEffects();

    assert.equal(dom.document.getElementById("gate-a")?.textContent, "Gate A");
    assert.equal(dom.document.getElementById("gate-b")?.textContent, "Gate B");
    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 2);
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("focus recovery resync clears stale overlay state after a missed broadcast", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "manual",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "stale-gate" }, "Unlocked After Resync"),
      }),
    );
    await flushEffects();

    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 1);

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: false,
        reason: null,
        lastUnlockedAt: 2_000,
        lastActivityAt: 2_000,
      }, { notify: false });
    });

    await dispatchDomEvent(dom.window, new dom.window.FocusEvent("focus"));
    await flushEffects();
    await flushEffects();

    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.document.getElementById("stale-gate")?.textContent, "Unlocked After Resync");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("reopen recovery resync clears stale overlay state after a missed broadcast", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "manual",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "reopen-gate" }, "Unlocked After Reopen"),
      }),
    );
    await flushEffects();

    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 1);

    await runWithAct(async () => {
      bridgeHarness.setRuntimeState({
        locked: false,
        reason: null,
        lastUnlockedAt: 2_000,
        lastActivityAt: 2_000,
      }, { notify: false });
      bridgeHarness.emitReopen();
    });
    await flushEffects();
    await flushEffects();

    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.document.getElementById("reopen-gate")?.textContent, "Unlocked After Reopen");
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});

test("reopen resync does not unlock a gate when runtime is still locked", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const bridgeHarness = createAppLockBridgeHarness({
    runtimeState: {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 1,
      lastLockedAt: 1_000,
      lastUnlockedAt: null,
      lastActivityAt: 1_000,
    },
  });
  const AppLockGate = createAppLockGate({
    useSettingsState: () => ({
      uiLanguage: "en",
      appLockSettings: {
        enabled: true,
        timeoutMinutes: 15,
        passwordVerifier: {
          version: 1,
          algorithm: "PBKDF2-SHA256",
          iterations: 210000,
          salt: "AAAAAAAAAAAAAAAAAAAAAA==",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }) as ReturnType<typeof import("../application/state/useSettingsState.ts").useSettingsState>,
    useAppLockState,
    useAppLockBridge,
  });

  const previousWindowNetcatty = dom.window.netcatty;
  dom.window.netcatty = bridgeHarness.bridge;

  try {
    await renderer.render(
      React.createElement(AppLockGate, {
        notifyRendererReady: false,
        children: () => React.createElement("div", { id: "startup-locked-child" }, "Should Stay Hidden"),
      }),
    );
    await flushEffects();

    assert.equal(dom.document.getElementById("startup-locked-child"), null);
    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 1);
    const fetchCountBeforeReopen = bridgeHarness.getRuntimeFetchCount();

    await runWithAct(async () => {
      bridgeHarness.emitReopen();
    });
    await flushEffects();
    await flushEffects();

    assert.equal(bridgeHarness.getRuntimeFetchCount(), fetchCountBeforeReopen + 1);
    assert.equal(dom.document.getElementById("startup-locked-child"), null);
    assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 1);
  } finally {
    dom.window.netcatty = previousWindowNetcatty;
    await renderer.unmount();
    dom.cleanup();
  }
});
