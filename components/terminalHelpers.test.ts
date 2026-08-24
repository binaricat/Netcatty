import test from "node:test";
import assert from "node:assert/strict";

import type { Host } from "../domain/models";
import {
  AUTO_RUN_SNIPPET_LINE_DELAY_MS,
  resolveDisconnectedDialogTerminalRoot,
  restoreTerminalFocusFromDisconnectedDialog,
  shouldClaimDisconnectedDialogFocus,
  shouldHideConnectingDialogForConnectionReuse,
  shouldDelayAutoRunSnippetInput,
  shouldReconnectDisconnectedDialogOnEnterKey,
  shouldRestoreDisconnectedDialogTerminalFocus,
  shouldShowTerminalDisconnectedNotice,
  shouldShowTerminalConnectionDialog,
} from "./terminal/terminalHelpers";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "alice",
  authMethod: "password",
  ...overrides,
});

test("disconnected dialog reconnects on plain Enter when no control owns focus", () => {
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "Enter",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "Enter",
      enabled: false,
    }),
    false,
  );
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "a",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "Enter",
      enabled: true,
      shiftKey: true,
    }),
    false,
  );
});

test("disconnected dialog leaves Enter to focused buttons and inputs", () => {
  class FakeElement {
    constructor(private readonly selectorMatch: boolean) {}
    closest(selector: string) {
      void selector;
      return this.selectorMatch ? this : null;
    }
  }
  const previousHTMLElement = globalThis.HTMLElement;
  // @ts-expect-error test double for DOM instanceof checks
  globalThis.HTMLElement = FakeElement;
  try {
    const buttonLike = new FakeElement(true);
    const plain = new FakeElement(false);
    assert.equal(
      shouldReconnectDisconnectedDialogOnEnterKey({
        key: "Enter",
        enabled: true,
        target: buttonLike as unknown as EventTarget,
      }),
      false,
    );
    assert.equal(
      shouldReconnectDisconnectedDialogOnEnterKey({
        key: "Enter",
        enabled: true,
        target: plain as unknown as EventTarget,
      }),
      true,
    );
  } finally {
    globalThis.HTMLElement = previousHTMLElement;
  }
});

test("disconnected dialog focus claim never steals from other panes", () => {
  class FakeNode {
    constructor(
      private readonly opts: {
        id: string;
        parent?: FakeNode | null;
        interactive?: boolean;
        children?: FakeNode[];
      },
    ) {
      for (const child of opts.children ?? []) {
        child.opts.parent = this;
      }
    }
    get parentElement() {
      return this.opts.parent ?? null;
    }
    contains(other: FakeNode | null) {
      if (!other) return false;
      let cur: FakeNode | null | undefined = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.opts.parent;
      }
      return false;
    }
    closest(selector: string) {
      if (selector.includes("button") && this.opts.interactive) return this;
      return null;
    }
    querySelector(selector: string) {
      if (!selector.includes("xterm-helper-textarea")) return null;
      return (this.opts.children ?? []).find((c) => c.opts.id === "textarea") ?? null;
    }
    focusCalls = 0;
    focus() {
      this.focusCalls += 1;
    }
  }

  const previousHTMLElement = globalThis.HTMLElement;
  // @ts-expect-error test double for DOM instanceof checks
  globalThis.HTMLElement = FakeNode;
  try {
    const body = new FakeNode({ id: "body" });
    const otherPane = new FakeNode({ id: "other" });
    const textarea = new FakeNode({ id: "textarea" });
    const dialogButton = new FakeNode({ id: "btn", interactive: true });
    const dialog = new FakeNode({ id: "dialog", children: [dialogButton] });
    const session = new FakeNode({ id: "session", children: [textarea, dialog] });

    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: null,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: body as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    // Unfocused split sibling must not claim when focus is on body/null.
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: null,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
        isFocusedPane: false,
      }),
      false,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: body as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
        isFocusedPane: false,
      }),
      false,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: body as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
        isFocusedPane: true,
      }),
      true,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: textarea as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: otherPane as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      false,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: dialogButton as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      false,
    );
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: dialog as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      false,
    );

    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: dialog as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    assert.equal(textarea.focusCalls, 1);
    // After React removes the focused dialog, the browser parks focus on body
    // before passive-effect cleanup runs — still restore to this session's xterm.
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: body as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    assert.equal(textarea.focusCalls, 2);
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: otherPane as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      false,
    );
    assert.equal(textarea.focusCalls, 2);

    // Popup terminals have no data-session-id ancestor — restore via local tree walk.
    const popupTextarea = new FakeNode({ id: "textarea" });
    const popupDialog = new FakeNode({ id: "dialog" });
    const popupRoot = new FakeNode({ id: "popup-root", children: [popupTextarea, popupDialog] });
    assert.equal(
      resolveDisconnectedDialogTerminalRoot(popupDialog as unknown as Element, null),
      popupRoot as unknown as Element,
    );
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: popupDialog as unknown as Element,
        dialogNode: popupDialog as unknown as HTMLElement,
        sessionRoot: null,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    assert.equal(popupTextarea.focusCalls, 1);
    assert.equal(
      shouldClaimDisconnectedDialogFocus({
        activeElement: popupTextarea as unknown as Element,
        dialogNode: popupDialog as unknown as HTMLElement,
        sessionRoot: null,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    // Detached popup dialog (parent cleared) + body focus: use captured terminal root.
    popupDialog.opts.parent = null;
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: body as unknown as Element,
        dialogNode: popupDialog as unknown as HTMLElement,
        sessionRoot: popupRoot as unknown as Element,
        documentBody: body as unknown as Element,
      }),
      true,
    );
    assert.equal(popupTextarea.focusCalls, 2);

    // Unfocused split sibling must not restore when browser parked focus on body.
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: body as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
        isFocusedPane: false,
      }),
      false,
    );
    assert.equal(textarea.focusCalls, 2);
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: body as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
        isFocusedPane: true,
      }),
      true,
    );
    assert.equal(textarea.focusCalls, 3);
    // Dialog actually owned focus — restore even if pane focus flag flipped.
    assert.equal(
      restoreTerminalFocusFromDisconnectedDialog({
        activeElement: dialog as unknown as Element,
        dialogNode: dialog as unknown as HTMLElement,
        sessionRoot: session as unknown as Element,
        documentBody: body as unknown as Element,
        isFocusedPane: false,
      }),
      true,
    );
    assert.equal(textarea.focusCalls, 4);
  } finally {
    globalThis.HTMLElement = previousHTMLElement;
  }
});

test("xterm focus restore is skipped while the connection overlay stays mounted", () => {
  assert.equal(
    shouldRestoreDisconnectedDialogTerminalFocus({ isConnected: true } as HTMLElement),
    false,
  );
  assert.equal(
    shouldRestoreDisconnectedDialogTerminalFocus({ isConnected: false } as HTMLElement),
    true,
  );
  assert.equal(shouldRestoreDisconnectedDialogTerminalFocus(null), false);
});

test("connection dialog is hidden while a reused SSH channel is opening", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
      hideConnectingDialogForConnectionReuse: true,
    }),
    false,
  );
});

test("connection dialog remains visible when reuse is not actually supported", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
      hideConnectingDialogForConnectionReuse: false,
    }),
    true,
  );
});

test("connection dialog still appears for fresh remote connections", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    true,
  );
});

test("connection dialog keeps existing local and disconnected behavior", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: true,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connected",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "disconnected",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: true,
    }),
    false,
  );
});

test("established sessions use the selected disconnected presentation", () => {
  const base = {
    status: "disconnected" as const,
    hasEverConnected: true,
  };

  assert.equal(
    shouldShowTerminalDisconnectedNotice({
      ...base,
      disconnectedNoticeMode: "terminal",
    }),
    true,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...base,
      disconnectedNoticeMode: "terminal",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalDisconnectedNotice({
      ...base,
      disconnectedNoticeMode: "dialog",
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...base,
      disconnectedNoticeMode: "dialog",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    true,
  );
});

test("terminal notice never hides first-connect failures or restored session guidance", () => {
  const dialogArgs = {
    status: "disconnected" as const,
    disconnectedNoticeMode: "terminal" as const,
    isLocalConnection: false,
    isSerialConnection: false,
    isDisconnectedDialogDismissed: false,
  };

  assert.equal(
    shouldShowTerminalDisconnectedNotice({
      status: "disconnected",
      disconnectedNoticeMode: "terminal",
      hasEverConnected: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({ ...dialogArgs, hasEverConnected: false }),
    true,
  );
  assert.equal(
    shouldShowTerminalDisconnectedNotice({
      status: "disconnected",
      disconnectedNoticeMode: "terminal",
      hasEverConnected: true,
      restoreState: "restored-disconnected",
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...dialogArgs,
      hasEverConnected: true,
      restoreState: "restored-disconnected",
    }),
    true,
  );
});

test("terminal notice is absent while connected", () => {
  assert.equal(
    shouldShowTerminalDisconnectedNotice({
      status: "connected",
      disconnectedNoticeMode: "terminal",
      hasEverConnected: true,
    }),
    false,
  );
});

test("established manual reconnect stays non-blocking until input is required", () => {
  const base = {
    status: "connecting" as const,
    disconnectedNoticeMode: "terminal" as const,
    hasEverConnected: true,
    isReconnectActive: true,
  };

  assert.equal(shouldShowTerminalDisconnectedNotice(base), true);
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...base,
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );

  assert.equal(
    shouldShowTerminalDisconnectedNotice({ ...base, requiresUserInput: true }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...base,
      requiresUserInput: true,
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    true,
  );
});

test("established automatic reconnect stays non-blocking until input is required", () => {
  const base = {
    status: "connecting" as const,
    disconnectedNoticeMode: "terminal" as const,
    hasEverConnected: true,
    isReconnectActive: true,
  };

  assert.equal(shouldShowTerminalDisconnectedNotice(base), true);
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...base,
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );

  assert.equal(
    shouldShowTerminalDisconnectedNotice({ ...base, requiresUserInput: true }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      ...base,
      requiresUserInput: true,
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    true,
  );
});

test("connection reuse hides connecting dialog only while reuse is still possible", () => {
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: undefined,
      host: host(),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host(),
      connectionReuseFellBack: false,
    }),
    true,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ x11Forwarding: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ moshEnabled: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ etEnabled: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host(),
      connectionReuseFellBack: true,
    }),
    false,
  );
});

test("auto-run snippets only delay multi-line input in line-by-line mode", () => {
  assert.equal(AUTO_RUN_SNIPPET_LINE_DELAY_MS > 0, true);
  assert.equal(shouldDelayAutoRunSnippetInput("tthdf 0 2323\nadmin\ntest123", { noAutoRun: false }), false);
  assert.equal(
    shouldDelayAutoRunSnippetInput("sudo apt install gconf2-common -y\necho \"123456\"", {
      noAutoRun: false,
    }),
    false,
  );
  assert.equal(
    shouldDelayAutoRunSnippetInput("tthdf 0 2323\nadmin\ntest123", {
      noAutoRun: false,
      multiLineRunMode: "lineDelay",
    }),
    true,
  );
  assert.equal(shouldDelayAutoRunSnippetInput("tthdf 0 2323\nadmin\ntest123", { noAutoRun: true }), false);
  assert.equal(shouldDelayAutoRunSnippetInput("show version", { noAutoRun: false }), false);
  assert.equal(shouldDelayAutoRunSnippetInput("show version\r", { noAutoRun: false }), false);
});
