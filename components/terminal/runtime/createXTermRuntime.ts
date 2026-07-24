import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import {
  checkAppShortcut,
  getAppLevelActions,
  getTerminalPassthroughActions,
} from "../../../application/state/useGlobalHotkeys";
import { fontStore } from "../../../application/state/fontStore";
import { KeywordHighlighter } from "../keywordHighlight";
import {
  registerPluginTerminalLinkProvider,
  type PluginTerminalLinkProviderHost,
  type RequestPluginTerminalProviders,
} from "../pluginTerminalLinkProvider";
import { PluginTerminalVisualProviderHost } from "../pluginTerminalVisualProviderHost";
import {
  XTERM_PERFORMANCE_CONFIG,
  resolveXTermScrollback,
  type XTermPlatform,
  resolveXTermPerformanceConfig,
} from "../../../infrastructure/config/xtermPerformance";
import {
  scrollTerminalToBottomAfterInputIfEnabled,
  shouldEnableNativeUserInputAutoScroll,
  shouldScrollOnTerminalPaste,
} from "../../../domain/terminalScroll";
import {
  resolveHostTerminalFontFamilyId,
  resolveHostTerminalFontSize,
  resolveHostTerminalFontWeight,
} from "../../../domain/terminalAppearance";
import { resolveFontWeightBold } from "../../../lib/fontWeightAvailability";
import { resolveTerminalFontFamilyId } from "../../../infrastructure/config/fonts";
import { logger } from "../../../lib/logger";
import { isMacPlatform } from "../../../lib/utils";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import {
  clearTerminalViewportAndSyncPty,
  installEraseInDisplayHandlers,
} from "../clearTerminalViewport";
import { getTerminalSelectionForClipboard } from "../normalizeTerminalSelection";
import {
  createKittyKeyboardSessionStateStore,
  encodeKittyCompositionText,
  encodeKittyKeyEvent,
  isKittyKeyboardModeActive,
  restoreKittyKeyboardModeState,
  shouldEncodeKittyCompositionText,
  shouldDeferKittyKeyEvent,
  shouldExpectLegacyKeyboardData,
  shouldMarkKittyTextInputEvent,
  shouldTrackKittyKeyRelease,
  shouldTreatKittyAltAsText,
  snapshotKittyKeyboardModeState,
  type KittyKeyboardEvent,
  type KittyKeyboardModeState,
} from "./kittyKeyboardProtocol";
import { installKittyKeyboardProtocolHandlersIfEnabled } from "./kittyKeyboardRuntime";
import {
  clearKittyKeyboardBroadcastPairingState,
  createKittyKeyboardBroadcastForwarder,
  createKittyKeyboardBroadcastHandler,
  flushKittyKeyboardBroadcastReleases,
  registerKittyKeyboardBroadcastHandler,
  upsertKittyKeyboardForwardedPress,
  type KittyKeyboardBroadcastInput,
  type KittyKeyboardForwardedPress,
} from "./kittyKeyboardBroadcast";
import { installUserCursorPreferenceGuard } from "./cursorPreference";
import { terminalAltKeyOptions } from "./altKeyOptions";
import { optionArrowWordJumpSequence } from "./optionArrowWordJump";
import { watchDevicePixelRatio } from "./rendererDprWatch";
import { shouldDeferWebglUntilVisible } from "./webglRendererPolicy";
import { createWebglRendererController } from "./webglRendererController";
import {
  captureMiddleClickTerminalMouseEvent,
  markMiddleClickContextMenuEvent,
  resolveMiddleClickBehavior,
} from "./middleClickBehavior";
import { handleSerialLineModeInput } from "./serialLineInput";
import {
  getShiftEnterSubmittedInput,
  resolveShiftEnterText,
  shouldSendShiftEnterText,
} from "./shiftEnterText";
import { formatSerialLocalEcho } from "./serialLocalEcho";
import { mapTerminalBackspaceInput } from "./terminalBackspaceInput";
import { formatTelnetLocalEcho } from "./telnetLocalEcho";
import {
  isTerminalFontSizeAction,
  nextTerminalFontSizeForAction,
  nextTerminalFontSizeForWheel,
  shouldHandleTerminalFontSizeAction,
  terminalFontSizeWheelListenerOptions,
} from "./terminalFontZoom";
import {
  getHistoryPreviewLines,
  forcedHistoryScrollLinesForWheel,
  forcedHistoryScrollPageToLines,
  forcedHistoryScrollPagesForKey,
  forcedHistoryScrollWheelListenerOptions,
  nextHistoryPreviewTop,
} from "./terminalHistoryScrollOverride";
import { shouldPassThroughCopyShortcut } from "./terminalCopyShortcut";
import { shouldUseUrgentTerminalInterrupt } from "./terminalInterruptShortcut";
import {
  createTerminalInterruptTrace,
  logTerminalInterruptTrace,
} from "./terminalInterruptDiagnostics";
import { clearTerminalInputStateForInterrupt } from "./terminalInterruptInputState";
import { getFlowControllerForTerm } from "./terminalSessionAttachment";
import { createTerminalResizeScheduler } from "./terminalResizeScheduler";
import { writeLocalTerminalDataInOrder } from "./terminalUnfocusedRepaint";
import {
  prioritizeTerminalInput,
  shouldArmTerminalInterruptDisplayGateForProtocol,
} from "./terminalOutputPipeline";
import {
  markExpectedTerminalCursorPositionReport,
  pasteTextIntoTerminal,
  shouldBroadcastTerminalUserInput,
  shouldSuppressTerminalInputScrollForUserPaste,
} from "./terminalUserPaste";
import {
  consumeOsc133CommandCompletion,
  type PromptLineBreakState,
} from "./promptLineBreak";
import { recordTerminalCommandExecution } from "./terminalCommandExecution";
import {
  getSingleBracketedPasteLine,
  getSinglePastedCommand,
  prepareSudoAutofillInput,
  type SudoPasswordAutofill,
} from "./terminalSudoAutofill";
import type {
  Host,
  KeyBinding,
  TerminalSession,
  TerminalSettings,
  TerminalTheme,
} from "../../../types";
import {
  DEFAULT_TERMINAL_WORD_SEPARATORS,
  matchesKeyBinding,
  type Snippet,
} from "../../../domain/models";

type TerminalBackendApi = {
  openExternalAvailable: () => boolean;
  openExternal: (url: string) => Promise<void>;
  writeToSession: (sessionId: string, data: string) => void;
  interruptSession?: (sessionId: string, trace?: NetcattyTerminalInterruptTrace) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
  clearSessionPtyBuffer?: (sessionId: string) => void;
  setSessionFlowPaused?: (sessionId: string, paused: boolean) => void;
};

// A TerminalSettings ref is owned by one mounted terminal session and survives
// renderer hibernation. Weak ownership keeps negotiated keyboard state alive
// for that session without introducing a process-wide session registry.
const kittyKeyboardStates = createKittyKeyboardSessionStateStore();

const resolveKittyKeyboardModeState = (
  ctx: Pick<
    CreateXTermRuntimeContext,
    "terminalSettingsRef" | "kittyKeyboardModeState" | "deferWebglUntilReplayComplete"
  >,
): KittyKeyboardModeState => {
  if (ctx.kittyKeyboardModeState) return ctx.kittyKeyboardModeState;
  const owner = ctx.terminalSettingsRef as object;
  return kittyKeyboardStates.resolve(owner, ctx.deferWebglUntilReplayComplete === true);
};

export type XTermRuntime = {
  term: XTerm;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  searchAddon: SearchAddon;
  dispose: () => void;
  /** Current working directory detected via OSC 7 */
  currentCwd: string | undefined;
  keywordHighlighter: KeywordHighlighter;
  pluginProviderHost: PluginTerminalVisualProviderHost | null;
  pluginLinkProviderHost: PluginTerminalLinkProviderHost | null;
  /**
   * Clear the WebGL renderer's glyph texture atlas so glyphs re-rasterize on the
   * next frame. No-op when the DOM renderer is active. Used to recover from the
   * persistent "garbled / 花屏" corruption (issue #1049) that the WebGL atlas can
   * fall into after font changes or device pixel ratio changes.
   */
  clearTextureAtlas: () => void;
  /**
   * Create the WebGL renderer if it was deferred (pane mounted hidden) and has
   * not been created yet. Idempotent; a no-op when WebGL is disabled or already
   * active. Called when a deferred pane first becomes visible.
   */
  ensureWebglRenderer: () => void;
  /** Drop the WebGL addon while keeping the terminal alive (soft-hide). */
  suspendWebglRenderer: () => void;
  /** Clear local/per-target keyboard state before reusing this runtime. */
  resetKittyConnectionInputState: () => void;
  /** Emit any owed releases before detaching or closing this renderer. */
  flushKittyKeyboardReleases: () => void;
  /** Transfer negotiated keyboard state across renderer attach handoffs. */
  getKittyKeyboardModeState: () => KittyKeyboardModeState;
  restoreKittyKeyboardModeState: (state: KittyKeyboardModeState) => void;
  getKittyKeyboardProtocolEnabled: () => boolean;
  setKittyKeyboardProtocolEnabled: (enabled: boolean) => void;
};

export const resetKittyKeyboardModeStateForSession = (
  terminalSettingsRef: object,
): void => kittyKeyboardStates.reset(terminalSettingsRef);

export type CreateXTermRuntimeContext = {
  container: HTMLDivElement;
  host: Host;
  fontFamilyId: string;
  resolvedFontFamily: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  terminalSettingsRef: RefObject<TerminalSettings | undefined>;
  kittyKeyboardProtocolEnabled?: boolean;
  kittyKeyboardModeState?: KittyKeyboardModeState;
  terminalBackend: TerminalBackendApi;
  sessionRef: RefObject<string | null>;

  hotkeySchemeRef: RefObject<"disabled" | "mac" | "pc">;
  disableTerminalFontZoomRef: RefObject<boolean>;
  keyBindingsRef: RefObject<KeyBinding[]>;
  onHotkeyActionRef: RefObject<
    ((action: string, event: KeyboardEvent) => void) | undefined
  >;
  onTerminalFontSizeChange?: (fontSize: number) => void;

  isBroadcastEnabledRef: RefObject<boolean | undefined>;
  onBroadcastInputRef: RefObject<
    ((
      data: string,
      sourceSessionId: string,
      options?: { kittyKeyboardInput?: KittyKeyboardBroadcastInput },
    ) => void) | undefined
  >;

  // Snippets for shortkey support
  snippetsRef?: RefObject<Snippet[]>;
  onSnippetShortkeyRef?: RefObject<((snippet: Snippet) => void) | undefined>;

  sessionId: string;
  statusRef: RefObject<TerminalSession["status"]>;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onCommandSubmitted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onTrustedCommandSubmitted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onCommandCompleted?: () => void;
  requestPluginTerminalProviders?: RequestPluginTerminalProviders;
  pluginProviderVisible?: boolean;
  isPluginTerminalProviderAvailable?: (kind: NetcattyTerminalProviderKind) => boolean;
  onResize?: (cols: number, rows: number) => void;
  onAlternateScreenChange?: (active: boolean) => void;
  commandBufferRef: RefObject<string>;
  promptLineBreakStateRef?: RefObject<PromptLineBreakState>;
  scriptRecorderRef?: RefObject<{
    isRecording: boolean;
    recordInput: (data: string) => void;
    recordBackspace: () => void;
    recordClearLine: () => void;
    recordEnter: (options?: { sensitive?: boolean }) => Promise<void>;
  } | undefined>;
  passwordPromptActiveRef?: RefObject<boolean>;
  allowHostStyleGreaterThanPrompt?: boolean;
  onOutputTriggerUserInputRef?: RefObject<((data: string) => void) | undefined>;
  sudoAutofillRef?: RefObject<SudoPasswordAutofill | null>;
  // Opens the search bar, or refocuses its input if already open. Used by the
  // searchTerminal hotkey so Cmd/Ctrl+F re-grabs focus when the bar is open but
  // unfocused (issue #1789).
  requestSearchFocus: () => void;

  // Serial-specific options
  serialLocalEcho?: boolean;
  serialLineMode?: boolean;
  serialLineBufferRef?: RefObject<string>;
  telnetLocalEchoRef?: RefObject<boolean>;
  onTerminalLogData?: (data: string) => void;

  // Callback when shell reports CWD change via OSC 7
  onCwdChange?: (cwd: string) => void;

  // Callback when shell reports window/icon title via OSC 0/2
  onTitleChange?: (title: string | null) => void;

  // Callback when the shell rings the terminal bell
  onBell?: () => void;

  // Callback when remote requests clipboard read in 'prompt' mode; resolves to user's decision
  onOsc52ReadRequest?: () => Promise<boolean>;

  // Autocomplete key event handler — returns false if event was consumed
  onAutocompleteKeyEvent?: (e: KeyboardEvent) => boolean;
  // Autocomplete input handler — called on every character input
  onAutocompleteInput?: (data: string) => void;

  terminalContextActionsRef?: RefObject<{
    onPaste?: () => void | Promise<void>;
    onSelectWord?: () => void;
  } | undefined>;

  // Set to true while we're programmatically restoring a selection so that
  // copy-on-select listeners can suppress redundant clipboard writes.
  isRestoringSelectionRef?: RefObject<boolean>;

  // Whether the pane is visible at creation time. When false, WebGL renderer
  // creation is deferred until the pane first becomes visible (batch-connect
  // background tabs) to avoid spinning up many WebGL contexts at once. Defaults
  // to visible (immediate WebGL) when omitted.
  initiallyVisible?: boolean;
  /** When true, keep the DOM renderer until replay completes (hibernate wake). */
  deferWebglUntilReplayComplete?: boolean;
};

const detectPlatform = (): XTermPlatform => {
  if (
    typeof process !== "undefined" &&
    (process.platform === "darwin" ||
      process.platform === "win32" ||
      process.platform === "linux")
  ) {
    return process.platform;
  }

  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return "win32";
    if (ua.includes("linux")) return "linux";
  }

  return "darwin";
};

const csiParamsInclude = (
  params: readonly (number | number[])[],
  target: number,
): boolean => params.some((param) => (
  Array.isArray(param)
    ? param.includes(target)
    : param === target
));

/**
 * Extract the primary font family from a CSS font-family string that may
 * include fallback fonts. Used by autocomplete and other helpers that need
 * the first face without the CJK / icon fallback stack.
 */
export const primaryFontFamily = (fontFamily: string): string => {
  // Split on commas that are NOT inside quotes to handle font names like "Foo, Bar"
  const match = fontFamily.match(/^(?:"[^"]*"|'[^']*'|[^,])+/);
  const first = match?.[0]?.trim();
  return first || fontFamily;
};

export const createXTermRuntime = (ctx: CreateXTermRuntimeContext): XTermRuntime => {
  const platform = detectPlatform();
  const deviceMemoryGb =
    typeof navigator !== "undefined" &&
      typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
      ? (navigator as { deviceMemory?: number }).deviceMemory
      : undefined;

  const settings = ctx.terminalSettingsRef.current;
  const rendererType = settings?.rendererType ?? "auto";
  const bridge = netcattyBridge.get();
  const isLocalTerminalHost = ctx.host.protocol === "local";
  const windowsPty =
    platform === "win32" && isLocalTerminalHost
      ? bridge?.getWindowsPtyInfo?.() ?? { backend: "conpty" as const }
      : undefined;

  const performanceConfig = resolveXTermPerformanceConfig({
    platform,
    deviceMemoryGb,
    rendererType,
  });

  const hostFontId = resolveTerminalFontFamilyId(
    resolveHostTerminalFontFamilyId(ctx.host, ctx.fontFamilyId),
    typeof navigator !== "undefined" ? navigator.platform : "",
  );
  // Use fontStore for font lookup - guarantees non-empty result
  const fontObj = fontStore.getFontById(hostFontId);
  const fontFamily = ctx.resolvedFontFamily || fontObj.family;

  const effectiveFontSize = resolveHostTerminalFontSize(ctx.host, ctx.fontSize);

  const cursorStyle = settings?.cursorShape ?? "block";
  const cursorBlink = settings?.cursorBlink ?? true;
  const rawScrollback = settings?.scrollback ?? 10000;
  const scrollback = resolveXTermScrollback(rawScrollback);
  const drawBoldTextInBrightColors = settings?.drawBoldInBrightColors ?? true;
  const fontWeight = resolveHostTerminalFontWeight(ctx.host, settings?.fontWeight ?? 400);
  const fontWeightBold = settings?.fontWeightBold ?? 700;
  const lineHeight = 1 + (settings?.linePadding ?? 0) / 10;
  const minimumContrastRatio = settings?.minimumContrastRatio ?? 1;
  const scrollOnUserInput = shouldEnableNativeUserInputAutoScroll(settings);
  const smoothScrollDuration = settings?.smoothScrolling
    ? performanceConfig.options.smoothScrollDuration
    : 0;
  const altIsMeta = settings?.altAsMeta ?? false;
  const wordSeparator = settings?.wordSeparators ?? DEFAULT_TERMINAL_WORD_SEPARATORS;
  const keywordHighlightRules = settings?.keywordHighlightRules ?? [];
  const keywordHighlightEnabled = settings?.keywordHighlightEnabled ?? false;
  // The state may outlive this renderer while a connected session is hibernated.
  // Keeping it in the owning Terminal prevents the remote app and a recreated
  // xterm instance from disagreeing about the active protocol flags.
  const kittyKeyboardMode = resolveKittyKeyboardModeState(ctx);
  // Negotiation handlers and key encoding must use the same runtime snapshot.
  // Settings changes take effect when Terminal recreates this runtime.
  let kittyKeyboardProtocolEnabled =
    ctx.kittyKeyboardProtocolEnabled ?? settings?.kittyKeyboardProtocolEnabled === true;
  let kittyKeyboardDisposable: ReturnType<
    typeof installKittyKeyboardProtocolHandlersIfEnabled
  >;

  const resolvedFontWeightBold = resolveFontWeightBold({
    fontFamilyCss: fontFamily,
    normalWeight: fontWeight,
    desiredBoldWeight: fontWeightBold,
    fontSize: effectiveFontSize,
  });

  const term = new XTerm({
    ...performanceConfig.options,
    ...(windowsPty ? { windowsPty } : {}),
    // Override ignoreBracketedPasteMode if user explicitly disables bracketed paste
    ignoreBracketedPasteMode: settings?.disableBracketedPaste ?? performanceConfig.options.ignoreBracketedPasteMode,
    // Rescale glyphs that would visually overlap into the next cell (CJK compliance)
    rescaleOverlappingGlyphs: true,
    fontSize: effectiveFontSize,
    fontFamily,
    fontWeight: fontWeight as
      | 100
      | 200
      | 300
      | 400
      | 500
      | 600
      | 700
      | 800
      | 900
      | "normal"
      | "bold",
    fontWeightBold: resolvedFontWeightBold as
      | 100
      | 200
      | 300
      | 400
      | 500
      | 600
      | 700
      | 800
      | 900
      | "normal"
      | "bold",
    lineHeight,
    cursorStyle,
    cursorBlink,
    scrollback,
    // Decorations (keyword highlighting) use proposed APIs; enable globally so toggles work at runtime.
    allowProposedApi: true,
    drawBoldTextInBrightColors,
    minimumContrastRatio,
    smoothScrollDuration,
    scrollOnUserInput,
    macOptionClickForcesSelection: true,
    ...terminalAltKeyOptions(altIsMeta),
    wordSeparator,
    theme: {
      ...ctx.terminalTheme.colors,
      selectionBackground: ctx.terminalTheme.colors.selection,
      // Scrollbar theming (xterm 6.0) — derive from foreground color
      scrollbarSliderBackground: ctx.terminalTheme.colors.foreground + '33', // 20% opacity
      scrollbarSliderHoverBackground: ctx.terminalTheme.colors.foreground + '66', // 40% opacity
      scrollbarSliderActiveBackground: ctx.terminalTheme.colors.foreground + '80', // 50% opacity
    },
  });

  type MaybeRenderer = {
    constructor?: { name?: string };
    type?: string;
  };

  type IntrospectableTerminal = XTerm & {
    _core?: {
      _renderService?: {
        _renderer?: MaybeRenderer;
      };
    };
    options?: {
      rendererType?: string;
    };
  };

  const trackRenderer = (attempt = 0) => {
    const introspected = term as IntrospectableTerminal;
    const renderer = introspected._core?._renderService?._renderer;
    const candidates = [
      renderer?.type,
      renderer?.constructor?.name,
      introspected.options?.rendererType,
    ];
    const rendererName =
      candidates.find((value) => typeof value === "string" && value.length > 0) ||
      undefined;
    const normalized = rendererName
      ? rendererName.toLowerCase().includes("webgl")
        ? "webgl"
        : rendererName.toLowerCase().includes("canvas")
          ? "canvas"
          : rendererName
      : "unknown";
    const scopedWindow = window as Window & { __xtermRenderer?: string };
    scopedWindow.__xtermRenderer = normalized;
    if (normalized === "unknown" && attempt < 3) {
      setTimeout(() => trackRenderer(attempt + 1), 150);
    }
  };

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);

  term.open(ctx.container);

  type KeyboardLayoutMapLike = { get: (code: string) => string | undefined };
  type KeyboardApiLike = {
    getLayoutMap?: () => Promise<KeyboardLayoutMapLike>;
    addEventListener?: (type: "layoutchange", listener: () => void) => void;
    removeEventListener?: (type: "layoutchange", listener: () => void) => void;
  };
  const keyboardApi = (navigator as Navigator & { keyboard?: KeyboardApiLike }).keyboard;
  let kittyKeyboardLayoutMap: KeyboardLayoutMapLike | undefined;
  const refreshKittyKeyboardLayout = () => {
    void keyboardApi?.getLayoutMap?.().then((layoutMap) => {
      kittyKeyboardLayoutMap = layoutMap;
    }).catch(() => {
      kittyKeyboardLayoutMap = undefined;
    });
  };
  keyboardApi?.addEventListener?.("layoutchange", refreshKittyKeyboardLayout);
  refreshKittyKeyboardLayout();

  const kittyKeyboardLockState = { capsLock: false, numLock: false };
  const toKittyKeyboardEvent = (event: KeyboardEvent): KittyKeyboardEvent => {
    const unshiftedKey = kittyKeyboardLayoutMap?.get(event.code);
    kittyKeyboardLockState.capsLock = event.getModifierState("CapsLock");
    kittyKeyboardLockState.numLock = event.getModifierState("NumLock");
    return {
      type: event.type,
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      getModifierState: (key) => event.getModifierState(key),
      unshiftedKey,
      altKeyProducesText: shouldTreatKittyAltAsText(
        event,
        isMacPlatform(),
        ctx.terminalSettingsRef.current?.altAsMeta ?? altIsMeta,
      ),
      applicationCursorMode: term.modes.applicationCursorKeysMode,
    };
  };

  // Intercept native copy (Edit > Copy, browser/Electron copy event) before
  // xterm's built-in handler writes selectionText, so normalizeTextOnCopy applies.
  const handleNativeCopy = (event: ClipboardEvent) => {
    if (!term.hasSelection()) return;
    const normalize = ctx.terminalSettingsRef.current?.normalizeTextOnCopy ?? true;
    if (!normalize) return; // let xterm write raw selectionText
    const selection = getTerminalSelectionForClipboard(term, true);
    if (!selection) return;
    if (event.clipboardData) {
      event.clipboardData.setData("text/plain", selection);
    } else {
      void navigator.clipboard.writeText(selection).catch((err) => {
        logger.warn("[XTerm] Normalized native copy failed:", err);
      });
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  term.element?.addEventListener("copy", handleNativeCopy, true);

  let webglLoaded = false;
  let runtimeDisposed = false;
  const scopedWindow = window as Window & {
    __xtermWebGLLoaded?: boolean;
    __xtermRendererPreference?: string;
  };

  // Idempotent: creates the WebGL renderer on first call and no-ops afterwards
  // (or when WebGL is disabled for this device). Panes that mount hidden defer
  // this until they first become visible — see shouldDeferWebglUntilVisible —
  // so batch-connecting many hosts doesn't spin up every WebGL context at once.
  const repaintTerminal = () => {
    if (runtimeDisposed || term.rows < 1) return;
    try {
      term.refresh(0, term.rows - 1);
    } catch (err) {
      logger.warn("[XTerm] renderer repaint failed", err);
    }
  };

  const webglController = createWebglRendererController({
    enabled: performanceConfig.useWebGLAddon,
    createAddon: () => new WebglAddon(),
    loadAddon: (addon) => term.loadAddon(addon),
    repaint: repaintTerminal,
    setLoaded: (loaded) => {
      webglLoaded = loaded;
      scopedWindow.__xtermWebGLLoaded = loaded;
    },
    warn: (message, error) => {
      if (error === undefined) logger.warn(message);
      else logger.warn(message, error);
    },
  });
  const loadWebglRenderer = webglController.ensure;
  const suspendWebglRenderer = webglController.suspend;

  if (!performanceConfig.useWebGLAddon) {
    logger.info(
      "[XTerm] Skipping WebGL addon (DOM preferred for low-memory devices)",
    );
  } else if (
    shouldDeferWebglUntilVisible({
      useWebGLAddon: performanceConfig.useWebGLAddon,
      initiallyVisible: ctx.initiallyVisible ?? true,
    }) || ctx.deferWebglUntilReplayComplete
  ) {
    logger.info("[XTerm] Deferring WebGL addon until pane becomes visible or replay completes");
  } else {
    loadWebglRenderer();
  }

  scopedWindow.__xtermWebGLLoaded = webglLoaded;
  scopedWindow.__xtermRendererPreference = performanceConfig.preferDOMRenderer
    ? "dom"
    : "webgl";

  // The WebGL renderer caches rasterized glyphs in a texture atlas. Heavy TUIs
  // (claude code / gemini cli / opencode and other full-screen agents), font
  // changes, and device pixel ratio changes can leave that atlas in a corrupted
  // state that persists for the life of the terminal — the "garbled / 花屏"
  // report in issue #1049 where only opening a brand-new terminal helps. Clearing
  // the atlas forces glyphs to re-rasterize at the correct scale on the next
  // frame. No-op for the DOM renderer.
  const clearWebglTextureAtlas = () => {
    const webglAddon = webglController.getAddon();
    if (!webglAddon) return;
    try {
      webglAddon.clearTextureAtlas();
    } catch (err) {
      logger.warn("[XTerm] clearTextureAtlas failed", err);
    }
  };

  // Recover the renderer when the device pixel ratio changes (moving the window
  // between monitors with different DPI, or changing OS display scaling — a
  // common Windows trigger). matchMedia change does not fire a normal resize, so
  // this is needed in addition to the resize handling below.
  let stopDprWatch: () => void = () => {};
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    stopDprWatch = watchDevicePixelRatio({
      getDevicePixelRatio: () => window.devicePixelRatio || 1,
      matchMedia: (query) => window.matchMedia(query),
      onChange: () => {
        clearWebglTextureAtlas();
        try {
          fitAddon.fit();
        } catch (err) {
          logger.warn("[XTerm] fit after devicePixelRatio change failed", err);
        }
      },
    });
  }

  const canActivateTerminalLink = (event: MouseEvent): boolean => {
    const currentLinkModifier = ctx.terminalSettingsRef.current?.linkModifier ?? "none";
    switch (currentLinkModifier) {
      case "none":
        return true;
      case "ctrl":
        return event.ctrlKey;
      case "alt":
        return event.altKey;
      case "meta":
        return event.metaKey;
    }
    return false;
  };
  const openTerminalLink = async (uri: string): Promise<void> => {
    if (!/^https?:\/\//iu.test(String(uri || ""))) {
      logger.warn("[XTerm] Refusing to open non-http(s) link:", uri);
      return;
    }

    if (ctx.terminalBackend.openExternalAvailable()) {
      await ctx.terminalBackend.openExternal(uri);
    } else {
      window.open(uri, "_blank", "noopener,noreferrer");
    }
  };
  const webLinksAddon = new WebLinksAddon((event, uri) => {
    if (canActivateTerminalLink(event)) void openTerminalLink(uri);
  });
  term.loadAddon(webLinksAddon);
  const pluginLinkProviderHost = ctx.requestPluginTerminalProviders
    ? registerPluginTerminalLinkProvider({
        term,
        request: ctx.requestPluginTerminalProviders,
        canActivate: canActivateTerminalLink,
        openExternal: openTerminalLink,
        isProviderAvailable: ctx.isPluginTerminalProviderAvailable,
        active: ctx.statusRef.current === 'connected',
        visible: ctx.pluginProviderVisible ?? true,
      })
    : null;
  const pluginProviderHost = ctx.requestPluginTerminalProviders
    ? new PluginTerminalVisualProviderHost({
        term,
        request: ctx.requestPluginTerminalProviders,
        terminalBackground: ctx.terminalTheme.colors.background,
        active: ctx.statusRef.current === 'connected',
        visible: ctx.pluginProviderVisible ?? true,
        isProviderAvailable: ctx.isPluginTerminalProviderAvailable,
      })
    : null;

  // Enable Unicode graphemes for accurate CJK / emoji / Nerd Font character width handling
  const unicodeGraphemes = new UnicodeGraphemesAddon();
  term.loadAddon(unicodeGraphemes);
  term.unicode.activeVersion = '15-graphemes';

  trackRenderer();

  const appLevelActions = getAppLevelActions();
  const terminalActions = getTerminalPassthroughActions();
  const broadcastUserPasteData = (data: string) => {
    if (
      ctx.passwordPromptActiveRef?.current !== true
      && ctx.isBroadcastEnabledRef.current
      && ctx.onBroadcastInputRef.current
    ) {
      ctx.onBroadcastInputRef.current(data, ctx.sessionId);
      return true;
    }
    return false;
  };
  const scrollToBottomAfterInput = (data: string) => {
    scrollTerminalToBottomAfterInputIfEnabled(
      term,
      ctx.terminalSettingsRef.current,
      data,
    );
  };
  const currentTerminalFontSize = () => {
    const optionFontSize = term.options.fontSize;
    return typeof optionFontSize === "number" ? optionFontSize : effectiveFontSize;
  };
  const applyTerminalFontSize = (nextFontSize: number | null): boolean => {
    if (nextFontSize === null) return false;
    const currentFontSize = currentTerminalFontSize();
    if (nextFontSize !== currentFontSize) {
      term.options.fontSize = nextFontSize;
      clearWebglTextureAtlas();
      try {
        fitAddon.fit();
      } catch (err) {
        logger.warn("[XTerm] fit after font size change failed", err);
      }
      ctx.onTerminalFontSizeChange?.(nextFontSize);
    }
    return true;
  };
  const handleFontSizeWheel = (event: WheelEvent) => {
    const currentScheme = ctx.hotkeySchemeRef.current;
    const isMac = currentScheme === "mac" || (currentScheme === "disabled" && isMacPlatform());
    const nextFontSize = nextTerminalFontSizeForWheel(
      event,
      currentTerminalFontSize(),
      isMac,
      ctx.disableTerminalFontZoomRef.current,
    );
    if (nextFontSize === null) return;
    event.preventDefault();
    event.stopPropagation();
    applyTerminalFontSize(nextFontSize);
  };
  let historyPreviewOverlay: HTMLPreElement | null = null;
  let historyPreviewTop: number | null = null;
  const hideHistoryPreview = () => {
    historyPreviewOverlay?.remove();
    historyPreviewOverlay = null;
    historyPreviewTop = null;
  };
  const ensureHistoryPreviewOverlay = () => {
    if (historyPreviewOverlay) return historyPreviewOverlay;
    const overlay = document.createElement("pre");
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      zIndex: "8",
      margin: "0",
      padding: "0 6px",
      overflow: "hidden",
      pointerEvents: "none",
      whiteSpace: "pre",
      fontFamily: String(term.options.fontFamily ?? fontFamily),
      fontSize: `${currentTerminalFontSize()}px`,
      lineHeight: String(term.options.lineHeight ?? lineHeight),
      color: ctx.terminalTheme.colors.foreground,
      background: ctx.terminalTheme.colors.background,
    } satisfies Partial<CSSStyleDeclaration>);
    ctx.container.appendChild(overlay);
    historyPreviewOverlay = overlay;
    return overlay;
  };
  const showAlternateScreenHistoryPreview = (lines: number) => {
    if (term.buffer.active.type !== "alternate") return false;
    const normalBuffer = term.buffer.normal;
    historyPreviewTop = nextHistoryPreviewTop({
      buffer: normalBuffer,
      currentTop: historyPreviewTop,
      lines,
    });
    const overlay = ensureHistoryPreviewOverlay();
    overlay.style.fontSize = `${currentTerminalFontSize()}px`;
    overlay.style.fontFamily = String(term.options.fontFamily ?? fontFamily);
    overlay.style.lineHeight = String(term.options.lineHeight ?? lineHeight);
    overlay.textContent = getHistoryPreviewLines({
      buffer: normalBuffer,
      rows: term.rows,
      top: historyPreviewTop,
    }).join("\n");
    return true;
  };
  const scrollForcedHistoryLines = (lines: number) => {
    if (showAlternateScreenHistoryPreview(lines)) return;
    hideHistoryPreview();
    term.scrollLines(lines);
  };
  const handleForcedHistoryScrollWheel = (event: WheelEvent) => {
    const lines = forcedHistoryScrollLinesForWheel(event);
    if (lines === null) {
      hideHistoryPreview();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    scrollForcedHistoryLines(lines);
  };
  ctx.container.addEventListener(
    "wheel",
    handleForcedHistoryScrollWheel,
    forcedHistoryScrollWheelListenerOptions,
  );
  ctx.container.addEventListener(
    "wheel",
    handleFontSizeWheel,
    terminalFontSizeWheelListenerOptions,
  );
  const historyPreviewBufferChangeDisposable = term.buffer.onBufferChange(() => {
    hideHistoryPreview();
    ctx.onAlternateScreenChange?.(term.buffer.active.type === "alternate");
  });

  const writeLocalTerminalData = (nextData: string) => {
    writeLocalTerminalDataInOrder(term, nextData, ctx.onTerminalLogData);
  };

  const handleTerminalInputData = (
    data: string,
    options?: { source?: "terminal" | "shift-enter" | "kitty" },
  ) => {
    // Clipboard paste / typed password while assist is open must dismiss the
    // hint first. Otherwise Enter is still hijacked for confirmFill and can
    // append the host session password after the user's pasted secret (#2198).
    ctx.sudoAutofillRef?.current?.dismissOnUserContentInput(data);

    const inputSource = options?.source ?? "terminal";
    const id = ctx.sessionRef.current;
    const dataToWrite = data;
    const sensitive = ctx.passwordPromptActiveRef?.current === true;
    let handledSubmittedInput = false;
    const submittedInput: { text: string; lineEnding: "\r\n" | "\r" | "\n" } | null =
      inputSource === "shift-enter"
        ? getShiftEnterSubmittedInput(data)
        : data === "\r" || data === "\n"
          ? { text: "", lineEnding: data as "\r" | "\n" }
          : null;
    const onBroadcastInput = ctx.onBroadcastInputRef.current;
    const broadcastDataBeforeSudo = mapTerminalBackspaceInput(data, ctx.host.backspaceBehavior);
    const suppressTerminalBroadcast = inputSource === "terminal" && suppressNextTerminalDataBroadcast;
    if (suppressTerminalBroadcast) suppressNextTerminalDataBroadcast = false;
    const willBroadcastInput = !sensitive &&
      inputSource !== "kitty" &&
      !handlingKittyBroadcast &&
      !suppressTerminalBroadcast &&
      !!id && shouldBroadcastTerminalUserInput(term, broadcastDataBeforeSudo, {
      isBroadcastEnabled: ctx.isBroadcastEnabledRef.current,
      hasBroadcastInputHandler: !!onBroadcastInput,
    });
    if (ctx.statusRef.current === "connected" && submittedInput) {
      if (submittedInput.text) {
        ctx.commandBufferRef.current += submittedInput.text;
        ctx.scriptRecorderRef?.current?.recordInput(submittedInput.text);
      }
      if (ctx.scriptRecorderRef?.current?.isRecording) {
        void ctx.scriptRecorderRef.current.recordEnter({
          sensitive,
        });
      }
      if (ctx.passwordPromptActiveRef) ctx.passwordPromptActiveRef.current = false;
      const recordedCommand = recordTerminalCommandExecution(
        ctx.commandBufferRef.current,
        ctx,
        term,
        { sensitive, allowHostStyleGreaterThanPrompt: ctx.allowHostStyleGreaterThanPrompt },
      );
      handledSubmittedInput = true;
      if (!willBroadcastInput) {
        prepareSudoAutofillInput(
          submittedInput.lineEnding === "\r\n" ? "\n" : submittedInput.lineEnding,
          recordedCommand,
          ctx.sudoAutofillRef?.current,
        );
      }
    } else if (
      ctx.statusRef.current === "connected" &&
      !willBroadcastInput &&
      inputSource !== "shift-enter"
    ) {
      const pastedCommand = getSinglePastedCommand(data);
      if (pastedCommand) {
        if (ctx.passwordPromptActiveRef) ctx.passwordPromptActiveRef.current = false;
        const recordedCommand = recordTerminalCommandExecution(
          `${ctx.commandBufferRef.current}${pastedCommand.command}`,
          ctx,
          term,
          { sensitive, allowHostStyleGreaterThanPrompt: ctx.allowHostStyleGreaterThanPrompt },
        );
        handledSubmittedInput = true;
        if (recordedCommand) {
          prepareSudoAutofillInput(
            `${recordedCommand}${pastedCommand.lineEnding}`,
            null,
            ctx.sudoAutofillRef?.current,
          );
        }
      }
    }

    if (id) {
      prioritizeTerminalInput(
        term,
        id,
        getFlowControllerForTerm(term),
        ctx.terminalBackend,
      );

      // Serial line mode: buffer input and send on Enter
      if (
        inputSource !== "kitty" &&
        ctx.host.protocol === "serial" &&
        ctx.serialLineMode &&
        ctx.serialLineBufferRef
      ) {
        handleSerialLineModeInput(dataToWrite, {
          bufferRef: ctx.serialLineBufferRef,
          localEcho: ctx.serialLocalEcho,
          writeToSession: (nextData) => {
            ctx.onOutputTriggerUserInputRef?.current?.(nextData);
            ctx.terminalBackend.writeToSession(id, nextData, { sensitive });
          },
          writeToTerminal: writeLocalTerminalData,
        });
      } else {
        // Character mode (default): send immediately
        // When backspaceBehavior is configured, remap the Backspace key output
        const outData = mapTerminalBackspaceInput(dataToWrite, ctx.host.backspaceBehavior);
        ctx.onOutputTriggerUserInputRef?.current?.(outData);
        ctx.terminalBackend.writeToSession(id, outData, { sensitive });

        // Local echo for serial connections only when explicitly enabled
        if (inputSource !== "kitty" && ctx.host.protocol === "serial" && ctx.serialLocalEcho) {
          const localEcho = formatSerialLocalEcho(dataToWrite);
          if (localEcho) writeLocalTerminalData(localEcho);
        }
        if (inputSource !== "kitty" && ctx.host.protocol === "telnet" && ctx.telnetLocalEchoRef?.current) {
          const localEcho = formatTelnetLocalEcho(dataToWrite);
          if (localEcho) writeLocalTerminalData(localEcho);
        }
      }

      // Use remapped data so broadcast peers also receive the correct byte
      const broadcastData = mapTerminalBackspaceInput(dataToWrite, ctx.host.backspaceBehavior);
      if (willBroadcastInput) {
        onBroadcastInput?.(broadcastData, ctx.sessionId);
      }

      if (!shouldSuppressTerminalInputScrollForUserPaste(term, data)) {
        scrollToBottomAfterInput(data);
      }

      // Notify autocomplete of input
      ctx.onAutocompleteInput?.(data);

      if (ctx.statusRef.current === "connected") {
        if (handledSubmittedInput || submittedInput) {
          // Command recording and sudo command preparation happen before the
          // input is written so sudo can receive a one-time prompt marker.
        } else if (data === "\x7f" || data === "\b") {
          ctx.commandBufferRef.current = ctx.commandBufferRef.current.slice(0, -1);
          ctx.scriptRecorderRef?.current?.recordBackspace();
        } else if (data === "\x03") {
          ctx.commandBufferRef.current = "";
          ctx.scriptRecorderRef?.current?.recordClearLine();
          // Hard-abort password assist when Ctrl+C reaches the input path
          // (e.g. broadcast peers) so a later su re-arms cleanly (#2191).
          ctx.sudoAutofillRef?.current?.abort();
        } else if (data === "\x15") {
          ctx.commandBufferRef.current = "";
          ctx.scriptRecorderRef?.current?.recordClearLine();
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          ctx.commandBufferRef.current += data;
          ctx.scriptRecorderRef?.current?.recordInput(data);
        } else if (data.length > 1 && !data.startsWith("\x1b")) {
          ctx.commandBufferRef.current += data;
          ctx.scriptRecorderRef?.current?.recordInput(data);
        } else {
          const pastedLine = getSingleBracketedPasteLine(data);
          if (pastedLine) {
            ctx.commandBufferRef.current += pastedLine;
            ctx.scriptRecorderRef?.current?.recordInput(pastedLine);
          }
        }
      }
    }
  };

  let kittyCompositionPending = false;
  let kittyCompositionClearTimer: number | undefined;
  const kittyForwardedKeys = new Map<string, KittyKeyboardForwardedPress>();
  const broadcastForwardedKeys = new Map<string, KittyKeyboardForwardedPress>();
  const broadcastEncodedKeys = new Set<string>();
  const broadcastLegacySuppressedKeys = new Set<string>();
  const kittyKeyIdentity = (event: KeyboardEvent): string => event.code || event.key;
  let handlingKittyBroadcast = false;
  let suppressNextTerminalDataBroadcast = false;
  let broadcastLegacyDataPending: string | null = null;
  let broadcastLegacyDataClearTimer: number | undefined;
  const clearBroadcastLegacyDataPending = () => {
    broadcastLegacyDataPending = null;
    suppressNextTerminalDataBroadcast = false;
    if (broadcastLegacyDataClearTimer !== undefined) {
      window.clearTimeout(broadcastLegacyDataClearTimer);
      broadcastLegacyDataClearTimer = undefined;
    }
  };
  const markBroadcastLegacyDataPending = (identity: string) => {
    clearBroadcastLegacyDataPending();
    broadcastLegacyDataPending = identity;
    suppressNextTerminalDataBroadcast = true;
    // xterm emits keyboard data synchronously from the keydown handler. Clear
    // an unmatched key before a later paste or IME commit can be mistaken for it.
    broadcastLegacyDataClearTimer = window.setTimeout(() => {
      clearBroadcastLegacyDataPending();
    }, 0);
  };
  const broadcastKittyInput = createKittyKeyboardBroadcastForwarder({
    sourceSessionId: ctx.sessionId,
    isHandlingBroadcast: () => handlingKittyBroadcast,
    isBroadcastEnabled: () => ctx.isBroadcastEnabledRef.current,
    isSensitiveInput: () => ctx.passwordPromptActiveRef?.current === true,
    getDispatcher: () => ctx.onBroadcastInputRef.current,
  });

  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    // Preserve mouse selection across keystrokes when enabled. xterm.js
    // unconditionally clears the selection on user input
    // (SelectionService.ts: coreService.onUserInput → clearSelection).
    // Capture the selection here, then re-apply it after xterm has
    // processed the key + cleared. The microtask runs after both
    // synchronous listeners, so by then either the selection is gone (and
    // we restore) or it's still there (we no-op).
    //
    // Both keydown AND keypress must be hooked: xterm routes Space
    // (keyCode 32 fails Keyboard.ts: `ev.keyCode >= 48`) and A–Z
    // (CoreBrowserTerminal.ts:_keyDown A–Z IME HACK) through the
    // `keypress` event, calling triggerDataEvent in _keyPress rather
    // than _keyDown. For those keys, keydown's microtask drains before
    // keypress fires, so hasSelection is still true → no-op. Attaching
    // to keypress gives us a second microtask that drains after
    // _keyPress clears the selection, so the restore runs.
    if (
      (e.type === "keydown" || e.type === "keypress") &&
      ctx.terminalSettingsRef.current?.preserveSelectionOnInput &&
      term.hasSelection()
    ) {
      const sel = term.getSelectionPosition();
      if (sel) {
        const length =
          (sel.end.y - sel.start.y) * term.cols + (sel.end.x - sel.start.x);
        const savedStartX = sel.start.x;
        const savedStartY = sel.start.y;
        queueMicrotask(() => {
          if (term.hasSelection()) return;
          // Bail out if scrollback trim invalidated the row index.
          if (savedStartY >= term.buffer.active.length) return;
          const restoreFlag = ctx.isRestoringSelectionRef;
          if (restoreFlag) restoreFlag.current = true;
          try {
            term.select(savedStartX, savedStartY, length);
          } finally {
            if (restoreFlag) restoreFlag.current = false;
          }
        });
      }
    }

    if (e.type === "keyup") {
      const identity = kittyKeyIdentity(e);
      if (broadcastLegacyDataPending === identity) clearBroadcastLegacyDataPending();
      const forwardedPress = broadcastForwardedKeys.get(identity);
      if (forwardedPress) {
        broadcastForwardedKeys.delete(identity);
        broadcastKittyInput(
          { kind: "key", event: toKittyKeyboardEvent(e) },
          true,
          forwardedPress.targetSessionIds,
        );
      }
      if (!kittyForwardedKeys.delete(identity)) return true;
      const kittyEvent = toKittyKeyboardEvent(e);
      const sequence = kittyKeyboardProtocolEnabled
        ? encodeKittyKeyEvent(kittyKeyboardMode, kittyEvent)
        : null;
      if (sequence) {
        e.preventDefault();
        e.stopPropagation();
        handleTerminalInputData(sequence, { source: "kitty" });
        return false;
      }
      return true;
    }

    if (e.type !== "keydown") {
      return true;
    }

    if (handlingKittyBroadcast) return true;

    if (e.keyCode === 229) {
      markKittyCompositionPending(true);
    }

    const forcedHistoryScrollPages = forcedHistoryScrollPagesForKey(e);
    if (forcedHistoryScrollPages !== null) {
      e.preventDefault();
      e.stopPropagation();
      const lines = forcedHistoryScrollPageToLines(forcedHistoryScrollPages, term.rows);
      if (showAlternateScreenHistoryPreview(lines)) {
        return false;
      }
      hideHistoryPreview();
      term.scrollPages(forcedHistoryScrollPages);
      return false;
    }
    hideHistoryPreview();

    // Password prompt assist (sudo/su): while pending, Enter confirms the
    // selected/host password; arrows move the picker; Esc soft-dismisses (keeps
    // arm so the list can re-open). Checked before autocomplete so Enter pastes
    // the password instead of submitting an empty line.
    // Paste is handled in handleTerminalInputData (dismissOnUserContentInput)
    // because clipboard paste does not go through this key handler (#2198).
    const sudoAutofill = ctx.sudoAutofillRef?.current;
    if (sudoAutofill?.isPromptPending()) {
      if (shouldSendShiftEnterText(e, ctx.terminalSettingsRef.current)) {
        sudoAutofill.cancelHint();
        // fall through: Shift+Enter sends the configured terminal text
      } else if (
        sudoAutofill.isPickerPending()
        && e.key === "ArrowDown"
        && !e.altKey
        && !e.ctrlKey
        && !e.metaKey
      ) {
        e.preventDefault();
        sudoAutofill.moveSelection(1);
        return false;
      } else if (
        sudoAutofill.isPickerPending()
        && e.key === "ArrowUp"
        && !e.altKey
        && !e.ctrlKey
        && !e.metaKey
      ) {
        e.preventDefault();
        sudoAutofill.moveSelection(-1);
        return false;
      } else if (
        e.key === "Enter" &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        sudoAutofill.confirmFill();
        return false;
      }
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        sudoAutofill.cancelHint();
        return false; // dismiss without forwarding the byte to the no-echo prompt
      }
      // Printable keys soft-dismiss so the user can type a password manually.
      // Keep soft-dismiss for AltGr/Option-produced characters (they report
      // Ctrl/Alt modifiers on Windows/macOS). Only plain Ctrl+C skips this —
      // the interrupt path hard-aborts instead (#2191).
      if (
        e.key.length === 1
        && !shouldUseUrgentTerminalInterrupt(e, { hasSelection: term.hasSelection() })
      ) {
        sudoAutofill.cancelHint();
        // fall through: key becomes the first char of the manually typed password
      }
    } else if (
      sudoAutofill?.canReshowAssist()
      && !e.altKey
      && !e.ctrlKey
      && !e.metaKey
      && (e.key === "Escape" || e.key === "ArrowDown" || e.key === "ArrowUp")
    ) {
      // Soft-dismissed but still on Password: — Esc/arrows re-open the assist.
      e.preventDefault();
      if (sudoAutofill.tryReshowAssist()) {
        if (e.key === "ArrowDown") sudoAutofill.moveSelection(1);
        if (e.key === "ArrowUp") sudoAutofill.moveSelection(-1);
      }
      return false;
    }

    // Autocomplete key handler (must be checked before other handlers)
    if (ctx.onAutocompleteKeyEvent && !isKittyKeyboardModeActive(kittyKeyboardMode)) {
      const consumed = ctx.onAutocompleteKeyEvent(e);
      if (!consumed) return false; // Event was consumed by autocomplete
    }

    const kittySequenceForKeyDown =
      kittyKeyboardProtocolEnabled
        ? encodeKittyKeyEvent(kittyKeyboardMode, toKittyKeyboardEvent(e))
        : null;
    if (
      (!kittySequenceForKeyDown || kittySequenceForKeyDown === "\x03") &&
      shouldUseUrgentTerminalInterrupt(e, { hasSelection: term.hasSelection() })
    ) {
      const id = ctx.sessionRef.current;
      if (id && ctx.statusRef.current === "connected") {
        const rendererKeyAt = Date.now();
        e.preventDefault();
        e.stopPropagation();
        // Abort password assist: user is cancelling the remote command, not
        // soft-dismissing the UI. A later su must re-arm cleanly (#2191).
        sudoAutofill?.abort();
        const priority = prioritizeTerminalInput(
          term,
          id,
          getFlowControllerForTerm(term),
          ctx.terminalBackend,
          {
            reason: "interrupt",
            drainStaleOutput: shouldArmTerminalInterruptDisplayGateForProtocol(ctx.host.protocol),
          },
        );
        const interruptTrace = createTerminalInterruptTrace({
          sessionId: id,
          rendererKeyAt,
          status: ctx.statusRef.current,
          hasSelection: false,
          priority,
        });
        logTerminalInterruptTrace("renderer-keydown-send", interruptTrace, {
          priority,
        });
        clearTerminalInputStateForInterrupt({
          commandBufferRef: ctx.commandBufferRef,
          serialLineBufferRef: ctx.serialLineBufferRef,
          onAutocompleteInput: ctx.onAutocompleteInput,
        });
        if (ctx.passwordPromptActiveRef) {
          ctx.passwordPromptActiveRef.current = false;
        }
        if (ctx.terminalBackend.interruptSession) {
          ctx.terminalBackend.interruptSession(id, interruptTrace);
        } else {
          ctx.terminalBackend.writeToSession(id, "\x03");
        }
        const kittyEvent = toKittyKeyboardEvent(e);
        const identity = kittyKeyIdentity(e);
        if (
          kittyKeyboardProtocolEnabled &&
          shouldTrackKittyKeyRelease(kittyKeyboardMode, kittyEvent)
        ) {
          upsertKittyKeyboardForwardedPress(
            kittyForwardedKeys,
            identity,
            kittyEvent,
            [],
          );
        }
        const forwarded = broadcastKittyInput({ kind: "key", event: kittyEvent });
        if (forwarded) {
          upsertKittyKeyboardForwardedPress(
            broadcastForwardedKeys,
            identity,
            kittyEvent,
            forwarded.targetSessionIds,
          );
          broadcastKittyInput({
            kind: "legacy",
            data: "\x03",
            keyIdentity: identity,
            urgentInterrupt: true,
          });
        }
        scrollToBottomAfterInput("\x03");
        return false;
      }
    }

    const currentScheme = ctx.hotkeySchemeRef.current;
    // Use shared utility for platform detection when hotkey scheme is disabled
    const isMac = currentScheme === "mac" || (currentScheme === "disabled" && isMacPlatform());

    // Check snippet shortcuts first (even if hotkeys are disabled)
    const snippets = ctx.snippetsRef?.current;
    if (snippets && snippets.length > 0) {
      for (const snippet of snippets) {
        if (snippet.shortkey && matchesKeyBinding(e, snippet.shortkey, isMac)) {
          const id = ctx.sessionRef.current;
          if (id && ctx.statusRef.current === "connected") {
            e.preventDefault();
            e.stopPropagation();
            const runSnippet = ctx.onSnippetShortkeyRef?.current;
            if (runSnippet) {
              void runSnippet(snippet);
            }
            return false;
          }
          return true;
        }
      }
    }

    const currentBindings = ctx.keyBindingsRef.current;
    if (currentScheme !== "disabled" && currentBindings.length > 0) {
      const matched = checkAppShortcut(e, currentBindings, isMac);
      if (matched) {
        const { action } = matched;

        if (appLevelActions.has(action)) {
          return true; // Let app-level handler process it
        }

        if (terminalActions.has(action)) {
          if (
            isTerminalFontSizeAction(action)
            && !shouldHandleTerminalFontSizeAction(action, ctx.disableTerminalFontZoomRef.current)
          ) {
            return true;
          }
          // When copy is bound specifically to Ctrl+C and there is no text
          // selected, pass the event through so xterm can send SIGINT.
          const shouldForwardCopyToTerminal =
            shouldPassThroughCopyShortcut(action, term.hasSelection(), e);
          if (shouldForwardCopyToTerminal && !kittySequenceForKeyDown) return true;
          if (!shouldForwardCopyToTerminal) {
            e.preventDefault();
            e.stopPropagation();
            switch (action) {
            case "copy": {
              const selection = getTerminalSelectionForClipboard(
                term,
                ctx.terminalSettingsRef.current?.normalizeTextOnCopy ?? true,
              );
              if (selection) navigator.clipboard.writeText(selection);
              break;
            }
            case "paste": {
              navigator.clipboard.readText().then((text) => {
                const id = ctx.sessionRef.current;
                if (id) {
                  pasteTextIntoTerminal(term, text, {
                    scrollOnPaste: shouldScrollOnTerminalPaste(ctx.terminalSettingsRef.current),
                    onPasteData: broadcastUserPasteData,
                  });
                }
              });
              break;
            }
            case "pasteSelection": {
              const selection = getTerminalSelectionForClipboard(
                term,
                ctx.terminalSettingsRef.current?.normalizeTextOnCopy ?? true,
              );
              const id = ctx.sessionRef.current;
              if (selection && id) {
                pasteTextIntoTerminal(term, selection, {
                  scrollOnPaste: shouldScrollOnTerminalPaste(ctx.terminalSettingsRef.current),
                  onPasteData: broadcastUserPasteData,
                });
              }
              break;
            }
            case "selectAll": {
              term.selectAll();
              break;
            }
            case "clearBuffer": {
              clearTerminalViewportAndSyncPty(term, {
                wipeScrollback: ctx.terminalSettingsRef.current?.clearWipesScrollback ?? true,
                syncPty: () => {
                  const clearId = ctx.sessionRef.current;
                  if (clearId) {
                    ctx.terminalBackend.clearSessionPtyBuffer?.(clearId);
                  }
                },
              });
              break;
            }
            case "searchTerminal": {
              ctx.requestSearchFocus();
              break;
            }
            case "increaseTerminalFontSize":
            case "decreaseTerminalFontSize":
            case "resetTerminalFontSize": {
              applyTerminalFontSize(
                nextTerminalFontSizeForAction(
                  action,
                  currentTerminalFontSize(),
                  ctx.disableTerminalFontZoomRef.current,
                ),
              );
              break;
            }
            }
            return false;
          }
        }
      }
    }

    if (kittySequenceForKeyDown) {
      e.preventDefault();
      e.stopPropagation();
      const kittyEvent = toKittyKeyboardEvent(e);
      upsertKittyKeyboardForwardedPress(
        kittyForwardedKeys,
        kittyKeyIdentity(e),
        kittyEvent,
        [],
      );
      handleTerminalInputData(kittySequenceForKeyDown, { source: "kitty" });
      const forwarded = broadcastKittyInput({
        kind: "key",
        event: kittyEvent,
        fallbackToLegacy: true,
        urgentInterrupt: shouldUseUrgentTerminalInterrupt(e, {
          hasSelection: term.hasSelection(),
        }),
      });
      if (forwarded) {
        upsertKittyKeyboardForwardedPress(
          broadcastForwardedKeys,
          kittyKeyIdentity(e),
          kittyEvent,
          forwarded.targetSessionIds,
        );
      }
      return false;
    }

    if (
      !isKittyKeyboardModeActive(kittyKeyboardMode) &&
      shouldSendShiftEnterText(e, ctx.terminalSettingsRef.current)
    ) {
      const id = ctx.sessionRef.current;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        const textToSend = resolveShiftEnterText(ctx.terminalSettingsRef.current);
        if (textToSend) {
          handleTerminalInputData(textToSend, { source: "shift-enter" });
        }
        return false;
      }
    }

    // macOS Option+←/→ → Meta-b / Meta-f so the shell jumps by word (discussion
    // #826). After kitty mode so apps using the kitty protocol keep their own
    // arrow encoding; read live so the toggle applies without reconnecting.
    const wordJumpSequence = isKittyKeyboardModeActive(kittyKeyboardMode)
      ? null
      : optionArrowWordJumpSequence(
          e,
          ctx.terminalSettingsRef.current?.optionArrowWordJump ?? false,
          isMacPlatform(),
        );
    if (wordJumpSequence) {
      const id = ctx.sessionRef.current;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        handleTerminalInputData(wordJumpSequence);
        scrollToBottomAfterInput(wordJumpSequence);
        return false;
      }
    }

    const normalizedKittyEvent = toKittyKeyboardEvent(e);
    if (!shouldDeferKittyKeyEvent(normalizedKittyEvent)) {
      const identity = kittyKeyIdentity(e);
      if (
        kittyKeyboardProtocolEnabled &&
        shouldTrackKittyKeyRelease(kittyKeyboardMode, normalizedKittyEvent)
      ) {
        upsertKittyKeyboardForwardedPress(
          kittyForwardedKeys,
          identity,
          normalizedKittyEvent,
          [],
        );
      }
      const forwarded = broadcastKittyInput({
        kind: "key",
        event: normalizedKittyEvent,
        fallbackToLegacy: true,
      });
      if (forwarded) {
        upsertKittyKeyboardForwardedPress(
          broadcastForwardedKeys,
          identity,
          normalizedKittyEvent,
          forwarded.targetSessionIds,
        );
      }
      if (
        shouldExpectLegacyKeyboardData(normalizedKittyEvent) &&
        ctx.isBroadcastEnabledRef.current &&
        ctx.onBroadcastInputRef.current
      ) {
        markBroadcastLegacyDataPending(identity);
      }
    }
    return true;
  });

  const handleMiddleClick = (e: MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();

    const behavior = resolveMiddleClickBehavior(ctx.terminalSettingsRef.current);
    if (behavior === "disabled") return;

    if (behavior === "paste") {
      void ctx.terminalContextActionsRef?.current?.onPaste?.();
      return;
    }

    const contextMenuEvent = markMiddleClickContextMenuEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      button: 2,
      buttons: 0,
      view: window,
    }));
    ctx.container.dispatchEvent(contextMenuEvent);
  };

  ctx.container.addEventListener("mousedown", captureMiddleClickTerminalMouseEvent, true);
  ctx.container.addEventListener("mouseup", captureMiddleClickTerminalMouseEvent, true);
  ctx.container.addEventListener("mousedown", hideHistoryPreview, true);
  ctx.container.addEventListener("auxclick", handleMiddleClick);

  fitAddon.fit();
  term.focus();

  const markKittyCompositionPending = (autoClear = false) => {
    clearBroadcastLegacyDataPending();
    if (kittyCompositionClearTimer !== undefined) {
      window.clearTimeout(kittyCompositionClearTimer);
      kittyCompositionClearTimer = undefined;
    }
    if (
      shouldEncodeKittyCompositionText(kittyKeyboardMode) ||
      (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current)
    ) {
      kittyCompositionPending = true;
      if (autoClear) {
        kittyCompositionClearTimer = window.setTimeout(() => {
          kittyCompositionPending = false;
          kittyCompositionClearTimer = undefined;
        }, 0);
      }
    }
  };
  const finishKittyComposition = () => {
    markKittyCompositionPending();
    kittyCompositionClearTimer = window.setTimeout(() => {
      kittyCompositionPending = false;
      kittyCompositionClearTimer = undefined;
    }, 0);
  };
  const clearKittyConnectionInputState = () => {
    kittyCompositionPending = false;
    kittyForwardedKeys.clear();
    clearKittyKeyboardBroadcastPairingState(
      broadcastEncodedKeys,
      broadcastLegacySuppressedKeys,
    );
    clearBroadcastLegacyDataPending();
    if (kittyCompositionClearTimer !== undefined) {
      window.clearTimeout(kittyCompositionClearTimer);
      kittyCompositionClearTimer = undefined;
    }
  };
  const clearKittyTransientInputState = () => {
    flushKittyKeyboardBroadcastReleases(
      kittyForwardedKeys,
      (input) => {
        if (input.kind !== "key" || !kittyKeyboardProtocolEnabled) return;
        const sequence = encodeKittyKeyEvent(kittyKeyboardMode, input.event);
        if (sequence) handleTerminalInputData(sequence, { source: "kitty" });
      },
      kittyKeyboardLockState,
    );
    flushKittyKeyboardBroadcastReleases(
      broadcastForwardedKeys,
      broadcastKittyInput,
      kittyKeyboardLockState,
    );
    clearKittyConnectionInputState();
  };
  const textarea = term.textarea;
  const startKittyComposition = () => markKittyCompositionPending();
  const markKittyTextInput = (event: InputEvent) => {
    if (shouldMarkKittyTextInputEvent(event)) markKittyCompositionPending(true);
  };
  textarea?.addEventListener("compositionstart", startKittyComposition);
  textarea?.addEventListener("compositionend", finishKittyComposition);
  // Capture on the ancestor so this runs before xterm's target listener, which
  // can synchronously emit standalone emoji, speech, or mobile insertText data.
  ctx.container.addEventListener("input", markKittyTextInput, true);
  textarea?.addEventListener("blur", clearKittyTransientInputState);

  term.onData((data) => {
    if (kittyCompositionPending && !data.startsWith("\u001b")) {
      kittyCompositionPending = false;
      if (kittyCompositionClearTimer !== undefined) {
        window.clearTimeout(kittyCompositionClearTimer);
        kittyCompositionClearTimer = undefined;
      }
      const encoded = encodeKittyCompositionText(kittyKeyboardMode, data);
      if (encoded) {
        handleTerminalInputData(encoded, { source: "kitty" });
      } else {
        if (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current) {
          suppressNextTerminalDataBroadcast = true;
        }
        handleTerminalInputData(data);
      }
      broadcastKittyInput({ kind: "text", text: data });
      return;
    }
    if (broadcastLegacyDataPending) {
      const keyIdentity = broadcastLegacyDataPending;
      if (broadcastLegacyDataClearTimer !== undefined) {
        window.clearTimeout(broadcastLegacyDataClearTimer);
        broadcastLegacyDataClearTimer = undefined;
      }
      broadcastKittyInput({
        kind: "legacy",
        data,
        keyIdentity,
      });
      broadcastLegacyDataPending = null;
    }
    handleTerminalInputData(data);
  });

  const handleKittyKeyboardBroadcast = createKittyKeyboardBroadcastHandler({
    resolveOptions: () => ({
      kittyProtocolEnabled: kittyKeyboardProtocolEnabled,
      kittyMode: kittyKeyboardMode,
      applicationCursorMode: term.modes.applicationCursorKeysMode,
      encodedKeys: broadcastEncodedKeys,
      legacySuppressedKeys: broadcastLegacySuppressedKeys,
    }),
    getSessionId: () => ctx.sessionRef.current,
    isSensitiveInput: () => ctx.passwordPromptActiveRef?.current === true,
    isConnected: () => ctx.statusRef.current === "connected",
    isRuntimeDisposed: () => runtimeDisposed,
    interruptSession: ctx.terminalBackend.interruptSession
      ? (id) => ctx.terminalBackend.interruptSession?.(id)
      : undefined,
    writeDisposed: (id, data) => ctx.terminalBackend.writeToSession(
      id,
      mapTerminalBackspaceInput(data, ctx.host.backspaceBehavior),
      { sensitive: ctx.passwordPromptActiveRef?.current === true },
    ),
    writeActive: (data) => handleTerminalInputData(data, { source: "kitty" }),
  });
  registerKittyKeyboardBroadcastHandler(
    ctx.sessionId,
    (input) => {
      handlingKittyBroadcast = true;
      try {
        handleKittyKeyboardBroadcast(input);
      } finally {
        handlingKittyBroadcast = false;
      }
    },
  );

  // Track current working directory via OSC 7 escape sequences
  // OSC 7 format: \x1b]7;file://hostname/path\x07 or \x1b]7;file://hostname/path\x1b\\
  let currentCwd: string | undefined = undefined;

  // Track DEC 2026 synchronized-output blocks so CSI 2 J can erase in place for
  // Codex/Claude Code TUIs instead of pushing visible rows into scrollback.
  let inDec2026SyncBlock = false;

  const dec2026SyncStartDisposable = term.parser.registerCsiHandler(
    { prefix: "?", final: "h", params: [2026] },
    () => {
      inDec2026SyncBlock = true;
      return false;
    },
  );
  const dec2026SyncEndDisposable = term.parser.registerCsiHandler(
    { prefix: "?", final: "l", params: [2026] },
    () => {
      inDec2026SyncBlock = false;
      return false;
    },
  );

  const eraseScrollbackDisposable = installEraseInDisplayHandlers(term, {
    getClearWipesScrollback: () => ctx.terminalSettingsRef.current?.clearWipesScrollback ?? true,
    isInDec2026SyncBlock: () => inDec2026SyncBlock,
  });

  const markCursorPositionReportRequest = (params: readonly (number | number[])[]): boolean => {
    if (csiParamsInclude(params, 6)) {
      markExpectedTerminalCursorPositionReport(term);
    }
    return false;
  };

  const cursorPositionReportRequestDisposables = [
    term.parser.registerCsiHandler({ final: "n" }, markCursorPositionReportRequest),
    term.parser.registerCsiHandler({ prefix: "?", final: "n" }, markCursorPositionReportRequest),
  ];

  const writeKittyKeyboardReply = (payload: string) => {
    const id = ctx.sessionRef.current;
    if (!id) return;
    ctx.terminalBackend.writeToSession(id, payload);
  };

  const setKittyKeyboardProtocolEnabled = (enabled: boolean) => {
    if (kittyKeyboardProtocolEnabled === enabled) return;
    kittyKeyboardDisposable?.dispose();
    kittyKeyboardDisposable = undefined;
    kittyKeyboardProtocolEnabled = enabled;
    kittyKeyboardDisposable = installKittyKeyboardProtocolHandlersIfEnabled(
      enabled,
      term.parser,
      kittyKeyboardMode,
      writeKittyKeyboardReply,
    );
  };

  kittyKeyboardDisposable = installKittyKeyboardProtocolHandlersIfEnabled(
    kittyKeyboardProtocolEnabled,
    term.parser,
    kittyKeyboardMode,
    writeKittyKeyboardReply,
  );

  // Register OSC 7 handler using xterm.js parser
  // OSC 7 is the standard way for shells to report the current working directory
  const osc7Disposable = term.parser.registerOscHandler(7, (data) => {
    try {
      // data is the content after "7;" - typically "file://hostname/path"
      if (data.startsWith('file://')) {
        // Extract path from file:// URL
        const url = new URL(data);
        const path = decodeURIComponent(url.pathname);
        if (path && path.length > 0) {
          currentCwd = path;
          ctx.onCwdChange?.(path);
          logger.debug('[XTerm] OSC 7 CWD update:', path);
        }
      } else if (data.startsWith('/')) {
        // Some shells send just the path without file:// prefix
        currentCwd = data;
        ctx.onCwdChange?.(data);
        logger.debug('[XTerm] OSC 7 CWD update (raw path):', data);
      }
    } catch (err) {
      logger.warn('[XTerm] Failed to parse OSC 7:', err);
    }
    return true; // Indicate we handled the sequence
  });

  const osc133Disposable = term.parser.registerOscHandler(133, (data) => {
    if (consumeOsc133CommandCompletion(data, ctx.promptLineBreakStateRef?.current)) {
      ctx.onCommandCompleted?.();
    }
    return true;
  });

  // OSC 52 — clipboard integration
  // Format: 52;<target>;<base64-data>  (write)  or  52;<target>;?  (query/read)
  // <target> is typically "c" (clipboard) or "p" (primary selection)
  // Controlled by terminalSettings.osc52Clipboard: 'off' | 'write-only' | 'read-write'
  const osc52Disposable = term.parser.registerOscHandler(52, (data) => {
    const settings = ctx.terminalSettingsRef.current;
    const mode = settings?.osc52Clipboard ?? 'write-only';
    if (mode === 'off') return true;

    try {
      const semi = data.indexOf(';');
      if (semi < 0) return true;
      const target = data.substring(0, semi);
      // Only handle clipboard target ('c'); reject unsupported targets like 'p' (PRIMARY)
      if (target !== 'c' && target !== '') return true;
      const payload = data.substring(semi + 1);

      if (payload === '?') {
        // Read request — allowed in read-write mode, or prompt user in prompt mode
        if (mode !== 'read-write' && mode !== 'prompt') {
          logger.debug('[XTerm] OSC 52 read request ignored (mode:', mode, ')');
          return true;
        }
        const sessionId = ctx.sessionRef.current;
        if (!sessionId) return true;
        // Use Electron bridge as primary, fall back to navigator.clipboard
        const readClipboard = async (): Promise<string> => {
          try {
            const bridge = netcattyBridge.get();
            if (bridge?.readClipboardText) return await bridge.readClipboardText();
          } catch { /* fall through to navigator.clipboard */ }
          return navigator.clipboard.readText();
        };
        const doRead = async () => {
          // In prompt mode, ask user first
          if (mode === 'prompt') {
            const allowed = ctx.onOsc52ReadRequest ? await ctx.onOsc52ReadRequest() : false;
            if (!allowed) {
              logger.debug('[XTerm] OSC 52 read denied by user');
              return;
            }
          }
          const text = await readClipboard();
          // Chunked base64 encoding to avoid stack overflow on large payloads
          const bytes = new TextEncoder().encode(text);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          const b64 = btoa(binary);
          // This host-generated protocol reply contains clipboard contents. It
          // must bypass plugin input interceptors just like password/OTP data;
          // otherwise terminal interception would become an undeclared
          // clipboard-read capability.
          ctx.terminalBackend.writeToSession(
            sessionId,
            `\x1b]52;${target};${b64}\x07`,
            { sensitive: true },
          );
        };
        doRead().catch((err) => {
          logger.warn('[XTerm] OSC 52 clipboard read failed:', err);
        });
        return true;
      }

      // Write: payload is base64-encoded UTF-8 text
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      navigator.clipboard.writeText(text).catch((err) => {
        logger.warn('[XTerm] OSC 52 clipboard write failed:', err);
      });
      logger.debug('[XTerm] OSC 52 clipboard write', { length: text.length });
    } catch (err) {
      logger.warn('[XTerm] Failed to handle OSC 52:', err);
    }
    return true;
  });

  const cursorPreferenceDisposable = installUserCursorPreferenceGuard(term, ctx.terminalSettingsRef);

  const titleChangeDisposable = term.onTitleChange((title) => {
    const trimmed = title.trim();
    ctx.onTitleChange?.(trimmed.length > 0 ? trimmed : null);
  });

  const bellDisposable = term.onBell(() => {
    ctx.onBell?.();
  });

  const resizeDebounceMs = XTERM_PERFORMANCE_CONFIG.resize.debounceMs;
  const resizeScheduler = createTerminalResizeScheduler(
    resizeDebounceMs,
    ({ sessionId, cols, rows }) => {
      ctx.terminalBackend.resizeSession(sessionId, cols, rows);
      ctx.onResize?.(cols, rows);
    },
  );
  term.onResize(({ cols, rows }) => {
    // A reflow can leave stale glyphs in the WebGL atlas; clear it so the new
    // dimensions re-rasterize cleanly (issue #1049).
    clearWebglTextureAtlas();
    const id = ctx.sessionRef.current;
    if (!id) return;
    resizeScheduler.schedule({ sessionId: id, cols, rows });
  });

  const keywordHighlighter = new KeywordHighlighter(term);
  keywordHighlighter.setRules(keywordHighlightRules, keywordHighlightEnabled);

  return {
    term,
    fitAddon,
    serializeAddon,
    searchAddon,
    keywordHighlighter,
    pluginProviderHost,
    pluginLinkProviderHost,
    clearTextureAtlas: clearWebglTextureAtlas,
    ensureWebglRenderer: loadWebglRenderer,
    suspendWebglRenderer,
    resetKittyConnectionInputState: clearKittyConnectionInputState,
    flushKittyKeyboardReleases: clearKittyTransientInputState,
    getKittyKeyboardModeState: () => snapshotKittyKeyboardModeState(kittyKeyboardMode),
    restoreKittyKeyboardModeState: (state) => restoreKittyKeyboardModeState(
      kittyKeyboardMode,
      state,
    ),
    getKittyKeyboardProtocolEnabled: () => kittyKeyboardProtocolEnabled,
    setKittyKeyboardProtocolEnabled,
    dispose: () => {
      runtimeDisposed = true;
      resizeScheduler.dispose();
      webglController.dispose();
      term.element?.removeEventListener("copy", handleNativeCopy, true);
      ctx.container.removeEventListener(
        "wheel",
        handleForcedHistoryScrollWheel,
        forcedHistoryScrollWheelListenerOptions,
      );
      ctx.container.removeEventListener(
        "wheel",
        handleFontSizeWheel,
        terminalFontSizeWheelListenerOptions,
      );
      ctx.container.removeEventListener("auxclick", handleMiddleClick);
      ctx.container.removeEventListener("mousedown", captureMiddleClickTerminalMouseEvent, true);
      ctx.container.removeEventListener("mouseup", captureMiddleClickTerminalMouseEvent, true);
      ctx.container.removeEventListener("mousedown", hideHistoryPreview, true);
      hideHistoryPreview();
      historyPreviewBufferChangeDisposable.dispose();
      stopDprWatch();
      keywordHighlighter.dispose();
      pluginLinkProviderHost?.dispose();
      pluginProviderHost?.dispose();
      eraseScrollbackDisposable.dispose();
      dec2026SyncStartDisposable.dispose();
      dec2026SyncEndDisposable.dispose();
      for (const disposable of cursorPositionReportRequestDisposables) {
        disposable.dispose();
      }
      kittyKeyboardDisposable?.dispose();
      keyboardApi?.removeEventListener?.("layoutchange", refreshKittyKeyboardLayout);
      textarea?.removeEventListener("compositionstart", startKittyComposition);
      textarea?.removeEventListener("compositionend", finishKittyComposition);
      ctx.container.removeEventListener("input", markKittyTextInput, true);
      textarea?.removeEventListener("blur", clearKittyTransientInputState);
      clearKittyTransientInputState();
      osc7Disposable.dispose();
      osc133Disposable.dispose();
      osc52Disposable.dispose();
      titleChangeDisposable.dispose();
      bellDisposable.dispose();
      cursorPreferenceDisposable?.dispose();
      try {
        term.dispose();
      } catch (err) {
        logger.warn("[XTerm] dispose failed", err);
      }
      try {
        fitAddon.dispose();
      } catch (err) {
        logger.warn("[XTerm] fitAddon dispose failed", err);
      }
      try {
        serializeAddon.dispose();
      } catch (err) {
        logger.warn("[XTerm] serializeAddon dispose failed", err);
      }
      try {
        searchAddon.dispose();
      } catch (err) {
        logger.warn("[XTerm] searchAddon dispose failed", err);
      }
    },
    get currentCwd() {
      return currentCwd;
    },
  };
};
