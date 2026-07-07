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
  XTERM_PERFORMANCE_CONFIG,
  resolveXTermScrollback,
  type XTermPlatform,
  resolveXTermPerformanceConfig,
} from "../../../infrastructure/config/xtermPerformance";
import {
  shouldEnableNativeUserInputAutoScroll,
  shouldScrollOnTerminalInput,
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
  clearTerminalViewport,
  installEraseInDisplayHandlers,
} from "../clearTerminalViewport";
import {
  createKittyKeyboardModeState,
  encodeKittyControlKey,
} from "./kittyKeyboardProtocol";
import { installKittyKeyboardProtocolHandlers } from "./kittyKeyboardRuntime";
import { installUserCursorPreferenceGuard } from "./cursorPreference";
import { terminalAltKeyOptions } from "./altKeyOptions";
import { optionArrowWordJumpSequence } from "./optionArrowWordJump";
import { watchDevicePixelRatio } from "./rendererDprWatch";
import { shouldDeferWebglUntilVisible } from "./webglRendererPolicy";
import {
  captureMiddleClickTerminalMouseEvent,
  markMiddleClickContextMenuEvent,
  resolveMiddleClickBehavior,
} from "./middleClickBehavior";
import { handleSerialLineModeInput } from "./serialLineInput";
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
  setSessionFlowPaused?: (sessionId: string, paused: boolean) => void;
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
};

export type CreateXTermRuntimeContext = {
  container: HTMLDivElement;
  host: Host;
  fontFamilyId: string;
  resolvedFontFamily: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  terminalSettingsRef: RefObject<TerminalSettings | undefined>;
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
    ((data: string, sourceSessionId: string) => void) | undefined
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
  const kittyKeyboardMode = createKittyKeyboardModeState();

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

  let webglAddon: WebglAddon | null = null;
  let webglLoaded = false;
  const scopedWindow = window as Window & {
    __xtermWebGLLoaded?: boolean;
    __xtermRendererPreference?: string;
  };

  // Idempotent: creates the WebGL renderer on first call and no-ops afterwards
  // (or when WebGL is disabled for this device). Panes that mount hidden defer
  // this until they first become visible — see shouldDeferWebglUntilVisible —
  // so batch-connecting many hosts doesn't spin up every WebGL context at once.
  const loadWebglRenderer = () => {
    if (webglLoaded || !performanceConfig.useWebGLAddon) return;
    try {
      // WebglAddon constructor only accepts `preserveDrawingBuffer?: boolean`.
      // Passing an object here (legacy API assumption) unintentionally enables
      // preserveDrawingBuffer and can cause sporadic glyph artifacts/ghosting.
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        logger.warn("[XTerm] WebGL context loss detected, disposing addon");
        webglAddon?.dispose();
        webglAddon = null;
        webglLoaded = false;
      });
      term.loadAddon(webglAddon);
      webglLoaded = true;
    } catch (webglErr) {
      logger.warn(
        "[XTerm] WebGL addon failed, using DOM renderer. Error:",
        webglErr instanceof Error ? webglErr.message : webglErr,
      );
    }
    scopedWindow.__xtermWebGLLoaded = webglLoaded;
  };

  const suspendWebglRenderer = () => {
    if (!webglAddon) {
      webglLoaded = false;
      scopedWindow.__xtermWebGLLoaded = false;
      return;
    }
    try {
      webglAddon.dispose();
    } catch (webglErr) {
      logger.warn("[XTerm] Failed to suspend WebGL renderer", webglErr);
    }
    webglAddon = null;
    webglLoaded = false;
    scopedWindow.__xtermWebGLLoaded = false;
  };

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

  const webLinksAddon = new WebLinksAddon((event, uri) => {
    const currentLinkModifier = ctx.terminalSettingsRef.current?.linkModifier ?? "none";
    let shouldOpen = false;
    switch (currentLinkModifier) {
      case "none":
        shouldOpen = true;
        break;
      case "ctrl":
        shouldOpen = event.ctrlKey;
        break;
      case "alt":
        shouldOpen = event.altKey;
        break;
      case "meta":
        shouldOpen = event.metaKey;
        break;
    }
    if (!shouldOpen) return;

    if (ctx.terminalBackend.openExternalAvailable()) {
      void ctx.terminalBackend.openExternal(uri);
    } else {
      const safeUri = String(uri || "");
      if (/^https?:\/\//i.test(safeUri)) {
        window.open(safeUri, "_blank", "noopener,noreferrer");
      } else {
        logger.warn("[XTerm] Refusing to open non-http(s) link:", safeUri);
      }
    }
  });
  term.loadAddon(webLinksAddon);

  // Enable Unicode graphemes for accurate CJK / emoji / Nerd Font character width handling
  const unicodeGraphemes = new UnicodeGraphemesAddon();
  term.loadAddon(unicodeGraphemes);
  term.unicode.activeVersion = '15-graphemes';

  trackRenderer();

  const appLevelActions = getAppLevelActions();
  const terminalActions = getTerminalPassthroughActions();
  const broadcastUserPasteData = (data: string) => {
    if (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current) {
      ctx.onBroadcastInputRef.current(data, ctx.sessionId);
      return true;
    }
    return false;
  };
  const scrollToBottomAfterInput = (data: string) => {
    if (shouldScrollOnTerminalInput(ctx.terminalSettingsRef.current, data)) {
      term.scrollToBottom();
    }
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

    if (e.type !== "keydown") {
      return true;
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

    // Sudo password hint: while a hint is pending, Enter confirms (paste the
    // saved password + submit); any other visible key dismisses it so the user
    // can type the password manually. Checked before autocomplete so Enter
    // pastes the password instead of submitting an empty line.
    const sudoAutofill = ctx.sudoAutofillRef?.current;
    if (sudoAutofill?.isPromptPending()) {
      if (e.key === "Enter") {
        e.preventDefault();
        sudoAutofill.confirmFill();
        return false;
      }
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        sudoAutofill.cancelHint();
        return false; // dismiss without forwarding the byte to the no-echo prompt
      }
      if (e.key.length === 1) {
        sudoAutofill.cancelHint();
        // fall through: key becomes the first char of the manually typed password
      }
    }

    // Autocomplete key handler (must be checked before other handlers)
    if (ctx.onAutocompleteKeyEvent) {
      const consumed = ctx.onAutocompleteKeyEvent(e);
      if (!consumed) return false; // Event was consumed by autocomplete
    }

    if (shouldUseUrgentTerminalInterrupt(e, { hasSelection: term.hasSelection() })) {
      const id = ctx.sessionRef.current;
      if (id && ctx.statusRef.current === "connected") {
        const rendererKeyAt = Date.now();
        e.preventDefault();
        e.stopPropagation();
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
        if (ctx.terminalBackend.interruptSession) {
          ctx.terminalBackend.interruptSession(id, interruptTrace);
        } else {
          ctx.terminalBackend.writeToSession(id, "\x03");
        }
        if (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current) {
          ctx.onBroadcastInputRef.current("\x03", ctx.sessionId);
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
          if (shouldPassThroughCopyShortcut(action, term.hasSelection(), e)) {
            return true;
          }
          e.preventDefault();
          e.stopPropagation();
          switch (action) {
            case "copy": {
              const selection = term.getSelection();
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
              const selection = term.getSelection();
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
              clearTerminalViewport(term, {
                wipeScrollback: ctx.terminalSettingsRef.current?.clearWipesScrollback ?? true,
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

    const kittyControlSequence = encodeKittyControlKey(kittyKeyboardMode, e);
    if (kittyControlSequence) {
      const id = ctx.sessionRef.current;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        ctx.onAutocompleteInput?.(kittyControlSequence);
        ctx.terminalBackend.writeToSession(id, kittyControlSequence);
        if (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current) {
          ctx.onBroadcastInputRef.current(kittyControlSequence, ctx.sessionId);
        }
        scrollToBottomAfterInput(kittyControlSequence);
        return false;
      }
    }

    // macOS Option+←/→ → Meta-b / Meta-f so the shell jumps by word (discussion
    // #826). After kitty mode so apps using the kitty protocol keep their own
    // arrow encoding; read live so the toggle applies without reconnecting.
    const wordJumpSequence = optionArrowWordJumpSequence(
      e,
      ctx.terminalSettingsRef.current?.optionArrowWordJump ?? false,
      isMacPlatform(),
    );
    if (wordJumpSequence) {
      const id = ctx.sessionRef.current;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        ctx.onAutocompleteInput?.(wordJumpSequence);
        ctx.terminalBackend.writeToSession(id, wordJumpSequence);
        if (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current) {
          ctx.onBroadcastInputRef.current(wordJumpSequence, ctx.sessionId);
        }
        scrollToBottomAfterInput(wordJumpSequence);
        return false;
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

  const writeLocalTerminalData = (nextData: string) => {
    ctx.onTerminalLogData?.(nextData);
    term.write(nextData);
  };

  term.onData((data) => {
    const id = ctx.sessionRef.current;
    let dataToWrite = data;
    let handledSubmittedInput = false;
    const onBroadcastInput = ctx.onBroadcastInputRef.current;
    const broadcastDataBeforeSudo = (data === "\x7f" && ctx.host.backspaceBehavior === "ctrl-h") ? "\x08" : data;
    const willBroadcastInput = !!id && shouldBroadcastTerminalUserInput(term, broadcastDataBeforeSudo, {
      isBroadcastEnabled: ctx.isBroadcastEnabledRef.current,
      hasBroadcastInputHandler: !!onBroadcastInput,
    });
    if (ctx.statusRef.current === "connected" && (data === "\r" || data === "\n")) {
      if (ctx.scriptRecorderRef?.current?.isRecording) {
        void ctx.scriptRecorderRef.current.recordEnter({
          sensitive: ctx.passwordPromptActiveRef?.current,
        });
        if (ctx.passwordPromptActiveRef) {
          ctx.passwordPromptActiveRef.current = false;
        }
      }
      const recordedCommand = recordTerminalCommandExecution(ctx.commandBufferRef.current, ctx, term);
      handledSubmittedInput = true;
      if (!willBroadcastInput) {
        prepareSudoAutofillInput(data, recordedCommand, ctx.sudoAutofillRef?.current);
      }
    } else if (ctx.statusRef.current === "connected" && !willBroadcastInput) {
      const pastedCommand = getSinglePastedCommand(data);
      if (pastedCommand) {
        const recordedCommand = recordTerminalCommandExecution(
          `${ctx.commandBufferRef.current}${pastedCommand.command}`,
          ctx,
          term,
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
      if (ctx.host.protocol === "serial" && ctx.serialLineMode && ctx.serialLineBufferRef) {
        handleSerialLineModeInput(dataToWrite, {
          bufferRef: ctx.serialLineBufferRef,
          localEcho: ctx.serialLocalEcho,
          writeToSession: (nextData) => {
            ctx.onOutputTriggerUserInputRef?.current?.(nextData);
            ctx.terminalBackend.writeToSession(id, nextData);
          },
          writeToTerminal: writeLocalTerminalData,
        });
      } else {
        // Character mode (default): send immediately
        // When backspaceBehavior is configured, remap the Backspace key output
        let outData = dataToWrite;
        if (dataToWrite === "\x7f" && ctx.host.backspaceBehavior === "ctrl-h") {
          outData = "\x08";
        }
        ctx.onOutputTriggerUserInputRef?.current?.(outData);
        ctx.terminalBackend.writeToSession(id, outData);

        // Local echo for serial connections only when explicitly enabled
        if (ctx.host.protocol === "serial" && ctx.serialLocalEcho) {
          if (dataToWrite === "\r") {
            writeLocalTerminalData("\r\n");
          } else if (dataToWrite === "\x7f" || dataToWrite === "\b") {
            writeLocalTerminalData("\b \b");
          } else if (dataToWrite === "\x03") {
            writeLocalTerminalData("^C");
          } else if (dataToWrite.charCodeAt(0) >= 32 || dataToWrite.length > 1) {
            writeLocalTerminalData(dataToWrite);
          }
        }
        if (ctx.host.protocol === "telnet" && ctx.telnetLocalEchoRef?.current) {
          const localEcho = formatTelnetLocalEcho(dataToWrite);
          if (localEcho) writeLocalTerminalData(localEcho);
        }
      }

      // Use remapped data so broadcast peers also receive the correct byte
      const broadcastData = (dataToWrite === "\x7f" && ctx.host.backspaceBehavior === "ctrl-h") ? "\x08" : data;
      if (willBroadcastInput) {
        onBroadcastInput?.(broadcastData, ctx.sessionId);
      }

      if (!shouldSuppressTerminalInputScrollForUserPaste(term, data)) {
        scrollToBottomAfterInput(data);
      }

      // Notify autocomplete of input
      ctx.onAutocompleteInput?.(data);

      if (ctx.statusRef.current === "connected") {
        if (handledSubmittedInput || data === "\r" || data === "\n") {
          // Command recording and sudo command preparation happen before the
          // input is written so sudo can receive a one-time prompt marker.
        } else if (data === "\x7f" || data === "\b") {
          ctx.commandBufferRef.current = ctx.commandBufferRef.current.slice(0, -1);
          ctx.scriptRecorderRef?.current?.recordBackspace();
        } else if (data === "\x03") {
          ctx.commandBufferRef.current = "";
          ctx.scriptRecorderRef?.current?.recordClearLine();
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
  });

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

  const kittyKeyboardDisposable = installKittyKeyboardProtocolHandlers(
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
          ctx.terminalBackend.writeToSession(sessionId, `\x1b]52;${target};${b64}\x07`);
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

  let resizeTimeout: NodeJS.Timeout | null = null;
  const resizeDebounceMs = XTERM_PERFORMANCE_CONFIG.resize.debounceMs;
  term.onResize(({ cols, rows }) => {
    // A reflow can leave stale glyphs in the WebGL atlas; clear it so the new
    // dimensions re-rasterize cleanly (issue #1049).
    clearWebglTextureAtlas();
    const id = ctx.sessionRef.current;
    if (!id) return;
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      ctx.terminalBackend.resizeSession(id, cols, rows);
      resizeTimeout = null;
    }, resizeDebounceMs);
  });

  const keywordHighlighter = new KeywordHighlighter(term);
  keywordHighlighter.setRules(keywordHighlightRules, keywordHighlightEnabled);

  return {
    term,
    fitAddon,
    serializeAddon,
    searchAddon,
    keywordHighlighter,
    clearTextureAtlas: clearWebglTextureAtlas,
    ensureWebglRenderer: loadWebglRenderer,
    suspendWebglRenderer,
    dispose: () => {
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
      eraseScrollbackDisposable.dispose();
      dec2026SyncStartDisposable.dispose();
      dec2026SyncEndDisposable.dispose();
      for (const disposable of cursorPositionReportRequestDisposables) {
        disposable.dispose();
      }
      kittyKeyboardDisposable.dispose();
      osc7Disposable.dispose();
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
      try {
        webglAddon?.dispose();
      } catch (err) {
        logger.warn("[XTerm] webglAddon dispose failed", err);
      }
    },
    get currentCwd() {
      return currentCwd;
    },
  };
};
