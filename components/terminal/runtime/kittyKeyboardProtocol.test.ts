import test from "node:test";
import assert from "node:assert/strict";

import {
  buildKittyKeyboardModeQueryResponse,
  createKittyKeyboardModeState,
  createKittyKeyboardSessionStateStore,
  encodeKittyCompositionText,
  encodeKittyKeyEvent,
  encodeLegacyKeyboardEvent,
  popKittyKeyboardModeFlags,
  pushKittyKeyboardModeFlags,
  restoreKittyKeyboardModeState,
  setKittyKeyboardAlternateScreenActive,
  setKittyKeyboardModeFlags,
  snapshotKittyKeyboardModeState,
  shouldExpectLegacyKeyboardData,
  shouldMarkKittyTextInputEvent,
  shouldTreatKittyAltAsText,
  shouldTrackKittyKeyRelease,
} from "./kittyKeyboardProtocol";
import {
  installKittyKeyboardProtocolHandlers,
  installKittyKeyboardProtocolHandlersIfEnabled,
  readKittyKeyboardCsiParam,
  type KittyKeyboardCsiParams,
} from "./kittyKeyboardRuntime";

type CsiHandlerId = { prefix?: string; intermediates?: string; final: string };
type CsiHandler = (params: KittyKeyboardCsiParams) => boolean;
const csiKey = (id: CsiHandlerId): string => `${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`;

const createFakeCsiParser = () => {
  const handlers = new Map<string, CsiHandler[]>();
  return {
    parser: {
      registerCsiHandler(id: CsiHandlerId, callback: CsiHandler) {
        const key = csiKey(id);
        const list = handlers.get(key) ?? [];
        list.push(callback);
        handlers.set(key, list);
        return { dispose: () => handlers.set(key, (handlers.get(key) ?? []).filter((item) => item !== callback)) };
      },
      registerEscHandler(id: { intermediates?: string; final: string }, callback: () => boolean) {
        const key = `ESC|${id.intermediates ?? ""}|${id.final}`;
        const list = handlers.get(key) ?? [];
        list.push(callback);
        handlers.set(key, list);
        return { dispose: () => handlers.set(key, (handlers.get(key) ?? []).filter((item) => item !== callback)) };
      },
    },
    dispatch(id: CsiHandlerId, params: KittyKeyboardCsiParams = []) {
      const list = handlers.get(csiKey(id));
      assert.ok(list?.length, `missing CSI handler for ${csiKey(id)}`);
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index](params)) return true;
      }
      return false;
    },
    hasHandler(id: CsiHandlerId) {
      return (handlers.get(csiKey(id))?.length ?? 0) > 0;
    },
    dispatchEsc(id: { intermediates?: string; final: string }) {
      const list = handlers.get(`ESC|${id.intermediates ?? ""}|${id.final}`);
      assert.ok(list?.length, `missing ESC handler for ${id.final}`);
      return list.at(-1)!([]);
    },
  };
};

const withFlags = (flags: number) => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, flags);
  return state;
};

const event = (key: string, overrides: Record<string, unknown> = {}) => ({
  type: "keydown",
  key,
  code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key,
  getModifierState: () => false,
  ...overrides,
});

test("negotiates all five enhancement flags and masks unknown bits", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 0xff);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?31u");
  setKittyKeyboardModeFlags(state, 8, 3);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?23u");
  setKittyKeyboardModeFlags(state, 8, 2);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?31u");
});

test("maintains bounded independent main and alternate screen stacks", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 1);
  for (let flags = 0; flags < 40; flags += 1) pushKittyKeyboardModeFlags(state, flags);
  assert.equal(state.mainStack.length, 32);
  setKittyKeyboardAlternateScreenActive(state, true);
  setKittyKeyboardModeFlags(state, 16);
  pushKittyKeyboardModeFlags(state, 8);
  assert.equal(popKittyKeyboardModeFlags(state), 16);
  assert.equal(popKittyKeyboardModeFlags(state), 0);
  setKittyKeyboardAlternateScreenActive(state, false);
  assert.notEqual(buildKittyKeyboardModeQueryResponse(state), "\u001b[?16u");
});

test("snapshots and restores negotiated state across renderer handoffs", () => {
  const source = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(source, 1 | 8);
  pushKittyKeyboardModeFlags(source, 2 | 4);
  setKittyKeyboardAlternateScreenActive(source, true);
  setKittyKeyboardModeFlags(source, 16);
  pushKittyKeyboardModeFlags(source, 1 | 2 | 8);

  const restored = createKittyKeyboardModeState();
  restoreKittyKeyboardModeState(restored, snapshotKittyKeyboardModeState(source));
  assert.deepEqual(restored, source);
  restored.mainStack.push(31);
  assert.notDeepEqual(restored, source);
});

test("disambiguates ambiguous ASCII and modified control keys", () => {
  const state = withFlags(1);
  assert.equal(encodeKittyKeyEvent(state, event("a")), null);
  assert.equal(encodeKittyKeyEvent(state, event("Escape")), "\u001b[27u");
  assert.equal(encodeKittyKeyEvent(state, event("c", { ctrlKey: true })), "\u001b[99;5u");
  const disambiguate = withFlags(1);
  assert.equal(
    encodeKittyKeyEvent(disambiguate, event("c", {
      ctrlKey: true,
      getModifierState: (name: string) => name === "CapsLock" || name === "NumLock",
    })),
    "\u001b[99;197u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("[", { code: "BracketLeft", altKey: true })), "\u001b[91;3u");
  assert.equal(encodeKittyKeyEvent(state, event("Enter", { shiftKey: true })), "\u001b[13;2u");
});

test("alternate-key reporting alone never changes which events are encoded", () => {
  const state = withFlags(4);
  assert.equal(encodeKittyKeyEvent(state, event("Escape")), null);
  assert.equal(encodeKittyKeyEvent(state, event("c", { ctrlKey: true })), null);
  assert.equal(encodeKittyKeyEvent(state, event("Enter", { shiftKey: true })), "\r");
  assert.equal(encodeKittyKeyEvent(state, event("Tab", { shiftKey: true })), "\u001b[Z");
  assert.equal(
    encodeKittyKeyEvent(state, event("с", { code: "KeyC", ctrlKey: true })),
    "\u001b[1089::99;5u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("c", { code: "KeyJ", ctrlKey: true })),
    "\u001b[99::106;5u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(";", { code: "KeyQ", ctrlKey: true })),
    "\u001b[59::113;5u",
  );
});

test("baseline mode preserves Ctrl+Shift combinations that legacy encoding loses", () => {
  const state = withFlags(0);
  assert.equal(
    encodeKittyKeyEvent(state, event("I", { code: "KeyI", ctrlKey: true, shiftKey: true })),
    "\u001b[105;6u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("i", { ctrlKey: true })), null);
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", { code: "Space", ctrlKey: true, shiftKey: true })),
    "\0",
  );
  assert.equal(encodeKittyKeyEvent(state, event("F13")), "\u001b[57376u");
  assert.equal(encodeKittyKeyEvent(state, event("F13", { repeat: true })), "\u001b[57376u");
  assert.equal(encodeKittyKeyEvent(state, event("PrintScreen")), "\u001b[57361u");
  assert.equal(encodeKittyKeyEvent(state, event("ContextMenu")), "\u001b[29~");
  assert.equal(
    encodeKittyKeyEvent(state, event("ContextMenu", { repeat: true })),
    "\u001b[29~",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("a", { metaKey: true })),
    "\u001b[97;9u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("i", { ctrlKey: true, shiftKey: true, altKey: true })),
    "\u001b[105;8u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", {
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
      getModifierState: (name: string) => name === "Hyper",
    })),
    "\u001b[32;22u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Clear", { code: "Numpad5" })),
    "\u001b[E",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Clear", {
      code: "Numpad5",
      applicationCursorMode: true,
    })),
    "\u001bOE",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Clear", {
      code: "Numpad5",
      ctrlKey: true,
      applicationCursorMode: true,
    })),
    "\u001b[1;5E",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Tab", { altKey: true })),
    "\u001b\t",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Tab", { ctrlKey: true, altKey: true })),
    "\u001b\t",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Tab", { shiftKey: true, altKey: true })),
    "\u001b\u001b[Z",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Tab", {
      shiftKey: true,
      ctrlKey: true,
      altKey: true,
    })),
    "\u001b[9;8u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Insert", { shiftKey: true })),
    "\u001b[2;2~",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("PageUp", { altKey: true })),
    "\u001b[5;3~",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("ArrowUp", { metaKey: true })),
    "\u001b[1;9A",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("ArrowUp", {
      getModifierState: (name: string) => name === "Hyper",
    })),
    "\u001b[1;17A",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("ArrowUp", {
      getModifierState: (name: string) => name === "KittyMeta",
    })),
    "\u001b[1;33A",
  );
  const alternateOnly = withFlags(4);
  assert.equal(encodeKittyKeyEvent(alternateOnly, event("F13")), "\u001b[57376u");
  assert.equal(encodeKittyKeyEvent(alternateOnly, event("PrintScreen")), "\u001b[57361u");
  assert.equal(encodeKittyKeyEvent(alternateOnly, event("ContextMenu")), "\u001b[29~");
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("ContextMenu", {
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[29;65~",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("Clear", {
      code: "Numpad5",
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[1;65E",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("ArrowUp", {
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[1;65A",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("ArrowUp", {
      altKey: true,
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[1;67A",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("Insert", {
      shiftKey: true,
      getModifierState: (name: string) => name === "NumLock",
    })),
    "\u001b[2;130~",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("Tab", {
      altKey: true,
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b\t",
  );
  for (const [key, expected] of [
    ["Enter", "\u001b\r"],
    ["Backspace", "\u001b\u007f"],
    ["Escape", "\u001b\u001b"],
  ] as const) {
    assert.equal(
      encodeKittyKeyEvent(alternateOnly, event(key, {
        altKey: true,
        getModifierState: (name: string) => name === "CapsLock",
      })),
      expected,
    );
  }
  for (const flags of [2, 4, 16]) {
    for (const [lock, modifier] of [
      ["CapsLock", 69],
      ["NumLock", 133],
    ] as const) {
      assert.equal(
        encodeKittyKeyEvent(withFlags(flags), event("c", {
          code: "KeyC",
          ctrlKey: true,
          getModifierState: (name: string) => name === lock,
        })),
        `\u001b[99;${modifier}u`,
      );
    }
  }
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event("a", {
      code: "KeyA",
      altKey: true,
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[97;67u",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event(";", {
      code: "Semicolon",
      ctrlKey: true,
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[59;69u",
  );
  assert.equal(
    encodeKittyKeyEvent(alternateOnly, event(" ", {
      code: "Space",
      ctrlKey: true,
      getModifierState: (name: string) => name === "CapsLock",
    })),
    "\u001b[32;69u",
  );
});

test("legacy fallback preserves text, controls, and application cursor mode", () => {
  assert.equal(encodeLegacyKeyboardEvent(event("a")), "a");
  assert.equal(encodeLegacyKeyboardEvent(event("c", { ctrlKey: true })), "\x03");
  assert.equal(
    encodeLegacyKeyboardEvent(event("3", { code: "Digit3", ctrlKey: true })),
    "\u001b",
  );
  assert.equal(
    encodeLegacyKeyboardEvent(event("c", { ctrlKey: true, altKey: true })),
    "\u001b\x03",
  );
  assert.equal(encodeLegacyKeyboardEvent(event("ArrowUp"), true), "\u001bOA");
  assert.equal(encodeLegacyKeyboardEvent(event("ArrowUp", { ctrlKey: true }), true), "\u001b[1;5A");
  assert.equal(encodeLegacyKeyboardEvent(event("F5")), "\u001b[15~");
  for (const [key, code] of [
    [";", "Semicolon"],
    ["'", "Quote"],
    [",", "Comma"],
    [".", "Period"],
    ["0", "Digit0"],
    ["1", "Digit1"],
    ["9", "Digit9"],
  ] as const) {
    assert.equal(encodeLegacyKeyboardEvent(event(key, { code, ctrlKey: true })), key);
  }
  assert.equal(
    encodeLegacyKeyboardEvent(event(";", { code: "Semicolon", ctrlKey: true, altKey: true })),
    "\u001b;",
  );
});

test("baseline and event-type press preserve unmapped legacy Ctrl ASCII", () => {
  for (const flags of [0, 2, 4, 16]) {
    assert.equal(
      encodeKittyKeyEvent(withFlags(flags), event(";", { code: "Semicolon", ctrlKey: true })),
      ";",
    );
  }
  assert.equal(
    encodeKittyKeyEvent(withFlags(1), event(";", { code: "Semicolon", ctrlKey: true })),
    "\u001b[59;5u",
  );
  for (const [key, code, expected] of [
    ["ж", "Semicolon", ";"],
    ["э", "Quote", "'"],
    ["б", "Comma", ","],
    ["ю", "Period", "."],
  ] as const) {
    assert.equal(
      encodeKittyKeyEvent(withFlags(0), event(key, { code, ctrlKey: true })),
      expected,
    );
    assert.equal(
      encodeKittyKeyEvent(withFlags(2), event(key, { code, ctrlKey: true })),
      expected,
    );
    assert.equal(
      encodeLegacyKeyboardEvent(event(key, { code, ctrlKey: true })),
      expected,
    );
  }
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("c", { code: "KeyJ", ctrlKey: true })),
    "\x03",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("c", {
      code: "KeyJ",
      ctrlKey: true,
      altKey: true,
    })),
    "\u001b\x03",
  );
  assert.equal(
    encodeLegacyKeyboardEvent(event("c", { code: "KeyJ", ctrlKey: true })),
    "\x03",
  );
  assert.equal(
    encodeLegacyKeyboardEvent(event("3", { code: "Semicolon", ctrlKey: true })),
    "\u001b",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("j", { code: "KeyC", ctrlKey: true })),
    "\x0a",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("j", {
      code: "KeyC",
      ctrlKey: true,
      altKey: true,
    })),
    "\u001b\x0a",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("a", {
      code: "IntlBackslash",
      keyCode: 226,
      ctrlKey: true,
    })),
    "\x01",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(2), event("a", {
      code: "IntlBackslash",
      keyCode: 226,
      ctrlKey: true,
      altKey: true,
    })),
    "\u001b\x01",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("ж", {
      code: "IntlBackslash",
      keyCode: 226,
      ctrlKey: true,
    })),
    "\u001b[1078;5u",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(2), event("ж", {
      code: "IntlBackslash",
      keyCode: 226,
      ctrlKey: true,
      altKey: true,
    })),
    "\u001b[1078;7u",
  );
});

test("macOS Option text does not depend on the asynchronous layout map", () => {
  assert.equal(shouldTreatKittyAltAsText({ key: "å", altKey: true }, true, false), true);
  assert.equal(shouldTreatKittyAltAsText({ key: "a", altKey: true }, true, false), true);
  assert.equal(shouldTreatKittyAltAsText({ key: "Dead", altKey: true }, true, false), true);
  assert.equal(shouldTreatKittyAltAsText({ key: "ArrowLeft", altKey: true }, true, false), false);
  assert.equal(shouldTreatKittyAltAsText({ key: "å", altKey: true }, true, true), false);
  assert.equal(shouldTreatKittyAltAsText({ key: "Dead", altKey: true }, true, true), false);
  assert.equal(shouldTreatKittyAltAsText({ key: "å", altKey: true }, false, false), false);
});

test("macOS Option-as-Meta encodes physical dead keys while text-producing Option defers", () => {
  const state = withFlags(1 | 2);
  const optionN = event("Dead", {
    code: "KeyN",
    altKey: true,
    altKeyProducesText: false,
  });
  assert.equal(encodeKittyKeyEvent(state, optionN), "\u001b[110;3u");
  assert.equal(
    encodeKittyKeyEvent(state, { ...optionN, type: "keyup" }),
    "\u001b[110;3:3u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, { ...optionN, altKeyProducesText: true }),
    null,
  );
  assert.equal(
    encodeKittyKeyEvent(state, {
      ...optionN,
      ctrlKey: true,
      getModifierState: (name: string) => name === "AltGraph",
    }),
    null,
  );
});

test("baseline modes leave shifted AltGraph text to the browser input path", () => {
  const shiftedAltGraph = event("€", {
    code: "KeyE",
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    getModifierState: (name: string) => name === "AltGraph",
  });
  assert.equal(encodeKittyKeyEvent(withFlags(0), shiftedAltGraph), null);
  assert.equal(encodeKittyKeyEvent(withFlags(4), shiftedAltGraph), null);
});

test("legacy broadcast pairing ignores Meta shortcuts that produce no terminal data", () => {
  assert.equal(shouldExpectLegacyKeyboardData(event("a", { metaKey: true })), false);
  assert.equal(shouldExpectLegacyKeyboardData(event("a")), true);
  assert.equal(shouldExpectLegacyKeyboardData(event("Enter")), true);
});

test("reports press, repeat, and release only for eligible keys", () => {
  const state = withFlags(2);
  assert.equal(encodeKittyKeyEvent(state, event("Escape")), null);
  for (const [overrides, modifier] of [
    [{ shiftKey: true }, 2],
    [{ altKey: true }, 3],
    [{ ctrlKey: true }, 5],
    [{ metaKey: true }, 9],
    [{ getModifierState: (name: string) => name === "CapsLock" }, 65],
    [{ getModifierState: (name: string) => name === "NumLock" }, 129],
  ] as const) {
    assert.equal(
      encodeKittyKeyEvent(state, event("Escape", overrides)),
      `\u001b[27;${modifier}u`,
    );
  }
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", {
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    })),
    "\0",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", {
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
      repeat: true,
    })),
    "\u001b[32;6:2u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", {
      type: "keyup",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    })),
    "\u001b[32;6:3u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("ArrowUp")), "\u001b[A");
  assert.equal(encodeKittyKeyEvent(state, event("ArrowUp", { repeat: true })), "\u001b[1;1:2A");
  assert.equal(encodeKittyKeyEvent(state, event("ArrowUp", { type: "keyup" })), "\u001b[1;1:3A");
  assert.equal(encodeKittyKeyEvent(state, event("a", { repeat: true })), null);
  assert.equal(
    encodeKittyKeyEvent(state, event("A", { code: "KeyA", shiftKey: true, repeat: true })),
    null,
  );
  assert.equal(encodeKittyKeyEvent(state, event("a", { type: "keyup" })), "\u001b[97;1:3u");
  assert.equal(
    encodeKittyKeyEvent(state, event("A", { code: "KeyA", shiftKey: true, type: "keyup" })),
    "\u001b[97;2:3u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("Enter", { type: "keyup" })), null);
  assert.equal(encodeKittyKeyEvent(state, event("c", { ctrlKey: true })), null);
  assert.equal(
    encodeKittyKeyEvent(state, event("c", { ctrlKey: true, repeat: true })),
    "\u001b[99;5:2u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("c", { type: "keyup", ctrlKey: true })),
    "\u001b[99;5:3u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", { code: "Space", ctrlKey: true })),
    null,
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", { code: "Space", ctrlKey: true, repeat: true })),
    "\u001b[32;5:2u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event(" ", { code: "Space", ctrlKey: true, type: "keyup" })),
    "\u001b[32;5:3u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("Enter", { repeat: true })), null);
  assert.equal(encodeKittyKeyEvent(state, event("Tab", { repeat: true })), null);
  assert.equal(encodeKittyKeyEvent(state, event("Backspace", { repeat: true })), null);
  assert.equal(shouldTrackKittyKeyRelease(state, event("c", { ctrlKey: true })), true);
  assert.equal(shouldTrackKittyKeyRelease(state, event("Enter")), false);
});

test("event-type mode matches Kitty's printable-key release behavior", () => {
  const state = withFlags(2);
  assert.equal(encodeKittyKeyEvent(state, event("a")), null);
  assert.equal(encodeKittyKeyEvent(state, event("a", { repeat: true })), null);
  assert.equal(
    encodeKittyKeyEvent(state, event("a", { type: "keyup" })),
    "\u001b[97;1:3u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("A", { code: "KeyA", shiftKey: true, type: "keyup" })),
    "\u001b[97;2:3u",
  );
});

test("reports alternate shifted and PC-101 layout key values", () => {
  const state = withFlags(1 | 4);
  assert.equal(
    encodeKittyKeyEvent(state, event("+", { code: "Equal", shiftKey: true, ctrlKey: true })),
    "\u001b[61:43;6u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("с", { code: "KeyC", ctrlKey: true })),
    "\u001b[1089::99;5u",
  );
});

test("report-all encodes text, controls, modifiers, repeat, and release", () => {
  const state = withFlags(8);
  assert.equal(encodeKittyKeyEvent(state, event("a")), "\u001b[97u");
  assert.equal(encodeKittyKeyEvent(state, event("Enter")), "\u001b[13u");
  assert.equal(
    encodeKittyKeyEvent(state, event("Shift", { code: "ShiftLeft", shiftKey: true })),
    "\u001b[57441;2u",
  );

  setKittyKeyboardModeFlags(state, 2, 2);
  assert.equal(encodeKittyKeyEvent(state, event("a", { repeat: true })), "\u001b[97;1:2u");
  assert.equal(encodeKittyKeyEvent(state, event("a", { type: "keyup" })), "\u001b[97;1:3u");
  assert.equal(encodeKittyKeyEvent(state, event("Enter", { type: "keyup" })), "\u001b[13;1:3u");
});

test("associated text supports multiple code points and pure composition text", () => {
  const state = withFlags(8 | 16);
  assert.equal(
    encodeKittyKeyEvent(state, event("A", { code: "KeyA", shiftKey: true })),
    "\u001b[97;2;65u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("Enter")), "\u001b[13u");
  assert.equal(encodeKittyKeyEvent(state, event("F13")), "\u001b[57376u");
  assert.equal(
    encodeKittyKeyEvent(state, event("7", { code: "Numpad7" })),
    "\u001b[57406;;55u",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("+", { code: "NumpadAdd" })),
    "\u001b[57413;;43u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("Dead", { code: "Quote" })), null);
  assert.equal(
    encodeKittyKeyEvent(state, event("é", { code: "KeyE" })),
    "\u001b[101;;101:769u",
  );
  assert.equal(encodeKittyCompositionText(state, "你😀"), "\u001b[0;;20320:128512u");
  assert.equal(encodeKittyCompositionText(state, "\n\u0085"), null);
});

test("report-all without associated text emits an unidentified CSI-u composition event", () => {
  assert.equal(encodeKittyCompositionText(withFlags(8), "你"), "\u001b[0u");
});

test("encodes the complete functional, keypad, media, and modifier ranges", () => {
  const state = withFlags(8);
  const cases = [
    [event("F13"), "\u001b[57376u"],
    [event("F35"), "\u001b[57398u"],
    [event("7", { code: "Numpad7" }), "\u001b[57406u"],
    [event("Home", { code: "Numpad7" }), "\u001b[57423u"],
    [event("Delete", { code: "NumpadDecimal" }), "\u001b[57426u"],
    [event("Clear", { code: "Numpad5" }), "\u001b[57427~"],
    [event(",", { code: "NumpadComma" }), "\u001b[57416u"],
    [event("MediaPlay"), "\u001b[57428u"],
    [event("MediaRecord"), "\u001b[57437u"],
    [event("AudioVolumeMute"), "\u001b[57440u"],
    [event("ContextMenu"), "\u001b[57363u"],
    [event("Control", { code: "ControlRight", ctrlKey: true }), "\u001b[57448;5u"],
    [event("ISOLevel5Shift"), "\u001b[57454u"],
  ] as const;
  for (const [input, expected] of cases) assert.equal(encodeKittyKeyEvent(state, input), expected);
});

test("uses official enhanced F-key encodings and covers every F-key code", () => {
  const state = withFlags(8);
  assert.equal(encodeKittyKeyEvent(state, event("F1")), "\u001b[P");
  assert.equal(encodeKittyKeyEvent(state, event("F2")), "\u001b[Q");
  assert.equal(encodeKittyKeyEvent(state, event("F3")), "\u001b[13~");
  assert.equal(encodeKittyKeyEvent(state, event("F4")), "\u001b[S");
  assert.equal(
    encodeKittyKeyEvent(state, event("F3", { ctrlKey: true })),
    "\u001b[13;5~",
  );
  const legacyTilde = [15, 17, 18, 19, 20, 21, 23, 24];
  for (let number = 5; number <= 12; number += 1) {
    assert.equal(encodeKittyKeyEvent(state, event(`F${number}`)), `\u001b[${legacyTilde[number - 5]}~`);
  }
  for (let number = 13; number <= 35; number += 1) {
    assert.equal(encodeKittyKeyEvent(state, event(`F${number}`)), `\u001b[${57363 + number}u`);
  }
});

test("uses the F3 tilde form for modified baseline events", () => {
  const state = withFlags(0);
  assert.equal(encodeKittyKeyEvent(state, event("F3", { ctrlKey: true })), "\u001b[13;5~");
  assert.equal(encodeKittyKeyEvent(state, event("F3", { shiftKey: true })), "\u001b[13;2~");
  assert.equal(encodeKittyKeyEvent(state, event("F3", { altKey: true })), "\u001b[13;3~");
});

test("uses application cursor mode only for unmodified cursor keys", () => {
  const state = withFlags(8);
  assert.equal(
    encodeKittyKeyEvent(state, event("ArrowUp", { applicationCursorMode: true })),
    "\u001b[A",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Home", { applicationCursorMode: true })),
    "\u001b[H",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("End", { applicationCursorMode: true })),
    "\u001b[F",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("ArrowUp", {
      applicationCursorMode: true,
      ctrlKey: true,
    })),
    "\u001b[1;5A",
  );
});

test("recognizes xterm input-only text without treating paste as a key event", () => {
  assert.equal(shouldMarkKittyTextInputEvent({ data: "😀", inputType: "insertText" }), true);
  assert.equal(shouldMarkKittyTextInputEvent({ data: "hello", inputType: "insertFromPaste" }), false);
  assert.equal(shouldMarkKittyTextInputEvent({ data: null, inputType: "insertText" }), false);
});

test("preserves negotiated state only for renderer hibernation", () => {
  const store = createKittyKeyboardSessionStateStore();
  const sessionOwner = {};
  const initial = store.resolve(sessionOwner, false);
  setKittyKeyboardModeFlags(initial, 31);
  setKittyKeyboardAlternateScreenActive(initial, true);
  pushKittyKeyboardModeFlags(initial, 8);

  const awakened = store.resolve(sessionOwner, true);
  assert.equal(awakened, initial);
  assert.equal(awakened.alternateScreenActive, true);
  assert.equal(awakened.mainFlags, 31);
  assert.deepEqual(awakened.alternateStack, [0]);

  const reconnected = store.resolve(sessionOwner, false);
  assert.notEqual(reconnected, initial);
  assert.equal(buildKittyKeyboardModeQueryResponse(reconnected), "\u001b[?0u");
  assert.notEqual(store.resolve({}, true), reconnected);
  setKittyKeyboardModeFlags(reconnected, 8);
  store.reset(sessionOwner);
  assert.equal(buildKittyKeyboardModeQueryResponse(reconnected), "\u001b[?0u");
});

test("includes lock modifiers and excludes associated control text", () => {
  const state = withFlags(8 | 16);
  assert.equal(
    encodeKittyKeyEvent(state, event("a", {
      getModifierState: (name: string) => name === "CapsLock" || name === "NumLock",
    })),
    "\u001b[97;193;97u",
  );
  const altGraph = withFlags(1);
  assert.equal(
    encodeKittyKeyEvent(altGraph, event("@", {
      code: "KeyQ",
      ctrlKey: true,
      altKey: true,
      unshiftedKey: "q",
      getModifierState: (name: string) => name === "AltGraph",
    })),
    null,
  );
  assert.equal(
    encodeKittyKeyEvent(altGraph, event("å", {
      code: "KeyA",
      altKey: true,
      unshiftedKey: "a",
      altKeyProducesText: true,
    })),
    null,
  );
  assert.equal(encodeKittyKeyEvent(state, event("c", { ctrlKey: true })), "\u001b[99;5u");
  assert.equal(
    encodeKittyKeyEvent(state, event("a", {
      getModifierState: (name: string) => name === "Hyper" || name === "KittyMeta",
    })),
    "\u001b[97;49u",
  );
  assert.equal(encodeKittyKeyEvent(state, event("a", { metaKey: true })), "\u001b[97;9u");
});

test("baseline protocol excludes lock state from Ctrl+Shift disambiguation", () => {
  assert.equal(
    encodeKittyKeyEvent(withFlags(0), event("I", {
      code: "KeyI",
      ctrlKey: true,
      shiftKey: true,
      getModifierState: (name: string) => name === "CapsLock" || name === "NumLock",
    })),
    "\u001b[105;6u",
  );
});

test("disambiguation leaves text-producing keypad keys on their text path", () => {
  assert.equal(
    encodeKittyKeyEvent(withFlags(1), event("7", { code: "Numpad7" })),
    null,
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(1), event("Home", { code: "Numpad7" })),
    "\u001b[57423u",
  );
  assert.equal(
    encodeKittyKeyEvent(withFlags(1), event("7", {
      code: "Numpad7",
      ctrlKey: true,
    })),
    "\u001b[57406;5u",
  );
});

test("keypad begin preserves baseline and event-type forms", () => {
  const state = withFlags(2);
  assert.equal(encodeKittyKeyEvent(state, event("Clear", { code: "Numpad5" })), "\u001b[E");
  assert.equal(
    encodeKittyKeyEvent(state, event("Clear", { code: "Numpad5", repeat: true })),
    "\u001b[1;1:2E",
  );
  assert.equal(
    encodeKittyKeyEvent(state, event("Clear", { code: "Numpad5", type: "keyup" })),
    "\u001b[1;1:3E",
  );
});

test("CSI handlers negotiate, query, stack, and track alternate screen", () => {
  const state = createKittyKeyboardModeState();
  const fake = createFakeCsiParser();
  const replies: string[] = [];
  const disposable = installKittyKeyboardProtocolHandlers(fake.parser, state, (payload) => replies.push(payload));

  fake.dispatch({ prefix: "=", final: "u" }, [31]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?31u");
  assert.equal(fake.dispatchEsc({ final: "c" }), false);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?0u");
  fake.dispatch({ prefix: "=", final: "u" }, [31]);
  fake.dispatch({ prefix: ">", final: "u" }, [1]);
  fake.dispatch({ prefix: "<", final: "u" });
  assert.equal(fake.dispatch({ prefix: "?", final: "h" }, [1049]), false);
  fake.dispatch({ prefix: "=", final: "u" }, [8]);
  assert.equal(fake.dispatch({ prefix: "?", final: "l" }, [[1049]]), false);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?31u");

  disposable.dispose();
  assert.equal(fake.hasHandler({ prefix: "?", final: "u" }), false);
});

test("CSI parser helpers retain explicit opt-in policy", () => {
  assert.equal(readKittyKeyboardCsiParam([], 0, 7), 7);
  assert.equal(readKittyKeyboardCsiParam([[8, 9]], 0, 7), 8);
  const fake = createFakeCsiParser();
  const state = createKittyKeyboardModeState();
  assert.equal(installKittyKeyboardProtocolHandlersIfEnabled(false, fake.parser, state, () => {}), undefined);
  assert.equal(fake.hasHandler({ prefix: "?", final: "u" }), false);
});
