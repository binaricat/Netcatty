import {
  encodeKittyCompositionText,
  encodeKittyKeyEvent,
  encodeLegacyKeyboardEvent,
  shouldEncodeKittyCompositionText,
  type KittyKeyboardEvent,
  type KittyKeyboardModeState,
} from "./kittyKeyboardProtocol";

export type KittyKeyboardBroadcastInput =
  | {
      kind: "key";
      event: KittyKeyboardEvent;
      fallbackToLegacy?: boolean;
      urgentInterrupt?: boolean;
    }
  | { kind: "legacy"; data: string; keyIdentity: string; urgentInterrupt?: boolean }
  | { kind: "text"; text: string };

type KittyKeyboardBroadcastDispatchOptions = {
  beforeUrgentInterrupt?: () => void;
};

type KittyKeyboardBroadcastHandler = (
  input: KittyKeyboardBroadcastInput,
  dispatchOptions?: KittyKeyboardBroadcastDispatchOptions,
) => void;

export type ResolvedKittyKeyboardBroadcastInput = {
  data: string;
  kittyEncoded: boolean;
  urgentInterrupt: boolean;
};

export const createKittyKeyboardBroadcastForwarder = (options: {
  sourceSessionId: string;
  isHandlingBroadcast: () => boolean;
  isBroadcastEnabled: () => boolean;
  isSensitiveInput?: () => boolean;
  getDispatcher: () => ((
    data: string,
    sourceSessionId: string,
    options: {
      kittyKeyboardInput: KittyKeyboardBroadcastInput;
      kittyKeyboardTargetSessionIds?: string[];
    },
  ) => string[] | void) | null | undefined;
}) => {
  let lastDispatcher: ReturnType<typeof options.getDispatcher>;
  return (
    input: KittyKeyboardBroadcastInput,
    forcePairedRelease = false,
    targetSessionIds?: string[],
  ): { targetSessionIds: string[] } | null => {
    const currentDispatcher = options.getDispatcher();
    if (currentDispatcher) lastDispatcher = currentDispatcher;
    const dispatcher = currentDispatcher ?? (forcePairedRelease ? lastDispatcher : undefined);
    if (
      options.isHandlingBroadcast() ||
      (!forcePairedRelease && options.isSensitiveInput?.() === true) ||
      (!forcePairedRelease && !options.isBroadcastEnabled()) ||
      !dispatcher
    ) return null;
    const deliveredSessionIds = dispatcher("", options.sourceSessionId, {
      kittyKeyboardInput: input,
      ...(targetSessionIds ? { kittyKeyboardTargetSessionIds: targetSessionIds } : {}),
    });
    return { targetSessionIds: deliveredSessionIds ?? targetSessionIds ?? [] };
  };
};

export const clearKittyKeyboardBroadcastPairingState = (
  encodedKeys: Set<string>,
  legacySuppressedKeys: Set<string>,
): void => {
  encodedKeys.clear();
  legacySuppressedKeys.clear();
};

const SNAPSHOT_MODIFIERS = [
  "AltGraph", "CapsLock", "Hyper", "KittyMeta", "NumLock",
] as const;

export const createKittyKeyboardSyntheticRelease = (
  event: KittyKeyboardEvent,
  remainingPresses: Iterable<KittyKeyboardEvent> = [],
  lockState?: { capsLock: boolean; numLock: boolean },
): KittyKeyboardEvent => {
  const remaining = Array.from(remainingPresses);
  const hasRemainingKey = (keys: string[], codePrefix?: string) => remaining.some((press) => (
    keys.includes(press.key) || (codePrefix ? press.code?.startsWith(codePrefix) === true : false)
  ));
  const releasedShift = event.key === "Shift" || event.code?.startsWith("Shift") === true;
  const releasedControl = event.key === "Control" || event.code?.startsWith("Control") === true;
  const releasedAlt = event.key === "Alt" || event.code?.startsWith("Alt") === true;
  const releasedAltGraph = event.key === "AltGraph";
  const releasedMeta = ["Meta", "Super"].includes(event.key) || event.code?.startsWith("Meta") === true;
  const remainingShift = hasRemainingKey(["Shift"], "Shift");
  const remainingControl = hasRemainingKey(["Control"], "Control");
  const remainingAlt = hasRemainingKey(["Alt"], "Alt");
  const remainingMeta = hasRemainingKey(["Meta", "Super"], "Meta");
  const remainingAltGraph = hasRemainingKey(["AltGraph"]);
  const remainingHyper = hasRemainingKey(["Hyper"]);
  const remainingKittyMeta = hasRemainingKey(["KittyMeta"]);
  const modifierStates = new Map<string, boolean>(
    SNAPSHOT_MODIFIERS.map((name) => [name, event.getModifierState?.(name) === true]),
  );
  const releasedKey = event.key;
  return {
    ...event,
    type: "keyup",
    repeat: false,
    shiftKey: releasedShift ? remainingShift : (event.shiftKey || remainingShift),
    altKey: releasedAlt || releasedAltGraph ? remainingAlt : (event.altKey || remainingAlt),
    ctrlKey: releasedControl || releasedAltGraph
      ? remainingControl
      : (event.ctrlKey || remainingControl),
    metaKey: releasedMeta ? remainingMeta : (event.metaKey || remainingMeta),
    getModifierState: (name) => {
      if (name === "CapsLock" && lockState) return lockState.capsLock;
      if (name === "NumLock" && lockState) return lockState.numLock;
      if (name === "Hyper") {
        return releasedKey === "Hyper" ? remainingHyper : (
          modifierStates.get(name) === true || remainingHyper
        );
      }
      if (name === "KittyMeta") {
        return releasedKey === "KittyMeta" ? remainingKittyMeta : (
          modifierStates.get(name) === true || remainingKittyMeta
        );
      }
      if (name === "AltGraph") {
        return releasedAltGraph ? remainingAltGraph : (
          modifierStates.get(name) === true || remainingAltGraph
        );
      }
      return modifierStates.get(name) === true;
    },
  };
};

export type KittyKeyboardForwardedPress = {
  event: KittyKeyboardEvent;
  targetSessionIds: string[];
};

export const upsertKittyKeyboardForwardedPress = (
  releases: Map<string, KittyKeyboardForwardedPress>,
  identity: string,
  event: KittyKeyboardEvent,
  targetSessionIds: string[],
): void => {
  const existing = releases.get(identity);
  releases.set(identity, {
    event,
    targetSessionIds: Array.from(new Set([
      ...(existing?.targetSessionIds ?? []),
      ...targetSessionIds,
    ])),
  });
};

export const flushKittyKeyboardBroadcastReleases = (
  releases: Map<string, KittyKeyboardForwardedPress>,
  forward: (
    input: KittyKeyboardBroadcastInput,
    forcePairedRelease?: boolean,
    targetSessionIds?: string[],
  ) => unknown,
  currentLockState?: { capsLock: boolean; numLock: boolean },
): void => {
  const pending = new Map(releases);
  const entries = Array.from(pending.entries()).reverse();
  const latestPress = entries[0]?.[1].event;
  const lockState = currentLockState ?? {
    capsLock: latestPress?.getModifierState?.("CapsLock") === true,
    numLock: latestPress?.getModifierState?.("NumLock") === true,
  };
  for (const [identity, forwardedPress] of entries) {
    pending.delete(identity);
    forward({
      kind: "key",
      event: createKittyKeyboardSyntheticRelease(
        forwardedPress.event,
        Array.from(pending.values(), (pendingPress) => pendingPress.event),
        lockState,
      ),
    }, true, forwardedPress.targetSessionIds);
  }
  releases.clear();
};

export const resolveKittyKeyboardBroadcastInput = (
  input: KittyKeyboardBroadcastInput,
  options: {
    kittyProtocolEnabled: boolean;
    kittyMode: KittyKeyboardModeState;
    applicationCursorMode: boolean;
    encodedKeys: Set<string>;
    legacySuppressedKeys?: Set<string>;
  },
): ResolvedKittyKeyboardBroadcastInput | null => {
  if (input.kind === "text") {
    if (options.kittyProtocolEnabled && shouldEncodeKittyCompositionText(options.kittyMode)) {
      const encoded = encodeKittyCompositionText(options.kittyMode, input.text);
      if (encoded) return { data: encoded, kittyEncoded: true, urgentInterrupt: false };
    }
    return { data: input.text, kittyEncoded: false, urgentInterrupt: false };
  }

  if (input.kind === "legacy") {
    if ((options.legacySuppressedKeys ?? options.encodedKeys).delete(input.keyIdentity)) return null;
    options.encodedKeys.add(input.keyIdentity);
    return {
      data: input.data,
      kittyEncoded: false,
      urgentInterrupt: input.urgentInterrupt === true,
    };
  }

  const identity = input.event.code || input.event.key;
  const legacySuppressedKeys = options.legacySuppressedKeys ?? options.encodedKeys;
  const hasPairedKeyDown = input.event.type === "keyup"
    ? options.encodedKeys.delete(identity)
    : false;
  if (input.event.type === "keyup") legacySuppressedKeys.delete(identity);
  if (input.event.type === "keyup" && !hasPairedKeyDown) return null;
  const encoded = options.kittyProtocolEnabled
    ? encodeKittyKeyEvent(options.kittyMode, {
        ...input.event,
        applicationCursorMode: options.applicationCursorMode,
      })
    : null;
  if (encoded) {
    if (input.event.type === "keyup") options.encodedKeys.delete(identity);
    else {
      options.encodedKeys.add(identity);
      legacySuppressedKeys.add(identity);
    }
    return { data: encoded, kittyEncoded: true, urgentInterrupt: false };
  }
  if (!input.fallbackToLegacy || input.event.type === "keyup") return null;
  const legacy = encodeLegacyKeyboardEvent(input.event, options.applicationCursorMode);
  if (!legacy) return null;
  options.encodedKeys.add(identity);
  legacySuppressedKeys.add(identity);
  return {
    data: legacy,
    kittyEncoded: false,
    urgentInterrupt: input.urgentInterrupt === true,
  };
};

export const createKittyKeyboardBroadcastHandler = (options: {
  resolveOptions: () => {
    kittyProtocolEnabled: boolean;
    kittyMode: KittyKeyboardModeState;
    applicationCursorMode: boolean;
    encodedKeys: Set<string>;
    legacySuppressedKeys?: Set<string>;
  };
  getSessionId: () => string | null;
  isSensitiveInput?: () => boolean;
  isConnected: () => boolean;
  isRuntimeDisposed: () => boolean;
  interruptSession?: (sessionId: string) => void;
  writeDisposed: (sessionId: string, data: string) => void;
  writeActive: (data: string) => void;
}): KittyKeyboardBroadcastHandler => (input, dispatchOptions) => {
  const sessionId = options.getSessionId();
  if (!sessionId || !options.isConnected()) return;
  const isPairedRelease = input.kind === "key" && input.event.type === "keyup";
  if (!isPairedRelease && options.isSensitiveInput?.() === true) return;
  const resolved = resolveKittyKeyboardBroadcastInput(input, options.resolveOptions());
  if (!resolved) return;
  if (resolved.urgentInterrupt && options.interruptSession) {
    dispatchOptions?.beforeUrgentInterrupt?.();
    options.interruptSession(sessionId);
    return;
  }
  if (options.isRuntimeDisposed()) {
    options.writeDisposed(sessionId, resolved.data);
    return;
  }
  options.writeActive(resolved.data);
};

const handlers = new Map<string, KittyKeyboardBroadcastHandler>();
const pendingInputs = new Map<string, Array<{
  input: KittyKeyboardBroadcastInput;
  dispatchOptions?: KittyKeyboardBroadcastDispatchOptions;
}>>();

export const registerKittyKeyboardBroadcastHandler = (
  sessionId: string,
  handler: KittyKeyboardBroadcastHandler,
): (() => void) => {
  handlers.set(sessionId, handler);
  const pending = pendingInputs.get(sessionId);
  if (pending) {
    pendingInputs.delete(sessionId);
    for (const pendingInput of pending) {
      handler(pendingInput.input, pendingInput.dispatchOptions);
    }
  }
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
};

export const clearKittyKeyboardBroadcastSession = (sessionId: string): void => {
  handlers.delete(sessionId);
  pendingInputs.delete(sessionId);
};

export const dispatchKittyKeyboardBroadcastInput = (
  sessionId: string,
  input: KittyKeyboardBroadcastInput,
  dispatchOptions?: KittyKeyboardBroadcastDispatchOptions,
): boolean => {
  const handler = handlers.get(sessionId);
  if (!handler) {
    const pending = pendingInputs.get(sessionId) ?? [];
    pending.push({ input, dispatchOptions });
    if (pending.length > 128) pending.shift();
    pendingInputs.set(sessionId, pending);
    return true;
  }
  handler(input, dispatchOptions);
  return true;
};
