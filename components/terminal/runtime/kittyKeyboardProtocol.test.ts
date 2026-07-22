import test from "node:test";
import assert from "node:assert/strict";

import {
  buildKittyKeyboardModeQueryResponse,
  createKittyKeyboardModeState,
  encodeKittyControlKey,
  popKittyKeyboardModeFlags,
  pushKittyKeyboardModeFlags,
  setKittyKeyboardAlternateScreenActive,
  setKittyKeyboardModeFlags,
} from "./kittyKeyboardProtocol";
import {
  installKittyKeyboardProtocolHandlers,
  installKittyKeyboardProtocolHandlersIfEnabled,
  readKittyKeyboardCsiParam,
  type KittyKeyboardCsiParams,
} from "./kittyKeyboardRuntime";

type CsiHandlerId = {
  prefix?: string;
  intermediates?: string;
  final: string;
};

type CsiHandler = (params: KittyKeyboardCsiParams) => boolean;

const csiKey = (id: CsiHandlerId): string => (
  `${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`
);

const createFakeCsiParser = () => {
  const handlers = new Map<string, CsiHandler[]>();

  return {
    parser: {
      registerCsiHandler(id: CsiHandlerId, callback: CsiHandler) {
        const key = csiKey(id);
        const list = handlers.get(key) ?? [];
        list.push(callback);
        handlers.set(key, list);
        return {
          dispose: () => {
            const current = handlers.get(key);
            if (!current) return;
            const index = current.indexOf(callback);
            if (index >= 0) current.splice(index, 1);
            if (current.length === 0) handlers.delete(key);
          },
        };
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
      return handlers.has(csiKey(id));
    },
  };
};

test("kitty keyboard query reports the active screen flags", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 1, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?1u");

  setKittyKeyboardAlternateScreenActive(state, true);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?0u");
});

test("kitty keyboard set mode respects replace, union, and subtract semantics", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 1, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?1u");

  setKittyKeyboardModeFlags(state, 8, 2);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?9u");

  setKittyKeyboardModeFlags(state, 8, 3);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?1u");
});

test("kitty keyboard mode ignores unsupported progressive enhancement flags", () => {
  const state = createKittyKeyboardModeState();

  setKittyKeyboardModeFlags(state, 1 | 2 | 4 | 8 | 16, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?9u");

  setKittyKeyboardModeFlags(state, 2 | 4 | 16, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?0u");
});

test("kitty keyboard mode stacks are independent for main and alternate screen", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 1, 1);
  pushKittyKeyboardModeFlags(state, 0);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?0u");

  setKittyKeyboardAlternateScreenActive(state, true);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?0u");
  setKittyKeyboardModeFlags(state, 1, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?1u");

  popKittyKeyboardModeFlags(state, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?0u");

  setKittyKeyboardAlternateScreenActive(state, false);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?0u");
  popKittyKeyboardModeFlags(state, 1);
  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?1u");
});

test("kitty control key encoding keeps bare enter legacy but disambiguates modified enter", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 1, 1);

  assert.equal(
    encodeKittyControlKey(state, { key: "Enter" }),
    null,
  );
  assert.equal(
    encodeKittyControlKey(state, { key: "Enter", shiftKey: true }),
    "\u001b[13;2u",
  );
  assert.equal(
    encodeKittyControlKey(state, { key: "Escape" }),
    "\u001b[27u",
  );
  assert.equal(
    encodeKittyControlKey(state, { key: "Backspace", ctrlKey: true, altKey: true }),
    "\u001b[127;7u",
  );
});

test("kitty keyboard CSI param reader applies fallbacks for odd params", () => {
  assert.equal(readKittyKeyboardCsiParam([], 0, 7), 7);
  assert.equal(readKittyKeyboardCsiParam([0], 0, 7), 7);
  assert.equal(readKittyKeyboardCsiParam([-1], 0, 7), 7);
  assert.equal(readKittyKeyboardCsiParam([[8, 9]], 0, 7), 8);
  assert.equal(readKittyKeyboardCsiParam([1], 1, 7), 7);
});

test("kitty keyboard CSI handlers require explicit opt-in", () => {
  const disabled = createFakeCsiParser();
  const state = createKittyKeyboardModeState();

  assert.equal(
    installKittyKeyboardProtocolHandlersIfEnabled(
      undefined,
      disabled.parser,
      state,
      () => {},
    ),
    undefined,
  );
  assert.equal(disabled.hasHandler({ prefix: "?", final: "u" }), false);

  const enabled = createFakeCsiParser();
  const disposable = installKittyKeyboardProtocolHandlersIfEnabled(
    true,
    enabled.parser,
    state,
    () => {},
  );
  assert.equal(enabled.hasHandler({ prefix: "?", final: "u" }), true);
  disposable?.dispose();
});

test("kitty keyboard CSI handlers negotiate mode and enable Shift+Enter encoding", () => {
  const state = createKittyKeyboardModeState();
  const fake = createFakeCsiParser();
  const replies: string[] = [];
  const disposable = installKittyKeyboardProtocolHandlers(
    fake.parser,
    state,
    (payload) => replies.push(payload),
  );

  assert.equal(fake.dispatch({ prefix: "?", final: "u" }), true);
  assert.deepEqual(replies, ["\u001b[?0u"]);

  assert.equal(fake.dispatch({ prefix: "=", final: "u" }, [1]), true);
  assert.equal(
    encodeKittyControlKey(state, { key: "Enter", shiftKey: true }),
    "\u001b[13;2u",
  );
  assert.equal(encodeKittyControlKey(state, { key: "Enter" }), null);

  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?1u");

  disposable.dispose();
  assert.equal(fake.hasHandler({ prefix: "?", final: "u" }), false);
  assert.equal(fake.hasHandler({ prefix: "=", final: "u" }), false);
  assert.equal(fake.hasHandler({ prefix: ">", final: "u" }), false);
  assert.equal(fake.hasHandler({ prefix: "<", final: "u" }), false);
  assert.equal(fake.hasHandler({ prefix: "?", final: "h" }), false);
  assert.equal(fake.hasHandler({ prefix: "?", final: "l" }), false);
});

test("kitty keyboard CSI handlers handle invalid modes and stack defaults", () => {
  const state = createKittyKeyboardModeState();
  const fake = createFakeCsiParser();
  const replies: string[] = [];
  installKittyKeyboardProtocolHandlers(fake.parser, state, (payload) => replies.push(payload));

  fake.dispatch({ prefix: "=", final: "u" }, [8]);
  fake.dispatch({ prefix: "=", final: "u" }, [1, 99]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?1u");

  fake.dispatch({ prefix: "=", final: "u" }, [8, 2]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?9u");

  fake.dispatch({ prefix: "=", final: "u" }, [8, 3]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?1u");

  fake.dispatch({ prefix: ">", final: "u" }, [1 | 2 | 4 | 8 | 16]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?9u");

  fake.dispatch({ prefix: "<", final: "u" }, [0]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?1u");
});

test("kitty keyboard CSI handlers keep main and alternate screen state separate", () => {
  const state = createKittyKeyboardModeState();
  const fake = createFakeCsiParser();
  const replies: string[] = [];
  installKittyKeyboardProtocolHandlers(fake.parser, state, (payload) => replies.push(payload));

  fake.dispatch({ prefix: "=", final: "u" }, [1]);
  assert.equal(fake.dispatch({ prefix: "?", final: "h" }, [[1049]]), false);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?0u");

  fake.dispatch({ prefix: "=", final: "u" }, [8]);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?8u");

  assert.equal(fake.dispatch({ prefix: "?", final: "l" }, [1049]), false);
  fake.dispatch({ prefix: "?", final: "u" });
  assert.equal(replies.at(-1), "\u001b[?1u");
});

test("kitty report-all mode enables the supported modified control key subset", () => {
  const state = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(state, 8, 1);

  assert.equal(buildKittyKeyboardModeQueryResponse(state), "\u001b[?8u");
  assert.equal(
    encodeKittyControlKey(state, { key: "Enter", shiftKey: true }),
    "\u001b[13;2u",
  );
  assert.equal(
    encodeKittyControlKey(state, { key: "Tab", shiftKey: true }),
    "\u001b[9;2u",
  );
  assert.equal(
    encodeKittyControlKey(state, { key: "Enter" }),
    null,
  );
});
