import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  checkAppShortcut,
  getAppLevelActions,
  getTerminalPassthroughActions,
} from "../../../application/state/useGlobalHotkeys";
import { TERMINAL_FONTS } from "../../../infrastructure/config/fonts";
import {
  XTERM_PERFORMANCE_CONFIG,
  type XTermPlatform,
  resolveXTermPerformanceConfig,
} from "../../../infrastructure/config/xtermPerformance";
import { logger } from "../../../lib/logger";
import type {
  Host,
  KeyBinding,
  TerminalSession,
  TerminalSettings,
  TerminalTheme,
} from "../../../types";

type TerminalBackendApi = {
  openExternalAvailable: () => boolean;
  openExternal: (url: string) => Promise<void>;
  writeToSession: (sessionId: string, data: string) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
};

export type XTermRuntime = {
  term: XTerm;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  searchAddon: SearchAddon;
  dispose: () => void;
};

export type CreateXTermRuntimeContext = {
  container: HTMLDivElement;
  host: Host;
  fontFamilyId: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  terminalSettingsRef: RefObject<TerminalSettings | undefined>;
  terminalBackend: TerminalBackendApi;
  sessionRef: RefObject<string | null>;

  hotkeySchemeRef: RefObject<"disabled" | "mac" | "pc">;
  keyBindingsRef: RefObject<KeyBinding[]>;
  onHotkeyActionRef: RefObject<
    ((action: string, event: KeyboardEvent) => void) | undefined
  >;

  isBroadcastEnabledRef: RefObject<boolean | undefined>;
  onBroadcastInputRef: RefObject<
    ((data: string, sourceSessionId: string) => void) | undefined
  >;

  sessionId: string;
  statusRef: RefObject<TerminalSession["status"]>;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  commandBufferRef: RefObject<string>;
  setIsSearchOpen: Dispatch<SetStateAction<boolean>>;
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

export const createXTermRuntime = (ctx: CreateXTermRuntimeContext): XTermRuntime => {
  const platform = detectPlatform();
  const deviceMemoryGb =
    typeof navigator !== "undefined" &&
    typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
      ? (navigator as { deviceMemory?: number }).deviceMemory
      : undefined;

  const performanceConfig = resolveXTermPerformanceConfig({
    platform,
    deviceMemoryGb,
  });

  const hostFontId = ctx.host.fontFamily || ctx.fontFamilyId || "menlo";
  const fontObj = TERMINAL_FONTS.find((f) => f.id === hostFontId) || TERMINAL_FONTS[0];
  const fontFamily = fontObj.family;

  const effectiveFontSize = ctx.host.fontSize || ctx.fontSize;

  const settings = ctx.terminalSettingsRef.current;
  const cursorStyle = settings?.cursorShape ?? "block";
  const cursorBlink = settings?.cursorBlink ?? true;
  const scrollback = settings?.scrollback ?? 10000;
  const fontLigatures = settings?.fontLigatures ?? true;
  const drawBoldTextInBrightColors = settings?.drawBoldInBrightColors ?? true;
  const fontWeight = settings?.fontWeight ?? 400;
  const fontWeightBold = settings?.fontWeightBold ?? 700;
  const lineHeight = 1 + (settings?.linePadding ?? 0) / 10;
  const minimumContrastRatio = settings?.minimumContrastRatio ?? 1;
  const scrollOnUserInput = settings?.scrollOnInput ?? true;
  const altIsMeta = settings?.altAsMeta ?? false;
  const wordSeparator = settings?.wordSeparators ?? " ()[]{}'\"";

  const term = new XTerm({
    ...performanceConfig.options,
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
    fontWeightBold: fontWeightBold as
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
    allowProposedApi: fontLigatures,
    drawBoldTextInBrightColors,
    minimumContrastRatio,
    scrollOnUserInput,
    altClickMovesCursor: !altIsMeta,
    wordSeparator,
    theme: {
      ...ctx.terminalTheme.colors,
      selectionBackground: ctx.terminalTheme.colors.selection,
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

  const logRenderer = (attempt = 0) => {
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
    logger.info(`[XTerm] renderer=${normalized}`);
    const scopedWindow = window as Window & { __xtermRenderer?: string };
    scopedWindow.__xtermRenderer = normalized;
    if (normalized === "unknown" && attempt < 3) {
      setTimeout(() => logRenderer(attempt + 1), 150);
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

  if (performanceConfig.useWebGLAddon) {
    try {
      webglAddon = (() => {
        const webglOptions: Record<string, unknown> = { useCustomGlyphHandler: true };
        try {
          const WebglCtor = WebglAddon as unknown as new (options?: unknown) => WebglAddon;
          return new WebglCtor(webglOptions);
        } catch {
          return new WebglAddon();
        }
      })();
      webglAddon.onContextLoss(() => {
        logger.warn("[XTerm] WebGL context loss detected, disposing addon");
        webglAddon?.dispose();
      });
      term.loadAddon(webglAddon);
      webglLoaded = true;
    } catch (webglErr) {
      logger.warn(
        "[XTerm] WebGL addon failed, using canvas renderer. Error:",
        webglErr instanceof Error ? webglErr.message : webglErr,
      );
    }
  } else {
    logger.info(
      "[XTerm] Skipping WebGL addon (canvas preferred for macOS profile or low-memory devices)",
    );
  }

  scopedWindow.__xtermWebGLLoaded = webglLoaded;
  scopedWindow.__xtermRendererPreference = performanceConfig.preferCanvasRenderer
    ? "canvas"
    : "webgl";

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
      window.open(uri, "_blank");
    }
  });
  term.loadAddon(webLinksAddon);

  logRenderer();

  const appLevelActions = getAppLevelActions();
  const terminalActions = getTerminalPassthroughActions();

  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") {
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "f" && e.type === "keydown") {
      e.preventDefault();
      ctx.setIsSearchOpen(true);
      return false;
    }

    const currentScheme = ctx.hotkeySchemeRef.current;
    const currentBindings = ctx.keyBindingsRef.current;
    const hotkeyCallback = ctx.onHotkeyActionRef.current;

    if (currentScheme === "disabled" || currentBindings.length === 0) {
      return true;
    }

    const isMac = currentScheme === "mac";
    const matched = checkAppShortcut(e, currentBindings, isMac);
    if (!matched) return true;

    const { action } = matched;

    if (appLevelActions.has(action)) {
      return true; // Let app-level handler process it
    }

    if (terminalActions.has(action)) {
      e.preventDefault();
      e.stopPropagation();
      if (import.meta.env.DEV) {
        console.log('[Hotkeys] Xterm terminal-level', {
          action,
          key: e.key,
          meta: e.metaKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
        });
      }
      switch (action) {
        case "copy": {
          const selection = term.getSelection();
          if (selection) navigator.clipboard.writeText(selection);
          break;
        }
        case "paste": {
          navigator.clipboard.readText().then((text) => {
            const id = ctx.sessionRef.current;
            if (id) ctx.terminalBackend.writeToSession(id, text);
          });
          break;
        }
        case "selectAll": {
          term.selectAll();
          break;
        }
        case "clearBuffer": {
          term.clear();
          break;
        }
        case "searchTerminal": {
          ctx.setIsSearchOpen(true);
          break;
        }
      }
      return false;
    }

    return true;
  });

  let cleanupMiddleClick: (() => void) | null = null;
  const middleClickPaste = settings?.middleClickPaste ?? true;
  if (middleClickPaste) {
    const handleMiddleClick = async (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text && ctx.sessionRef.current) {
          ctx.terminalBackend.writeToSession(ctx.sessionRef.current, text);
        }
      } catch (err) {
        logger.warn("[Terminal] Failed to paste from clipboard:", err);
      }
    };

    ctx.container.addEventListener("auxclick", handleMiddleClick);
    cleanupMiddleClick = () =>
      ctx.container.removeEventListener("auxclick", handleMiddleClick);
  }

  fitAddon.fit();
  term.focus();

  term.onData((data) => {
    const id = ctx.sessionRef.current;
    if (id) {
      ctx.terminalBackend.writeToSession(id, data);

      if (ctx.isBroadcastEnabledRef.current && ctx.onBroadcastInputRef.current) {
        ctx.onBroadcastInputRef.current(data, ctx.sessionId);
      }

      if (ctx.statusRef.current === "connected" && ctx.onCommandExecuted) {
        if (data === "\r" || data === "\n") {
          const cmd = ctx.commandBufferRef.current.trim();
          if (cmd) ctx.onCommandExecuted(cmd, ctx.host.id, ctx.host.label, ctx.sessionId);
          ctx.commandBufferRef.current = "";
        } else if (data === "\x7f" || data === "\b") {
          ctx.commandBufferRef.current = ctx.commandBufferRef.current.slice(0, -1);
        } else if (data === "\x03") {
          ctx.commandBufferRef.current = "";
        } else if (data === "\x15") {
          ctx.commandBufferRef.current = "";
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          ctx.commandBufferRef.current += data;
        } else if (data.length > 1 && !data.startsWith("\x1b")) {
          ctx.commandBufferRef.current += data;
        }
      }
    }
  });

  let resizeTimeout: NodeJS.Timeout | null = null;
  const resizeDebounceMs = XTERM_PERFORMANCE_CONFIG.resize.debounceMs;
  term.onResize(({ cols, rows }) => {
    const id = ctx.sessionRef.current;
    if (!id) return;
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      ctx.terminalBackend.resizeSession(id, cols, rows);
      resizeTimeout = null;
    }, resizeDebounceMs);
  });

  return {
    term,
    fitAddon,
    serializeAddon,
    searchAddon,
    dispose: () => {
      cleanupMiddleClick?.();
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
  };
};
