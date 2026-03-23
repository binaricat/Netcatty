/**
 * XTerm.js Performance Optimization Configuration
 * 
 * This file contains platform-specific optimizations for xterm performance.
 * macOS has different performance characteristics than Windows due to:
 * - Stricter GPU memory management
 * - Different rendering pipeline (Metal vs DirectX)
 * - Memory pressure handling
 */

export const XTERM_PERFORMANCE_CONFIG = {
  // Memory and Scrollback Settings
  scrollback: {
    // Windows can handle larger buffers efficiently
    default: 3000,
    // macOS performance degrades with large scrollbacks
    // due to more aggressive memory pressure
    macOS: 1000,
    // Mobile-like environments
    lowMemory: 500,
  },

  // Rendering optimizations
  rendering: {
    // Disable cursor blinking - reduces render calls significantly
    cursorBlink: false,

    // Allow transparency is expensive on macOS with Metal
    // Disabling it improves performance by 15-20%
    allowTransparency: false,

    // Custom glyphs: xterm.js draws box/block characters on canvas
    // instead of using font glyphs, eliminating gaps between cells
    customGlyphs: true,

    // Font rendering settings
    letterSpacing: 0,
    lineHeight: 1,
  },

  // WebGL-specific optimizations
  webgl: {
    // Enable WebGL by default for GPU acceleration
    enabled: true,

    // User can choose Canvas renderer on any platform
    preferCanvas: false,

    // Handle WebGL context loss gracefully
    enableContextLoss: true,
  },

  // Event handling optimizations
  events: {
    // Use document override for better event routing on macOS
    documentOverride: true,

    // Standard tab width (8 spaces)
    tabStopWidth: 8,

    // Let the SSH daemon handle EOL conversion
    convertEol: false,

    // Allow bracketed paste mode for better paste handling
    ignoreBracketedPasteMode: false,
  },

  // Logging (disable in production for performance)
  logging: {
    logLevel: 'off' as const, // 'off' | 'error' | 'warn' | 'info' | 'debug'
  },

  // Resize debouncing (macOS can get flooded with resize events)
  resize: {
    // Debounce delay in milliseconds
    // Higher values reduce CPU usage but may feel less responsive
    debounceMs: 50,

    // Use requestAnimationFrame for resize fitting
    useRAF: true,
  },

  // Performance monitoring thresholds
  monitoring: {
    // Log performance warning if render takes longer than this (ms)
    slowRenderThreshold: 16, // 60fps = 16.67ms per frame

    // Log warning if data buffer gets too large
    largeBufferThreshold: 1024 * 1024, // 1MB
  },

  // Keyword highlighting optimizations
  highlighting: {
    // Debounce time for viewport scanning (ms)
    // Higher values = better scrolling performance, but slower highlight "catch up"
    debounceMs: 200,
  },
};

export type XTermPlatform = "darwin" | "win32" | "linux";

type RendererType = "canvas" | "dom";
type LogLevel = "off" | "error" | "warn" | "info" | "debug";

export type ResolvedXTermPerformance = {
  options: {
    scrollback: number;
    cursorBlink: boolean;
    allowTransparency: boolean;
    customGlyphs: boolean;
    letterSpacing: number;
    lineHeight: number;
    documentOverride: boolean;
    tabStopWidth: number;
    convertEol: boolean;
    ignoreBracketedPasteMode: boolean;
    logLevel: LogLevel;
    rendererType?: RendererType;
  };
  useWebGLAddon: boolean;
  preferCanvasRenderer: boolean;
};

const isLowMemoryDevice = (deviceMemoryGb?: number) =>
  typeof deviceMemoryGb === "number" && deviceMemoryGb > 0 && deviceMemoryGb <= 4;

/**
 * Get platform-specific xterm configuration
 * @returns Configuration object optimized for the current platform
 */
export function getXTermConfig(platform: XTermPlatform = "darwin") {
  return resolveXTermPerformanceConfig({ platform }).options;
}

export type RendererPreference = "auto" | "webgl" | "canvas";

/**
 * Resolve a platform and hardware aware performance profile.
 * When rendererType is 'auto', uses Canvas on low-memory devices to avoid WebGL overhead.
 */
export function resolveXTermPerformanceConfig({
  platform = "darwin",
  deviceMemoryGb,
  rendererType = "auto",
}: {
  platform?: XTermPlatform;
  deviceMemoryGb?: number;
  rendererType?: RendererPreference;
} = {}): ResolvedXTermPerformance {
  const baseConfig = XTERM_PERFORMANCE_CONFIG;

  const lowMem = isLowMemoryDevice(deviceMemoryGb);

  // Determine if we should use Canvas renderer
  let resolvedPreferCanvas: boolean;
  if (rendererType === "canvas") {
    resolvedPreferCanvas = true;
  } else if (rendererType === "webgl") {
    resolvedPreferCanvas = false;
  } else {
    // Auto mode: use Canvas on low-memory devices
    resolvedPreferCanvas = baseConfig.webgl.preferCanvas || lowMem;
  }

  const scrollbackProfile = lowMem
    ? "lowMemory"
    : platform === "darwin"
      ? "macOS"
      : "default";

  const resolvedRendererType = resolvedPreferCanvas ? ("canvas" as const) : undefined;

  const baseOptions = {
    scrollback: baseConfig.scrollback[scrollbackProfile],
    cursorBlink: baseConfig.rendering.cursorBlink,
    allowTransparency: baseConfig.rendering.allowTransparency,
    customGlyphs: baseConfig.rendering.customGlyphs,
    letterSpacing: baseConfig.rendering.letterSpacing,
    lineHeight: baseConfig.rendering.lineHeight,
    documentOverride: baseConfig.events.documentOverride,
    tabStopWidth: baseConfig.events.tabStopWidth,
    convertEol: baseConfig.events.convertEol,
    ignoreBracketedPasteMode: baseConfig.events.ignoreBracketedPasteMode,
    logLevel: baseConfig.logging.logLevel,
  };

  const options = resolvedRendererType
    ? { ...baseOptions, rendererType: resolvedRendererType }
    : baseOptions;

  return {
    options,
    useWebGLAddon: baseConfig.webgl.enabled && !resolvedPreferCanvas,
    preferCanvasRenderer: resolvedPreferCanvas,
  };
}
