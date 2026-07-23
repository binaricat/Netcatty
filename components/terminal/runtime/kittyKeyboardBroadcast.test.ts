import test from "node:test";
import assert from "node:assert/strict";

import {
  clearKittyKeyboardBroadcastPairingState,
  clearKittyKeyboardBroadcastSession,
  createKittyKeyboardBroadcastForwarder,
  createKittyKeyboardBroadcastHandler,
  dispatchKittyKeyboardBroadcastInput,
  flushKittyKeyboardBroadcastReleases,
  registerKittyKeyboardBroadcastHandler,
  resolveKittyKeyboardBroadcastInput,
  upsertKittyKeyboardForwardedPress,
  type KittyKeyboardBroadcastInput,
  type KittyKeyboardForwardedPress,
} from "./kittyKeyboardBroadcast";
import {
  createKittyKeyboardModeState,
  encodeKittyKeyEvent,
  setKittyKeyboardModeFlags,
} from "./kittyKeyboardProtocol";

test("routes normalized Kitty input to the target session only", () => {
  const received: KittyKeyboardBroadcastInput[] = [];
  assert.equal(dispatchKittyKeyboardBroadcastInput("target", { kind: "text", text: "queued" }), true);
  const dispose = registerKittyKeyboardBroadcastHandler("target", (input) => received.push(input));

  assert.equal(dispatchKittyKeyboardBroadcastInput("target", {
    kind: "key",
    event: { type: "keydown", key: "c", code: "KeyC", ctrlKey: true },
  }), true);
  assert.equal(dispatchKittyKeyboardBroadcastInput("target", { kind: "text", text: "你" }), true);
  assert.deepEqual(received, [
    { kind: "text", text: "queued" },
    { kind: "key", event: { type: "keydown", key: "c", code: "KeyC", ctrlKey: true } },
    { kind: "text", text: "你" },
  ]);

  dispose();
  assert.equal(dispatchKittyKeyboardBroadcastInput("target", { kind: "text", text: "x" }), true);
  clearKittyKeyboardBroadcastSession("target");
});

test("disposing an old registration does not remove its replacement", () => {
  const received: string[] = [];
  const disposeOld = registerKittyKeyboardBroadcastHandler("target-replaced", () => received.push("old"));
  const disposeNew = registerKittyKeyboardBroadcastHandler("target-replaced", () => received.push("new"));

  disposeOld();
  assert.equal(
    dispatchKittyKeyboardBroadcastInput("target-replaced", { kind: "text", text: "x" }),
    true,
  );
  assert.deepEqual(received, ["new"]);
  disposeNew();
  clearKittyKeyboardBroadcastSession("target-replaced");
});

test("a paired release is forwarded after broadcast is disabled", () => {
  let enabled = true;
  let dispatcherAvailable = true;
  const forwarded: Array<{
    input: KittyKeyboardBroadcastInput;
    targetSessionIds?: string[];
  }> = [];
  const forward = createKittyKeyboardBroadcastForwarder({
    sourceSessionId: "source",
    isHandlingBroadcast: () => false,
    isBroadcastEnabled: () => enabled,
    getDispatcher: () => dispatcherAvailable ? (_data, sourceSessionId, options) => {
      assert.equal(sourceSessionId, "source");
      forwarded.push({
        input: options.kittyKeyboardInput,
        targetSessionIds: options.kittyKeyboardTargetSessionIds,
      });
      return ["target-a"];
    } : undefined,
  });
  const keydown: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keydown", key: "a", code: "KeyA" },
  };
  const keyup: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keyup", key: "a", code: "KeyA" },
  };
  assert.deepEqual(forward(keydown), { targetSessionIds: ["target-a"] });
  enabled = false;
  dispatcherAvailable = false;
  assert.equal(forward(keyup), null);
  assert.deepEqual(forward(keyup, true, ["target-a"]), {
    targetSessionIds: ["target-a"],
  });
  assert.deepEqual(forwarded, [
    { input: keydown, targetSessionIds: undefined },
    { input: keyup, targetSessionIds: ["target-a"] },
  ]);
});

test("sensitive input is never broadcast while an earlier paired release can still finish", () => {
  let sensitive = true;
  const forwarded: KittyKeyboardBroadcastInput[] = [];
  const forward = createKittyKeyboardBroadcastForwarder({
    sourceSessionId: "source",
    isHandlingBroadcast: () => false,
    isBroadcastEnabled: () => true,
    isSensitiveInput: () => sensitive,
    getDispatcher: () => (_data, _sourceSessionId, options) => {
      forwarded.push(options.kittyKeyboardInput);
      return ["target-a"];
    },
  });
  const secretPress: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keydown", key: "x", code: "KeyX" },
  };
  const priorRelease: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keyup", key: "Shift", code: "ShiftLeft" },
  };

  assert.equal(forward(secretPress), null);
  assert.deepEqual(forward(priorRelease, true, ["target-a"]), {
    targetSessionIds: ["target-a"],
  });
  sensitive = false;
  assert.deepEqual(forward(secretPress), { targetSessionIds: ["target-a"] });
  assert.deepEqual(forwarded, [priorRelease, secretPress]);
});

test("blur flushes every forwarded press as a synthetic release", () => {
  const forwarded: KittyKeyboardBroadcastInput[] = [];
  const forward = createKittyKeyboardBroadcastForwarder({
    sourceSessionId: "source",
    isHandlingBroadcast: () => false,
    isBroadcastEnabled: () => false,
    getDispatcher: () => (_data, _sourceSessionId, options) => {
      forwarded.push(options.kittyKeyboardInput);
    },
  });
  const press = {
    type: "keydown",
    key: "Shift",
    code: "ShiftLeft",
    shiftKey: true,
    getModifierState: (name: string) => name === "CapsLock",
  } as const;
  const releases = new Map([
    ["ShiftLeft", { event: press, targetSessionIds: ["target-a"] }],
  ]);
  flushKittyKeyboardBroadcastReleases(releases, forward);
  assert.equal(releases.size, 0);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.kind, "key");
  if (forwarded[0]?.kind !== "key") return;
  assert.equal(forwarded[0].event.type, "keyup");
  assert.equal(forwarded[0].event.key, "Shift");
  assert.equal(forwarded[0].event.repeat, false);
  assert.equal(forwarded[0].event.shiftKey, false);
  assert.equal(forwarded[0].event.getModifierState?.("CapsLock"), true);
});

test("synthetic releases use reverse press order and remaining modifier state", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 8 | 2);
  const encoded: string[] = [];
  const forward = (input: KittyKeyboardBroadcastInput) => {
    if (input.kind === "key") {
      const sequence = encodeKittyKeyEvent(state, input.event);
      if (sequence) encoded.push(sequence);
    }
    return { targetSessionIds: ["target"] };
  };
  const releases = new Map([
    ["ControlLeft", {
      event: {
        type: "keydown",
        key: "Control",
        code: "ControlLeft",
        ctrlKey: true,
      },
      targetSessionIds: ["target"],
    }],
    ["KeyA", {
      event: {
        type: "keydown",
        key: "a",
        code: "KeyA",
        ctrlKey: true,
      },
      targetSessionIds: ["target"],
    }],
  ]);
  flushKittyKeyboardBroadcastReleases(releases, forward);
  assert.deepEqual(encoded, [
    "\u001b[97;5:3u",
    "\u001b[57442;1:3u",
  ]);

  const pairedControls = new Map([
    ["ControlLeft", {
      event: { type: "keydown", key: "Control", code: "ControlLeft", ctrlKey: true },
      targetSessionIds: ["target"],
    }],
    ["ControlRight", {
      event: { type: "keydown", key: "Control", code: "ControlRight", ctrlKey: true },
      targetSessionIds: ["target"],
    }],
  ]);
  encoded.length = 0;
  flushKittyKeyboardBroadcastReleases(pairedControls, forward);
  assert.deepEqual(encoded, [
    "\u001b[57448;5:3u",
    "\u001b[57442;1:3u",
  ]);
});

test("synthetic AltGraph release drops its implicit Ctrl and Alt modifiers", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 8 | 2);
  const encoded: string[] = [];
  const releases = new Map([
    ["AltRight", {
      event: {
        type: "keydown",
        key: "AltGraph",
        code: "AltRight",
        ctrlKey: true,
        altKey: true,
        getModifierState: (name: string) => name === "AltGraph",
      },
      targetSessionIds: ["target"],
    }],
  ]);
  flushKittyKeyboardBroadcastReleases(releases, (input) => {
    if (input.kind === "key") {
      const sequence = encodeKittyKeyEvent(state, input.event);
      if (sequence) encoded.push(sequence);
    }
    return { targetSessionIds: ["target"] };
  });
  assert.deepEqual(encoded, ["\u001b[57453;1:3u"]);
});

test("synthetic releases use the final CapsLock and NumLock state", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 8 | 2);
  for (const [lock, lockCode, modifier] of [
    ["CapsLock", 57358, 65],
    ["NumLock", 57360, 129],
  ] as const) {
    const encoded: string[] = [];
    const releases = new Map([
      ["KeyA", {
        event: {
          type: "keydown",
          key: "a",
          code: "KeyA",
          getModifierState: () => false,
        },
        targetSessionIds: ["target"],
      }],
      [lock, {
        event: {
          type: "keydown",
          key: lock,
          code: lock,
          getModifierState: (name: string) => name === lock,
        },
        targetSessionIds: ["target"],
      }],
    ]);
    flushKittyKeyboardBroadcastReleases(releases, (input) => {
      if (input.kind === "key") {
        const sequence = encodeKittyKeyEvent(state, input.event);
        if (sequence) encoded.push(sequence);
      }
      return { targetSessionIds: ["target"] };
    });
    assert.deepEqual(encoded, [
      `\u001b[${lockCode};${modifier}:3u`,
      `\u001b[97;${modifier}:3u`,
    ]);
  }
});

test("a normally released lock key still controls later synthetic releases", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 8 | 2);
  for (const [lockState, modifier] of [
    [{ capsLock: true, numLock: false }, 65],
    [{ capsLock: false, numLock: true }, 129],
  ] as const) {
    const releases = new Map([
      ["KeyA", {
        event: {
          type: "keydown",
          key: "a",
          code: "KeyA",
          getModifierState: () => false,
        },
        targetSessionIds: ["target"],
      }],
    ]);
    const encoded: string[] = [];
    flushKittyKeyboardBroadcastReleases(releases, (input) => {
      if (input.kind === "key") {
        const sequence = encodeKittyKeyEvent(state, input.event);
        if (sequence) encoded.push(sequence);
      }
      return { targetSessionIds: ["target"] };
    }, lockState);
    assert.deepEqual(encoded, [`\u001b[97;${modifier}:3u`]);
  }
});

test("repeat presses retain every target that is owed a release", () => {
  const releases = new Map<string, KittyKeyboardForwardedPress>();
  upsertKittyKeyboardForwardedPress(releases, "KeyA", {
    type: "keydown",
    key: "a",
    code: "KeyA",
  }, ["target-a"]);
  upsertKittyKeyboardForwardedPress(releases, "KeyA", {
    type: "keydown",
    key: "a",
    code: "KeyA",
    repeat: true,
  }, ["target-b"]);
  upsertKittyKeyboardForwardedPress(releases, "KeyA", {
    type: "keydown",
    key: "a",
    code: "KeyA",
    repeat: true,
  }, []);
  assert.deepEqual(releases.get("KeyA")?.targetSessionIds, ["target-a", "target-b"]);
  assert.equal(releases.get("KeyA")?.event.repeat, true);

  const releaseTargets: string[][] = [];
  flushKittyKeyboardBroadcastReleases(releases, (_input, _force, targetSessionIds) => {
    releaseTargets.push(targetSessionIds ?? []);
  });
  assert.deepEqual(releaseTargets, [["target-a", "target-b"]]);
});

test("each broadcast target encodes key press and release from its own flags", () => {
  const plain = createKittyKeyboardModeState();
  const enhanced = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(enhanced, 8 | 2);
  const plainKeys = new Set<string>();
  const enhancedKeys = new Set<string>();
  const plainLegacySuppressedKeys = new Set<string>();
  const enhancedLegacySuppressedKeys = new Set<string>();
  const keydown: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keydown", key: "a", code: "KeyA" },
  };
  const legacy: KittyKeyboardBroadcastInput = {
    kind: "legacy",
    data: "a",
    keyIdentity: "KeyA",
  };
  const keyup: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keyup", key: "a", code: "KeyA" },
  };

  assert.equal(resolveKittyKeyboardBroadcastInput(keydown, {
    kittyProtocolEnabled: true,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys: plainKeys,
    legacySuppressedKeys: plainLegacySuppressedKeys,
  }), null);
  assert.deepEqual(resolveKittyKeyboardBroadcastInput(keydown, {
    kittyProtocolEnabled: true,
    kittyMode: enhanced,
    applicationCursorMode: false,
    encodedKeys: enhancedKeys,
    legacySuppressedKeys: enhancedLegacySuppressedKeys,
  }), { data: "\u001b[97u", kittyEncoded: true, urgentInterrupt: false });
  assert.deepEqual(resolveKittyKeyboardBroadcastInput(legacy, {
    kittyProtocolEnabled: true,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys: plainKeys,
    legacySuppressedKeys: plainLegacySuppressedKeys,
  }), { data: "a", kittyEncoded: false, urgentInterrupt: false });
  assert.equal(resolveKittyKeyboardBroadcastInput(legacy, {
    kittyProtocolEnabled: true,
    kittyMode: enhanced,
    applicationCursorMode: false,
    encodedKeys: enhancedKeys,
    legacySuppressedKeys: enhancedLegacySuppressedKeys,
  }), null);
  assert.deepEqual(resolveKittyKeyboardBroadcastInput(keyup, {
    kittyProtocolEnabled: true,
    kittyMode: enhanced,
    applicationCursorMode: false,
    encodedKeys: enhancedKeys,
    legacySuppressedKeys: enhancedLegacySuppressedKeys,
  }), { data: "\u001b[97;1:3u", kittyEncoded: true, urgentInterrupt: false });
});

test("broadcast encodes Option-as-Meta dead keys from their physical code", () => {
  const enhanced = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(enhanced, 1 | 2);
  const options = {
    kittyProtocolEnabled: true,
    kittyMode: enhanced,
    applicationCursorMode: false,
    encodedKeys: new Set<string>(),
    legacySuppressedKeys: new Set<string>(),
  };
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    event: {
      type: "keydown",
      key: "Dead",
      code: "KeyE",
      altKey: true,
      altKeyProducesText: false,
    },
  }, options), { data: "\u001b[101;3u", kittyEncoded: true, urgentInterrupt: false });
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    event: {
      type: "keyup",
      key: "Dead",
      code: "KeyE",
      altKey: true,
      altKeyProducesText: false,
    },
  }, options), { data: "\u001b[101;3:3u", kittyEncoded: true, urgentInterrupt: false });
});

test("broadcast composition text follows each target's negotiated mode", () => {
  const plain = createKittyKeyboardModeState();
  const reportAll = createKittyKeyboardModeState();
  const associatedText = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(reportAll, 8);
  setKittyKeyboardModeFlags(associatedText, 8 | 16);
  const input: KittyKeyboardBroadcastInput = { kind: "text", text: "你a" };
  const resolve = (kittyMode: ReturnType<typeof createKittyKeyboardModeState>) => (
    resolveKittyKeyboardBroadcastInput(input, {
      kittyProtocolEnabled: true,
      kittyMode,
      applicationCursorMode: false,
      encodedKeys: new Set<string>(),
    })
  );

  assert.deepEqual(resolve(plain), {
    data: "你a",
    kittyEncoded: false,
    urgentInterrupt: false,
  });
  assert.deepEqual(resolve(reportAll), {
    data: "\u001b[0u",
    kittyEncoded: true,
    urgentInterrupt: false,
  });
  assert.deepEqual(resolve(associatedText), {
    data: "\u001b[0;;20320:97u",
    kittyEncoded: true,
    urgentInterrupt: false,
  });
});

test("enhanced sources can fall back to reliable legacy data for plain targets", () => {
  const plain = createKittyKeyboardModeState();
  const encodedKeys = new Set<string>();
  const resolved = resolveKittyKeyboardBroadcastInput({
    kind: "key",
    fallbackToLegacy: true,
    event: { type: "keydown", key: "ArrowUp", code: "ArrowUp" },
  }, {
    kittyProtocolEnabled: true,
    kittyMode: plain,
    applicationCursorMode: true,
    encodedKeys,
  });
  assert.deepEqual(resolved, { data: "\u001bOA", kittyEncoded: false, urgentInterrupt: false });

  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    fallbackToLegacy: true,
    event: { type: "keydown", key: "3", code: "Digit3", ctrlKey: true },
  }, {
    kittyProtocolEnabled: false,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys,
  }), { data: "\u001b", kittyEncoded: false, urgentInterrupt: false });
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    fallbackToLegacy: true,
    event: { type: "keydown", key: "c", code: "KeyC", ctrlKey: true, altKey: true },
  }, {
    kittyProtocolEnabled: false,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys,
  }), { data: "\u001b\x03", kittyEncoded: false, urgentInterrupt: false });
  for (const [event, data] of [
    [{ type: "keydown", key: "Tab", code: "Tab", altKey: true }, "\u001b\t"],
    [{ type: "keydown", key: "Tab", code: "Tab", ctrlKey: true, altKey: true }, "\u001b\t"],
    [{ type: "keydown", key: "Tab", code: "Tab", shiftKey: true, altKey: true }, "\u001b\u001b[Z"],
  ] as const) {
    assert.deepEqual(resolveKittyKeyboardBroadcastInput({
      kind: "key",
      fallbackToLegacy: true,
      event,
    }, {
      kittyProtocolEnabled: false,
      kittyMode: plain,
      applicationCursorMode: false,
      encodedKeys: new Set<string>(),
    }), { data, kittyEncoded: false, urgentInterrupt: false });
  }
});

test("plain Kitty targets preserve modified non-ASCII keys without a legacy fallback", () => {
  const plain = createKittyKeyboardModeState();
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    fallbackToLegacy: true,
    event: {
      type: "keydown",
      key: "ж",
      code: "IntlBackslash",
      keyCode: 226,
      ctrlKey: true,
    },
  }, {
    kittyProtocolEnabled: true,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys: new Set<string>(),
  }), { data: "\u001b[1078;5u", kittyEncoded: true, urgentInterrupt: false });
});

test("enhanced Ctrl+C fallback keeps urgent interrupt semantics for plain targets", () => {
  const plain = createKittyKeyboardModeState();
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    fallbackToLegacy: true,
    urgentInterrupt: true,
    event: { type: "keydown", key: "c", code: "KeyC", ctrlKey: true },
  }, {
    kittyProtocolEnabled: true,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys: new Set<string>(),
  }), { data: "\x03", kittyEncoded: false, urgentInterrupt: true });
});

test("an urgent legacy press still pairs with an event-reporting release", () => {
  const reportEvents = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(reportEvents, 2);
  const encodedKeys = new Set<string>();
  const legacySuppressedKeys = new Set<string>();
  const options = {
    kittyProtocolEnabled: true,
    kittyMode: reportEvents,
    applicationCursorMode: false,
    encodedKeys,
    legacySuppressedKeys,
  };
  assert.equal(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    event: { type: "keydown", key: "c", code: "KeyC", ctrlKey: true },
  }, options), null);
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "legacy",
    data: "\x03",
    keyIdentity: "KeyC",
    urgentInterrupt: true,
  }, options), { data: "\x03", kittyEncoded: false, urgentInterrupt: true });
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    event: { type: "keyup", key: "c", code: "KeyC", ctrlKey: true },
  }, options), {
    data: "\u001b[99;5:3u",
    kittyEncoded: true,
    urgentInterrupt: false,
  });
});

test("clearing transient state removes stale legacy suppression", () => {
  const mode = createKittyKeyboardModeState();
  const encodedKeys = new Set(["KeyC"]);
  const legacySuppressedKeys = new Set(["KeyC"]);
  clearKittyKeyboardBroadcastPairingState(encodedKeys, legacySuppressedKeys);
  assert.deepEqual(resolveKittyKeyboardBroadcastInput({
    kind: "legacy",
    data: "\x03",
    keyIdentity: "KeyC",
    urgentInterrupt: true,
  }, {
    kittyProtocolEnabled: true,
    kittyMode: mode,
    applicationCursorMode: false,
    encodedKeys,
    legacySuppressedKeys,
  }), { data: "\x03", kittyEncoded: false, urgentInterrupt: true });
});

test("urgent fallback prioritizes the target before interrupting it", () => {
  const plain = createKittyKeyboardModeState();
  const calls: string[] = [];
  const dispose = registerKittyKeyboardBroadcastHandler(
    "urgent-target",
    createKittyKeyboardBroadcastHandler({
      resolveOptions: () => ({
        kittyProtocolEnabled: true,
        kittyMode: plain,
        applicationCursorMode: false,
        encodedKeys: new Set<string>(),
      }),
      getSessionId: () => "connected-session",
      isConnected: () => true,
      isRuntimeDisposed: () => false,
      interruptSession: () => calls.push("interrupt"),
      writeDisposed: () => calls.push("disposed-write"),
      writeActive: () => calls.push("active-write"),
    }),
  );
  dispatchKittyKeyboardBroadcastInput("urgent-target", {
    kind: "key",
    fallbackToLegacy: true,
    urgentInterrupt: true,
    event: { type: "keydown", key: "c", code: "KeyC", ctrlKey: true },
  }, {
    beforeUrgentInterrupt: () => calls.push("prioritize"),
  });
  assert.deepEqual(calls, ["prioritize", "interrupt"]);
  dispose();
  clearKittyKeyboardBroadcastSession("urgent-target");
});

test("plain targets derive cursor sequences from their own mode without duplicating source bytes", () => {
  const plain = createKittyKeyboardModeState();
  const encodedKeys = new Set<string>();
  const keyInput: KittyKeyboardBroadcastInput = {
    kind: "key",
    fallbackToLegacy: true,
    event: { type: "keydown", key: "ArrowUp", code: "ArrowUp" },
  };
  assert.deepEqual(resolveKittyKeyboardBroadcastInput(keyInput, {
    kittyProtocolEnabled: false,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys,
  }), { data: "\u001b[A", kittyEncoded: false, urgentInterrupt: false });
  assert.equal(resolveKittyKeyboardBroadcastInput({
    kind: "legacy",
    data: "\u001bOA",
    keyIdentity: "ArrowUp",
  }, {
    kittyProtocolEnabled: false,
    kittyMode: plain,
    applicationCursorMode: false,
    encodedKeys,
  }), null);
});

test("keyup clears target pairing even when its flags do not encode releases", () => {
  const disambiguate = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(disambiguate, 1);
  const encodedKeys = new Set(["KeyG"]);
  assert.equal(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    event: { type: "keyup", key: "g", code: "KeyG", metaKey: true },
  }, {
    kittyProtocolEnabled: true,
    kittyMode: disambiguate,
    applicationCursorMode: false,
    encodedKeys,
  }), null);
  assert.equal(encodedKeys.has("KeyG"), false);
  assert.equal(resolveKittyKeyboardBroadcastInput({
    kind: "key",
    event: { type: "keyup", key: "g", code: "KeyG", metaKey: true },
  }, {
    kittyProtocolEnabled: true,
    kittyMode: disambiguate,
    applicationCursorMode: false,
    encodedKeys,
  }), null);
});

test("queued inputs survive a temporarily absent hibernated target handler", () => {
  const received: KittyKeyboardBroadcastInput[] = [];
  const input: KittyKeyboardBroadcastInput = {
    kind: "key",
    event: { type: "keydown", key: "a", code: "KeyA" },
  };
  assert.equal(dispatchKittyKeyboardBroadcastInput("hibernated-target", input), true);
  const dispose = registerKittyKeyboardBroadcastHandler(
    "hibernated-target",
    (next) => received.push(next),
  );
  assert.deepEqual(received, [input]);
  dispose();
  clearKittyKeyboardBroadcastSession("hibernated-target");
});

test("a disposed runtime writes broadcasts directly and its replacement does not replay them", () => {
  const mode = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(mode, 8 | 16);
  const disposedWrites: Array<{ sessionId: string; data: string }> = [];
  const activeWrites: string[] = [];
  const disposedHandler = createKittyKeyboardBroadcastHandler({
    resolveOptions: () => ({
      kittyProtocolEnabled: true,
      kittyMode: mode,
      applicationCursorMode: false,
      encodedKeys: new Set<string>(),
    }),
    getSessionId: () => "connected-session",
    isConnected: () => true,
    isRuntimeDisposed: () => true,
    writeDisposed: (sessionId, data) => disposedWrites.push({ sessionId, data }),
    writeActive: (data) => activeWrites.push(data),
  });
  const disposeOldRegistration = registerKittyKeyboardBroadcastHandler(
    "runtime-target",
    disposedHandler,
  );

  dispatchKittyKeyboardBroadcastInput("runtime-target", { kind: "text", text: "你" });
  dispatchKittyKeyboardBroadcastInput("runtime-target", {
    kind: "key",
    event: { type: "keydown", key: "F13", code: "F13" },
  });
  assert.deepEqual(disposedWrites, [
    { sessionId: "connected-session", data: "\u001b[0;;20320u" },
    { sessionId: "connected-session", data: "\u001b[57376u" },
  ]);
  assert.deepEqual(activeWrites, []);

  const replacementMode = createKittyKeyboardModeState();
  const disposeReplacement = registerKittyKeyboardBroadcastHandler(
    "runtime-target",
    createKittyKeyboardBroadcastHandler({
      resolveOptions: () => ({
        kittyProtocolEnabled: true,
        kittyMode: replacementMode,
        applicationCursorMode: false,
        encodedKeys: new Set<string>(),
      }),
      getSessionId: () => "connected-session",
      isConnected: () => true,
      isRuntimeDisposed: () => false,
      writeDisposed: (sessionId, data) => disposedWrites.push({ sessionId, data }),
      writeActive: (data) => activeWrites.push(data),
    }),
  );
  disposeOldRegistration();
  dispatchKittyKeyboardBroadcastInput("runtime-target", { kind: "text", text: "restored" });
  assert.deepEqual(activeWrites, ["restored"]);
  assert.equal(disposedWrites.length, 2);

  disposeReplacement();
  clearKittyKeyboardBroadcastSession("runtime-target");
});

test("a key pressed while disconnected cannot produce an orphan release after reconnect", () => {
  const mode = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(mode, 8 | 2);
  const writes: string[] = [];
  const encodedKeys = new Set<string>();
  const legacySuppressedKeys = new Set<string>();
  let connected = false;
  const handler = createKittyKeyboardBroadcastHandler({
    resolveOptions: () => ({
      kittyProtocolEnabled: true,
      kittyMode: mode,
      applicationCursorMode: false,
      encodedKeys,
      legacySuppressedKeys,
    }),
    getSessionId: () => "reconnecting-session",
    isConnected: () => connected,
    isRuntimeDisposed: () => false,
    writeDisposed: (_sessionId, data) => writes.push(data),
    writeActive: (data) => writes.push(data),
  });
  handler({
    kind: "key",
    event: { type: "keydown", key: "a", code: "KeyA" },
  });
  connected = true;
  handler({
    kind: "key",
    event: { type: "keyup", key: "a", code: "KeyA" },
  });
  assert.deepEqual(writes, []);
});
