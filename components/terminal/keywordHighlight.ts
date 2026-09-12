import { SerializeAddon } from "@xterm/addon-serialize";
import type { IBufferLine, IDisposable, IMarker, Terminal as XTerm } from "@xterm/xterm";

import { isSafePluginDecorationPattern } from "../../domain/pluginTerminalProviders";
import { checkRegexSafetyPattern } from "../../lib/regexSafety";
import type { KeywordHighlightRule } from "../../types";
import { XTERM_PERFORMANCE_CONFIG } from "../../infrastructure/config/xtermPerformance";
import { isTerminalReplayWrite } from "./terminalReplay";
import { readPluginTerminalBufferText } from "./pluginTerminalBufferText";
import { compileRe2RangeMatcher, forEachNonEmptyRegexMatch } from "./keywordHighlightRegex";
import {
  isTerminalOutputInBackground,
  shouldDegradeTerminalKeywordHighlight,
} from "./runtime/terminalOutputPressure";

type RuntimeKeywordHighlightRule = KeywordHighlightRule & { readonly providerId?: string };

type CompiledPattern = {
  priority: number;
  rgb: number;
  plugin: boolean;
  visit(text: string, onMatch: (start: number, length: number) => boolean | void): void;
};

type HighlightMatch = {
  start: number;
  end: number;
  priority: number;
  rgb: number;
};

type InternalBufferLine = {
  length: number;
  isWrapped: boolean;
  _data: Uint32Array;
};

type LineOriginals = {
  fg: Uint32Array;
  content: Uint32Array;
  mask: Uint8Array;
  fingerprint: string;
};

type LogicalLine = {
  startY: number;
  endY: number;
  text: string;
  cellAtStringOffset: Array<{ y: number; x: number }>;
};

type AbsoluteRepaintRange = {
  rows: number[];
  mayTraverseRows: boolean;
};

export type KeywordHighlighterOptions = {
  shouldBypassHighlight?: () => boolean;
  serializeAddon?: SerializeAddon;
  canRebuild?: () => boolean;
  shouldPreserveScrollback?: () => boolean;
  onRestoringSelectionChange?: (restoring: boolean) => void;
  onDidRebuild?: () => void;
};

const CELL_INDICES = 3;
const CELL_CONTENT = 0;
const CELL_FG = 1;
const STYLE_MASK = 0xfc000000;
const CM_RGB = 0x3000000;
const MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS = 4_096;
const MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE = 256;
const RECOLOR_SLICE_LINES = 32;
const RECOLOR_SLICE_BUDGET_MS = 4;
const BULK_WRITE_LINE_BREAKS = 8;
const MAX_LOGICAL_LINE_ROWS = 128;

const withRgbFg = (originalFg: number, rgb: number): number => (
  (originalFg & STYLE_MASK) | CM_RGB | (rgb & 0xffffff)
);

const parseRgb = (color: string): number | null => {
  const normalized = color.trim();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(normalized);
  // Plugin decorations accept #RRGGBBAA; cell fg is 24-bit, so drop alpha.
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(normalized);
  const components = full
    ? full.slice(1)
    : short
      ? short.slice(1).map((component) => component.repeat(2))
      : null;
  if (!components) return null;
  return components.reduce((value, component) => (
    (value << 8) | Number.parseInt(component, 16)
  ), 0);
};

const compilePatterns = (
  rules: readonly RuntimeKeywordHighlightRule[],
  enabled: boolean,
): CompiledPattern[] => {
  if (!enabled) return [];
  const compiled: CompiledPattern[] = [];
  for (const [priority, rule] of rules.entries()) {
    if (!rule.enabled) continue;
    const rgb = parseRgb(rule.color);
    if (rgb === null) continue;
    for (const pattern of rule.patterns) {
      if (!pattern || checkRegexSafetyPattern(pattern).safe === false) continue;
      if (rule.providerId) {
        if (!isSafePluginDecorationPattern(pattern)) continue;
        try {
          const matcher = compileRe2RangeMatcher(pattern);
          compiled.push({
            priority,
            rgb,
            plugin: true,
            visit(text, onMatch) {
              matcher(text, onMatch);
            },
          });
        } catch {
          // Invalid plugin rules are ignored at the display boundary.
        }
        continue;
      }
      try {
        const regex = new RegExp(pattern, "gi");
        compiled.push({
          priority,
          rgb,
          plugin: false,
          visit(text, onMatch) {
            forEachNonEmptyRegexMatch(regex, text, (match) => onMatch(match.index, match[0].length));
          },
        });
      } catch {
        // Invalid user rules are ignored. The settings UI also rejects them.
      }
    }
  }
  return compiled;
};

const getInternalLine = (line: IBufferLine | undefined): InternalBufferLine | null => {
  if (!line) return null;
  const view = line as IBufferLine & { _line?: InternalBufferLine; _data?: Uint32Array };
  if (view._line?._data) return view._line;
  if (view._data) return view as InternalBufferLine;
  return null;
};

const collectMatches = (
  text: string,
  patterns: readonly CompiledPattern[],
): HighlightMatch[] => {
  const matches: HighlightMatch[] = [];
  let pluginMatchCount = 0;
  for (const pattern of patterns) {
    if (pattern.plugin && pluginMatchCount >= MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE) continue;
    const scanText = pattern.plugin ? text.slice(0, MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS) : text;
    pattern.visit(scanText, (start, length) => {
      if (length <= 0) return;
      matches.push({
        start,
        end: start + length,
        priority: pattern.priority,
        rgb: pattern.rgb,
      });
      if (!pattern.plugin) return;
      pluginMatchCount += 1;
      return pluginMatchCount < MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE;
    });
  }
  if (matches.length === 0) return matches;
  matches.sort((left, right) => (
    left.start - right.start
    || left.priority - right.priority
    || right.end - left.end
  ));
  const accepted: HighlightMatch[] = [];
  for (const match of matches) {
    if (accepted.length === 0 || match.start >= accepted[accepted.length - 1].end) {
      accepted.push(match);
    }
  }
  return accepted;
};

const yieldToRenderer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const trailingIncompleteCsi = (controls: string): string => {
  const escapeCsi = controls.lastIndexOf("\x1b[");
  const c1Csi = controls.lastIndexOf("\x9b");
  const csiStart = Math.max(escapeCsi, c1Csi);
  if (csiStart >= 0) {
    const suffix = controls.slice(csiStart);
    const body = suffix.startsWith("\x1b[") ? suffix.slice(2) : suffix.slice(1);
    if (!/[\x40-\x7e]/.test(body)) return suffix.slice(-32);
  }
  return controls.endsWith("\x1b") ? "\x1b" : "";
};

/**
 * Keyword highlighting mutates already-parsed cell foregrounds. Writes stay
 * pristine, so ordinary Enter/output never rebuilds history, and serialize can
 * restore the original colors without a second terminal.
 */
export class KeywordHighlighter implements IDisposable {
  readonly serializeAddon: SerializeAddon;
  rebuildCount = 0;
  lastRebuildTimings: Record<string, number> = {};

  private readonly originals = new WeakMap<InternalBufferLine, LineOriginals>();
  /** No-match rows only need a fingerprint; do not allocate cell snapshots. */
  private readonly fingerprints = new WeakMap<InternalBufferLine, string>();
  private readonly originalWrite: XTerm["write"];
  private readonly originalReset: XTerm["reset"];
  private readonly originalClear: XTerm["clear"];
  private readonly originalResize: XTerm["resize"];
  private readonly originalSerialize: SerializeAddon["serialize"];
  private readonly disposables: IDisposable[] = [];
  private rules: readonly RuntimeKeywordHighlightRule[] = [];
  private enabled = false;
  private compiledPatterns: CompiledPattern[] = [];
  private disposed = false;
  private catchUpFrom: number | null = null;
  private catchUpStartMarker: IMarker | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUpDueAt = 0;
  private catchUpPromise: Promise<void> = Promise.resolve();
  private resolveCatchUp: (() => void) | null = null;
  private catchUpCounted = false;
  private catchUpRunning = false;
  private catchUpGeneration = 0;
  private ruleGeneration = 0;
  private readonly coloredGeneration = new WeakMap<InternalBufferLine, number>();
  private lastViewportY = 0;
  private lastBaseY = 0;
  private hasOutput = false;
  private absoluteControlTail = "";
  private absoluteOriginControlTail = "";
  private absoluteOriginMode: boolean | null = false;
  private absoluteActiveBuffer: "normal" | "alternate" | null = "normal";
  private absoluteNormalSavedOriginMode: boolean | null = false;
  private absoluteAlternateSavedOriginMode: boolean | null = false;

  get pendingPristineBytes(): number {
    return 0;
  }

  get isPristineBackpressured(): boolean {
    return false;
  }

  constructor(
    private readonly term: XTerm,
    private readonly options: KeywordHighlighterOptions = {},
  ) {
    if (options.serializeAddon) {
      this.serializeAddon = options.serializeAddon;
    } else {
      this.serializeAddon = new SerializeAddon();
      term.loadAddon(this.serializeAddon);
    }
    this.originalSerialize = this.serializeAddon.serialize.bind(this.serializeAddon);
    this.serializeAddon.serialize = (serializeOptions) => {
      this.restoreBuffer();
      try {
        return this.originalSerialize(serializeOptions);
      } finally {
        if (!this.disposed && this.compiledPatterns.length > 0) {
          this.recolorVisible();
          this.markCatchUp(0);
          this.scheduleCatchUp();
        }
      }
    };
    this.originalWrite = term.write.bind(term);
    this.originalReset = term.reset.bind(term);
    this.originalClear = term.clear.bind(term);
    this.originalResize = term.resize.bind(term);
    (term as XTerm & { __netcattyKeywordHighlighter?: KeywordHighlighter })
      .__netcattyKeywordHighlighter = this;
    term.write = this.write;
    term.reset = this.reset;
    term.clear = this.clear;
    term.resize = this.resize;
    this.lastViewportY = term.buffer.active.viewportY;
    this.lastBaseY = term.buffer.active.baseY;
    this.disposables.push(
      term.onScroll(() => {
        if (!this.hasPendingCatchUp()) {
          this.rememberScrollPosition();
          return;
        }
        if (this.isOutputDrivenScroll()) return;
        this.recolorVisible();
      }),
      term.buffer.onBufferChange(() => {
        if (this.term.buffer.active.type !== "normal") return;
        if (this.hasPendingCatchUp()) this.scheduleCatchUp();
      }),
    );
  }

  setRules(rules: readonly RuntimeKeywordHighlightRule[], enabled: boolean): void {
    if (this.disposed) return;
    const nextRules = rules.map((rule) => ({ ...rule, patterns: [...rule.patterns] }));
    const nextSignature = JSON.stringify([enabled, nextRules]);
    const currentSignature = JSON.stringify([this.enabled, this.rules]);
    if (nextSignature === currentSignature) return;
    this.rules = nextRules;
    this.enabled = enabled;
    this.compiledPatterns = compilePatterns(this.rules, this.enabled);
    if (!this.hasOutput) return;
    if (this.catchUpTimer !== null) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.catchUpGeneration += 1;
    this.ruleGeneration += 1;
    this.catchUpCounted = true;
    this.rebuildCount += 1;
    const started = performance.now();
    this.recolorVisible();
    this.markCatchUp(0);
    if (!this.resolveCatchUp) {
      this.catchUpPromise = new Promise((resolve) => {
        this.resolveCatchUp = resolve;
      });
    }
    void this.runCatchUp();
    this.lastRebuildTimings = { total: performance.now() - started };
  }

  async whenSettled(): Promise<void> {
    while (!this.disposed) {
      if (this.term.buffer.active.type !== "normal") return;
      const catchUp = this.catchUpPromise;
      await catchUp;
      if (this.catchUpTimer === null && !this.catchUpRunning) return;
      if (this.term.buffer.active.type !== "normal") return;
      await yieldToRenderer();
    }
  }

  async prepareForSerialization(): Promise<void> {
    // serialize() restores originals itself. Do not wait for flood catch-up.
  }

  async waitForPristineBackpressure(): Promise<void> {}

  syncScrollback(): void {}

  mirrorViewportScroll(_lines: number): void {}

  mirrorScrollbackWipe(): void {}

  deferMutationDuringRebuild(_run: () => Promise<void> | void): boolean {
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.write = this.originalWrite;
    this.term.reset = this.originalReset;
    this.term.clear = this.originalClear;
    this.term.resize = this.originalResize;
    this.serializeAddon.serialize = this.originalSerialize;
    const patchedTerm = this.term as XTerm & { __netcattyKeywordHighlighter?: KeywordHighlighter };
    if (patchedTerm.__netcattyKeywordHighlighter === this) {
      delete patchedTerm.__netcattyKeywordHighlighter;
    }
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.resolveCatchUp?.();
    this.resolveCatchUp = null;
    this.catchUpStartMarker?.dispose();
    this.catchUpStartMarker = null;
    for (const disposable of this.disposables) disposable.dispose();
  }

  private readonly write: XTerm["write"] = (data, callback) => {
    if (this.disposed) return this.originalWrite(data, callback);
    const originModeNeedsSafety = this.trackAbsoluteOriginMode(data);
    const absoluteControls = this.collectAbsoluteControls(data);
    const startedOnNormal = this.term.buffer.active.type === "normal";
    if (!startedOnNormal && this.compiledPatterns.length === 0 && !this.hasPendingCatchUp()) {
      return this.originalWrite(data, callback);
    }
    this.hasOutput = startedOnNormal || this.hasOutput;
    if (this.compiledPatterns.length === 0 && !this.hasPendingCatchUp() && startedOnNormal) {
      return this.originalWrite(data, callback);
    }
    const startBaseY = this.term.buffer.active.baseY;
    const startY = startBaseY + this.term.buffer.active.cursorY;
    const absoluteRepaintRange = absoluteControls !== null
      ? this.resolveAbsoluteRepaintRange(absoluteControls, originModeNeedsSafety)
      : null;
    const bypass = !startedOnNormal || this.shouldBypassWrite(data);
    // Freeze in-frame eligibility at entry: the pressure window is a rolling
    // sample, and by the time this write's callback runs (xterm parses in a
    // macrotask while backlogged) later chunks may have aged it below the
    // threshold. Re-checking inside the callback would let a write that took
    // the flood path repaint the viewport anyway, defeating the deferred path.
    // Pane visibility is the exception: it can flip while this write is still
    // in flight (pane/page shown between entry and callback), so it is
    // re-evaluated live in the callback below instead of frozen here.
    const colorDuringBypass = bypass && this.mayColorViewportDuringBypass(data);
    if (bypass) {
      if (startedOnNormal && (this.enabled || this.compiledPatterns.length > 0 || this.hasPendingCatchUp())) {
        this.markCatchUp(absoluteRepaintRange === null ? startY : Math.min(startY, startBaseY));
        this.scheduleCatchUp();
      }
      return this.originalWrite(data, () => {
        // Bulk writes skip per-write coloring so xterm can keep painting the
        // flood, but the viewport itself must not sit uncolored until the
        // catch-up timer fires (#3271). Recolor the visible rows here, inside
        // the write callback: xterm parses in a macrotask and renders in the
        // next rAF, so these colors land in the same frame as the text. The
        // cost is O(viewport rows × rules), independent of chunk size, and
        // true rate/long-line floods keep the fully deferred path. Rows that
        // scrolled past the viewport stay with the deferred catch-up.
        if (
          this.term.buffer.active.type === "normal"
          && this.compiledPatterns.length > 0
          && colorDuringBypass
          // Visibility may have changed since this write started (hidden pane
          // shown before the async xterm parse finished): the entry snapshot
          // only froze the flood/rate decision, so check the live state here.
          && !isTerminalOutputInBackground(this.term)
          // Appended logs should not add another repaint while reading history.
          // Scroll/reveal handlers retain their existing recoloring behavior.
          && this.term.buffer.active.viewportY === this.term.buffer.active.baseY
        ) {
          this.recolorVisible();
        }
        if (this.term.buffer.active.type === "normal" && !startedOnNormal) {
          if (this.enabled || this.compiledPatterns.length > 0) {
            this.markCatchUp(0);
            this.scheduleCatchUp();
          }
        }
        callback?.();
      });
    }
    // In-place CR / backspace / EL / ICH / DCH rewrite the current row.
    // `\r\n` is a line advance and must not restore/repaint the previous prompt.
    const startsWithLineAdvance = typeof data === "string" && /^(?:\r\n|\n)/.test(data);
    // CUU / CPL / CUP / VPA / DECSTBM (homes the cursor) / restore-cursor /
    // RI / DECRC can move back onto rows the leading newline already left
    // (multi-line progress redraws). Controls this heuristic misses are caught
    // by the start-row fingerprint safety net below.
    const movesCursorUp = typeof data === "string"
      && (/\x1b(?:\[[\d;]*[AFHfudr]|M|8)/.test(data)); // eslint-disable-line no-control-regex
    const eraseInLine = typeof data === "string" && /\x1b\[[\d;]*[K@PMLGHf]/.test(data); // eslint-disable-line no-control-regex
    // A chunk that starts with a line advance leaves the cursor row before any
    // later CR/EL can touch it (bash's bracketed-paste `\x1b[?2004l\r` arrives
    // fused with the echoed newline). Restoring startY here would strip the
    // previous prompt's highlight while the post-write repaint skips that row.
    // Chunks that can climb back up keep the restore and repaint startY below.
    const rewritesCurrentLine = typeof data === "string"
      && (!startsWithLineAdvance || movesCursorUp)
      && (/\r(?!\n)/.test(data) || data.includes("\x08") || eraseInLine);
    if (this.compiledPatterns.length > 0 && rewritesCurrentLine) {
      this.restorePhysicalLine(startY);
    }
    const skipStartRow = startsWithLineAdvance && !movesCursorUp;
    // Safety net for controls the backtracking heuristic does not enumerate
    // (DECOM, DECCOLM, ...): if the skipped start row's text changed during
    // the write, something climbed back onto it and it must be repainted.
    const startRowTextBefore = skipStartRow
      ? this.term.buffer.active.getLine(startY)?.translateToString(false)
      : undefined;
    const writeMarker = this.term.registerMarker(0);
    return this.originalWrite(data, () => {
      const active = this.term.buffer.active;
      if (active.type === "normal") {
        const endY = active.baseY + active.cursorY;
        if (!writeMarker || writeMarker.isDisposed) {
          if (this.enabled || this.compiledPatterns.length > 0) {
            this.markCatchUp(0);
            this.scheduleCatchUp();
          }
        } else {
          const startRowMutated = startRowTextBefore !== undefined
            && active.getLine(writeMarker.line)?.translateToString(false) !== startRowTextBefore;
          const ordinaryFromY = skipStartRow && !startRowMutated
            ? Math.min(endY, writeMarker.line + 1)
            : writeMarker.line;
          if (
            absoluteRepaintRange !== null
            && !absoluteRepaintRange.mayTraverseRows
            && active.baseY === startBaseY
          ) {
            // A normal Mosh framebuffer diff sends one absolute row update per
            // write. Recolor the old cursor row and the addressed rows as
            // separate ranges so N row-sized writes stay O(N), rather than
            // rescanning the gaps between them for every write.
            const repaintRanges = absoluteRepaintRange.rows.map((row) => ({
              start: startBaseY + row,
              end: startBaseY + row,
            }));
            const includesLine = (line: number) => repaintRanges.some((range) => (
              line >= range.start && line <= range.end
            ));
            if (!includesLine(ordinaryFromY)) {
              repaintRanges.push({ start: ordinaryFromY, end: ordinaryFromY });
            }
            if (!includesLine(endY) && endY !== ordinaryFromY) {
              repaintRanges.push({ start: endY, end: endY });
            }
            repaintRanges.sort((left, right) => left.start - right.start);
            for (let index = repaintRanges.length - 1; index > 0; index -= 1) {
              const previous = repaintRanges[index - 1];
              const current = repaintRanges[index];
              if (current.start > previous.end + 1) continue;
              previous.end = Math.max(previous.end, current.end);
              repaintRanges.splice(index, 1);
            }
            if (this.compiledPatterns.length === 0) {
              const catchUpFrom = repaintRanges.reduce<number | null>((earliest, range) => (
                this.hasStoredOriginalsInRange(range.start, range.end)
                  ? Math.min(earliest ?? range.start, range.start)
                  : earliest
              ), null);
              if (catchUpFrom !== null) {
                this.markCatchUp(catchUpFrom);
                this.scheduleCatchUp();
              }
            } else {
              for (const range of repaintRanges) {
                this.recolorRange(range.start, range.end, true, true);
              }
            }
          } else {
            // An absolute-positioned update that also traverses rows via
            // CRLF/IND can scroll before restoring its final cursor. Cover the
            // pre-write and post-write viewports for that uncommon case.
            const fromY = absoluteRepaintRange === null
              ? ordinaryFromY
              : Math.min(ordinaryFromY, startBaseY, active.baseY);
            const toY = absoluteRepaintRange === null
              ? endY
              : Math.max(
                ordinaryFromY,
                endY,
                startBaseY + this.term.rows - 1,
                active.baseY + this.term.rows - 1,
              );
            if (this.compiledPatterns.length === 0) {
              if (this.hasStoredOriginalsInRange(fromY, toY)) {
                this.markCatchUp(fromY);
                this.scheduleCatchUp();
              }
            } else {
              this.recolorRange(fromY, toY, true, true);
            }
          }
        }
      } else if (startedOnNormal && (this.enabled || this.compiledPatterns.length > 0)) {
        this.markCatchUp(writeMarker && !writeMarker.isDisposed ? writeMarker.line : 0);
        this.scheduleCatchUp();
      }
      writeMarker?.dispose();
      callback?.();
    });
  };

  private trackAbsoluteOriginMode(data: string | Uint8Array): boolean {
    if (typeof data !== "string") {
      this.absoluteOriginControlTail = "";
      this.absoluteOriginMode = null;
      this.absoluteActiveBuffer = null;
      this.absoluteNormalSavedOriginMode = null;
      this.absoluteAlternateSavedOriginMode = null;
      return true;
    }
    const controls = this.absoluteOriginControlTail + data;
    this.absoluteOriginControlTail = trailingIncompleteCsi(controls);
    const saveOriginMode = () => {
      if (this.absoluteActiveBuffer === "normal") {
        this.absoluteNormalSavedOriginMode = this.absoluteOriginMode;
      } else if (this.absoluteActiveBuffer === "alternate") {
        this.absoluteAlternateSavedOriginMode = this.absoluteOriginMode;
      } else {
        this.absoluteNormalSavedOriginMode = null;
        this.absoluteAlternateSavedOriginMode = null;
      }
    };
    const restoreOriginMode = () => {
      this.absoluteOriginMode = this.absoluteActiveBuffer === "normal"
        ? this.absoluteNormalSavedOriginMode
        : this.absoluteActiveBuffer === "alternate"
          ? this.absoluteAlternateSavedOriginMode
          : null;
    };
    const originModeControls = [
      ...controls.matchAll(
        /\x1bc|\x1b[78]|(?:\x1b\[|\x9b)(?:!p|[\d;]*[su]|\?[\d;]*[hl])/g, // eslint-disable-line no-control-regex
      ),
    ];
    let originModeNeedsSafety = this.absoluteOriginMode !== false;
    for (const match of originModeControls) {
      const control = match[0];
      if (control === "\x1bc") {
        this.absoluteOriginMode = false;
        this.absoluteActiveBuffer = "normal";
        this.absoluteNormalSavedOriginMode = false;
        this.absoluteAlternateSavedOriginMode = false;
      } else if (control === "\x1b[!p" || control === "\x9b!p") {
        this.absoluteOriginMode = false;
      } else if (control === "\x1b7" || control.endsWith("s")) {
        saveOriginMode();
      } else if (control === "\x1b8" || control.endsWith("u")) {
        restoreOriginMode();
      } else {
        const parameters = /^(?:\x1b\[|\x9b)\?([\d;]*)[hl]$/.exec(control)?.[1] // eslint-disable-line no-control-regex
          ?.split(";")
          .map((parameter) => Number.parseInt(parameter, 10))
          ?? [];
        const enabled = control.endsWith("h");
        for (const parameter of parameters) {
          if (parameter === 6) {
            this.absoluteOriginMode = enabled;
          } else if (parameter === 1048) {
            if (enabled) saveOriginMode();
            else restoreOriginMode();
          } else if (parameter === 1049) {
            if (enabled) {
              saveOriginMode();
              this.absoluteActiveBuffer = "alternate";
            } else {
              this.absoluteActiveBuffer = "normal";
              restoreOriginMode();
            }
          } else if (parameter === 47 || parameter === 1047) {
            this.absoluteActiveBuffer = enabled ? "alternate" : "normal";
          }
        }
      }
      originModeNeedsSafety ||= this.absoluteOriginMode !== false;
    }
    return originModeNeedsSafety;
  }

  private collectAbsoluteControls(data: string | Uint8Array): string | null {
    if (typeof data !== "string") {
      this.absoluteControlTail = "";
      return null;
    }
    const controls = this.absoluteControlTail + data;
    this.absoluteControlTail = trailingIncompleteCsi(controls);
    return controls;
  }

  private resolveAbsoluteRepaintRange(
    controls: string,
    originModeNeedsSafety: boolean,
  ): AbsoluteRepaintRange | null {
    const rows = new Set<number>();
    const noteRow = (raw: string | undefined) => {
      const row = Math.min(
        this.term.rows - 1,
        Math.max(0, (Number.parseInt(raw || "1", 10) || 1) - 1),
      );
      rows.add(row);
    };
    // CUP/HVP and VPA address a viewport row directly. Mosh's framebuffer
    // diff uses these controls to repaint rows above the current cursor once
    // the remote screen fills, without emitting a newline or changing buffer.
    const cup = /(?:\x1b\[|\x9b)(\d*)(?:;\d*)?[Hf]/g; // eslint-disable-line no-control-regex
    const vpa = /(?:\x1b\[|\x9b)(\d*)d/g; // eslint-disable-line no-control-regex
    for (const match of controls.matchAll(cup)) noteRow(match[1]);
    for (const match of controls.matchAll(vpa)) noteRow(match[1]);
    // These controls can visit rows that are not named by CUP/VPA. Keep the
    // wider safety range only for writes that actually contain such movement.
    const mayTraverseRows = originModeNeedsSafety
      || /[\n\v\f\x84\x85\x8d]|\x1b[DEM8]|(?:\x1b\[|\x9b)[\d;?]*[ABEFIJLMSTehlru]/.test(controls); // eslint-disable-line no-control-regex
    return rows.size === 0
      ? null
      : { rows: [...rows].sort((left, right) => left - right), mayTraverseRows };
  }

  private readonly reset: XTerm["reset"] = () => {
    this.clearStoredOriginals();
    this.cancelCatchUp();
    this.hasOutput = false;
    this.absoluteControlTail = "";
    this.absoluteOriginControlTail = "";
    this.absoluteOriginMode = false;
    this.absoluteActiveBuffer = "normal";
    this.absoluteNormalSavedOriginMode = false;
    this.absoluteAlternateSavedOriginMode = false;
    return this.originalReset();
  };

  private readonly clear: XTerm["clear"] = () => {
    this.restoreBuffer();
    this.clearStoredOriginals();
    this.cancelCatchUp();
    const result = this.originalClear();
    if (this.compiledPatterns.length > 0) {
      this.recolorVisible();
    }
    return result;
  };

  private readonly resize: XTerm["resize"] = (cols, rows) => {
    this.restoreBuffer();
    const result = this.originalResize(cols, rows);
    this.ruleGeneration += 1;
    if (this.compiledPatterns.length > 0) {
      this.recolorVisible();
      this.markCatchUp(0);
      this.scheduleCatchUp();
    }
    return result;
  };

  private shouldBypassWrite(data: string | Uint8Array): boolean {
    if (this.options.shouldBypassHighlight?.()) return true;
    if (typeof data !== "string") return true;
    if (shouldDegradeTerminalKeywordHighlight(this.term, data)) return true;
    return this.countNewlines(data) >= BULK_WRITE_LINE_BREAKS;
  }

  /**
   * Streaming logs usually trip only the bulk line-break heuristic (coalesced
   * PTY ticks), which is cheap to color in-frame: rematching the visible
   * viewport costs O(viewport rows × rules) per write, independent of chunk
   * size. Rate/long-line floods and explicit full-bypass requests keep the
   * deferred catch-up so xterm keeps painting the dump smoothly.
   *
   * This is the frozen flood/rate decision only: pane visibility is evaluated
   * live in the write callback (`isTerminalOutputInBackground`) because it can
   * flip between write entry and the asynchronous callback.
   */
  private mayColorViewportDuringBypass(data: string | Uint8Array): boolean {
    if (this.options.shouldBypassHighlight?.()) return false;
    if (typeof data !== "string" || isTerminalReplayWrite(this.term)) return false;
    return !shouldDegradeTerminalKeywordHighlight(this.term, data);
  }

  private countNewlines(data: string): number {
    let count = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data.charCodeAt(index) !== 10) continue;
      count += 1;
    }
    return count;
  }

  private rememberScrollPosition(): void {
    const buffer = this.term.buffer.active;
    this.lastViewportY = buffer.viewportY;
    this.lastBaseY = buffer.baseY;
  }

  private isOutputDrivenScroll(): boolean {
    const buffer = this.term.buffer.active;
    const viewportY = buffer.viewportY;
    const baseY = buffer.baseY;
    // Full scrollback keeps baseY/viewportY pinned while rows recycle. That is
    // still output-driven and must not rematch the visible area on every write.
    const pinnedToBottom = viewportY === baseY;
    const followedOutput = pinnedToBottom || (
      baseY !== this.lastBaseY
      && viewportY - this.lastViewportY === baseY - this.lastBaseY
    );
    this.lastViewportY = viewportY;
    this.lastBaseY = baseY;
    return followedOutput;
  }

  private hasPendingCatchUp(): boolean {
    return this.catchUpFrom !== null || this.catchUpStartMarker !== null
      || this.catchUpTimer !== null || this.catchUpRunning;
  }

  private resolveCatchUpY(): number | null {
    if (this.catchUpStartMarker) {
      if (!this.catchUpStartMarker.isDisposed) {
        return Math.max(0, this.catchUpStartMarker.line);
      }
      // Trimmed away: the pending range is the whole remaining buffer.
      this.catchUpStartMarker = null;
      this.catchUpFrom = 0;
      return 0;
    }
    return this.catchUpFrom;
  }

  private replaceCatchUpMarker(absoluteY: number | null): void {
    this.catchUpStartMarker?.dispose();
    this.catchUpStartMarker = null;
    if (absoluteY === null) return;
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const cursor = buffer.baseY + buffer.cursorY;
    this.catchUpStartMarker = this.term.registerMarker(absoluteY - cursor);
  }

  private markCatchUp(fromY: number): void {
    const current = this.resolveCatchUpY();
    const next = current === null ? fromY : Math.min(current, fromY);
    this.catchUpFrom = next;
    // Already covers this write. After trim, numeric 0 is enough — do not
    // registerMarker on every subsequent flood chunk.
    if (current !== null && current <= fromY) return;
    this.replaceCatchUpMarker(next);
  }

  private scheduleCatchUp(): void {
    if (this.disposed || this.resolveCatchUpY() === null) return;
    if (!this.resolveCatchUp) {
      this.catchUpPromise = new Promise((resolve) => {
        this.resolveCatchUp = resolve;
      });
    }
    const quietMs = XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs ?? 480;
    this.catchUpDueAt = performance.now() + quietMs;
    if (this.catchUpTimer !== null) return;
    const arm = (): void => {
      const wait = Math.max(1, this.catchUpDueAt - performance.now());
      this.catchUpTimer = setTimeout(() => {
        this.catchUpTimer = null;
        if (this.disposed) return;
        if (performance.now() < this.catchUpDueAt) {
          arm();
          return;
        }
        void this.runCatchUp();
      }, wait);
    };
    arm();
  }

  private cancelCatchUp(): void {
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.catchUpDueAt = 0;
    this.catchUpFrom = null;
    this.catchUpStartMarker?.dispose();
    this.catchUpStartMarker = null;
    this.catchUpCounted = false;
    this.catchUpGeneration += 1;
    this.resolveCatchUp?.();
    this.resolveCatchUp = null;
  }

  private async runCatchUp(): Promise<void> {
    if (this.disposed || this.resolveCatchUpY() === null || this.catchUpRunning) return;
    const generation = this.catchUpGeneration;
    this.catchUpRunning = true;
    if (!this.catchUpCounted) {
      this.rebuildCount += 1;
      this.catchUpCounted = true;
    }
    const started = performance.now();
    let pausedOnAlternate = false;
    try {
      let nextY = Math.max(0, this.resolveCatchUpY() ?? 0);
      let turnStarted = performance.now();
      while (!this.disposed && generation === this.catchUpGeneration) {
        const buffer = this.term.buffer.active;
        if (buffer.type !== "normal") {
          pausedOnAlternate = true;
          break;
        }
        if (nextY >= buffer.length) {
          this.catchUpFrom = null;
          this.replaceCatchUpMarker(null);
          break;
        }
        const sliceEnd = Math.min(buffer.length - 1, nextY + RECOLOR_SLICE_LINES - 1);
        this.recolorRange(nextY, sliceEnd, false, false);
        nextY = sliceEnd + 1;
        if (nextY >= buffer.length) {
          this.catchUpFrom = null;
          this.replaceCatchUpMarker(null);
          break;
        }
        this.catchUpFrom = nextY;
        if (performance.now() - turnStarted >= RECOLOR_SLICE_BUDGET_MS) {
          this.replaceCatchUpMarker(nextY);
          await yieldToRenderer();
          turnStarted = performance.now();
          nextY = Math.max(0, this.resolveCatchUpY() ?? nextY);
        }
      }
    } finally {
      this.catchUpRunning = false;
      this.lastRebuildTimings = { total: performance.now() - started };
      if (this.disposed) {
        this.resolveCatchUp?.();
        this.resolveCatchUp = null;
      } else if (this.resolveCatchUpY() === null) {
        this.catchUpCounted = false;
        this.recolorVisible();
        this.resolveCatchUp?.();
        this.resolveCatchUp = null;
      } else if (pausedOnAlternate) {
        this.resolveCatchUp?.();
        this.resolveCatchUp = null;
      } else if (generation === this.catchUpGeneration) {
        this.scheduleCatchUp();
      } else {
        void this.runCatchUp();
      }
    }
  }

  private recolorVisible(): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length - 1, start + this.term.rows - 1);
    this.recolorRange(start, end, true, false);
  }

  private recolorRange(startY: number, endY: number, refresh: boolean, force: boolean): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const first = Math.max(0, Math.min(startY, endY));
    const last = Math.min(buffer.length - 1, Math.max(startY, endY));
    if (last < first) return;
    let y = first;
    for (let walked = 0; y > 0 && buffer.getLine(y)?.isWrapped && walked < MAX_LOGICAL_LINE_ROWS; walked += 1) {
      y -= 1;
    }
    let paintedStart = Number.POSITIVE_INFINITY;
    let paintedEnd = -1;
    while (y <= last) {
      const bounds = this.logicalLineBounds(y);
      if (!bounds) {
        y += 1;
        continue;
      }
      this.recolorLogicalBounds(bounds.startY, bounds.endY, force);
      paintedStart = Math.min(paintedStart, bounds.startY);
      paintedEnd = Math.max(paintedEnd, bounds.endY);
      y = bounds.endY + 1;
    }
    if (refresh && paintedEnd >= paintedStart) this.refreshAbsolute(paintedStart, paintedEnd);
  }

  private logicalLineBounds(startY: number): { startY: number; endY: number } | null {
    const buffer = this.term.buffer.active;
    if (!buffer.getLine(startY)) return null;
    let first = startY;
    let last = startY;
    while (
      last + 1 < buffer.length
      && buffer.getLine(last + 1)?.isWrapped
      && last - first + 1 < MAX_LOGICAL_LINE_ROWS
    ) {
      last += 1;
    }
    return { startY: first, endY: last };
  }

  private readLogicalLineText(startY: number, endY: number): string {
    const buffer = this.term.buffer.active;
    let text = "";
    for (let y = startY; y <= endY; y += 1) {
      text += buffer.getLine(y)?.translateToString(y === endY) ?? "";
    }
    return text;
  }

  private recolorLogicalBounds(startY: number, endY: number, force: boolean): void {
    if (!force && this.logicalLineIsCurrent(startY, endY)) return;
    for (let y = startY; y <= endY; y += 1) this.restorePhysicalLine(y);
    if (this.compiledPatterns.length === 0) {
      this.stampLogicalLine(startY, endY);
      return;
    }
    if (collectMatches(this.readLogicalLineText(startY, endY), this.compiledPatterns).length === 0) {
      this.stampLogicalLine(startY, endY);
      return;
    }
    const logical = this.readLogicalLine(startY, endY);
    if (!logical) return;
    const matches = collectMatches(logical.text, this.compiledPatterns);
    for (const match of matches) {
      const startCell = logical.cellAtStringOffset[match.start];
      const lastCell = match.end > match.start
        ? logical.cellAtStringOffset[match.end - 1]
        : startCell;
      if (!startCell || !lastCell) continue;
      // Exclusive string ends can land mid-grapheme and map to the same cell.
      // Color that cell instead of building an empty [x, x) range.
      if (startCell.y === lastCell.y) {
        this.colorPhysicalRange(startCell.y, startCell.x, lastCell.x + 1, match.rgb);
        continue;
      }
      const startLine = this.term.buffer.active.getLine(startCell.y);
      this.colorPhysicalRange(startCell.y, startCell.x, startLine?.length ?? startCell.x + 1, match.rgb);
      for (let y = startCell.y + 1; y < lastCell.y; y += 1) {
        const line = this.term.buffer.active.getLine(y);
        if (line) this.colorPhysicalRange(y, 0, line.length, match.rgb);
      }
      this.colorPhysicalRange(lastCell.y, 0, lastCell.x + 1, match.rgb);
    }
    this.stampLogicalLine(startY, endY);
  }

  private logicalLineIsCurrent(startY: number, endY: number): boolean {
    const buffer = this.term.buffer.active;
    for (let y = startY; y <= endY; y += 1) {
      const publicLine = buffer.getLine(y);
      const internal = getInternalLine(publicLine);
      if (!internal || this.coloredGeneration.get(internal) !== this.ruleGeneration) {
        return false;
      }
      const originals = this.originals.get(internal);
      const fingerprint = publicLine?.translateToString(false) ?? "";
      const stamped = originals ? originals.fingerprint : this.fingerprints.get(internal);
      // An empty/no-match stamp must not survive when the row is later filled
      // or recycled with the same BufferLine identity (yes/log floods).
      if (stamped === undefined || stamped !== fingerprint) return false;
      if (originals && !this.lineStillHasAppliedHighlights(internal, originals)) return false;
    }
    return true;
  }

  private lineStillHasAppliedHighlights(
    line: InternalBufferLine,
    originals: LineOriginals,
  ): boolean {
    for (let x = 0; x < line.length; x += 1) {
      if (!originals.mask[x]) continue;
      if (line._data[x * CELL_INDICES + CELL_FG] === originals.fg[x]) return false;
    }
    return true;
  }

  private stampLogicalLine(startY: number, endY: number): void {
    const buffer = this.term.buffer.active;
    for (let y = startY; y <= endY; y += 1) {
      const publicLine = buffer.getLine(y);
      const internal = getInternalLine(publicLine);
      if (!internal) continue;
      this.coloredGeneration.set(internal, this.ruleGeneration);
      const fingerprint = publicLine?.translateToString(false) ?? "";
      const originals = this.originals.get(internal);
      if (originals) originals.fingerprint = fingerprint;
      else this.fingerprints.set(internal, fingerprint);
    }
  }

  private colorPhysicalRange(y: number, startX: number, endX: number, rgb: number): void {
    const internal = getInternalLine(this.term.buffer.active.getLine(y));
    if (!internal || endX <= startX) return;
    const originals = this.ensureOriginals(internal);
    const last = Math.min(internal.length, endX);
    for (let x = Math.max(0, startX); x < last; x += 1) {
      const dataIndex = x * CELL_INDICES;
      const content = internal._data[dataIndex + CELL_CONTENT];
      const currentFg = internal._data[dataIndex + CELL_FG];
      if (!originals.mask[x] || originals.content[x] !== content) {
        originals.fg[x] = currentFg;
        originals.content[x] = content;
        originals.mask[x] = 1;
      }
      internal._data[dataIndex + CELL_FG] = withRgbFg(originals.fg[x], rgb);
    }
    const publicLine = this.term.buffer.active.getLine(y);
    if (publicLine) originals.fingerprint = publicLine.translateToString(false);
  }

  private restorePhysicalLine(y: number, buffer = this.term.buffer.active): void {
    const publicLine = buffer.getLine(y);
    const internal = getInternalLine(publicLine);
    if (!internal) return;
    const originals = this.originals.get(internal);
    if (!originals) return;
    this.coloredGeneration.delete(internal);
    for (let x = 0; x < internal.length; x += 1) {
      if (!originals.mask[x]) continue;
      const dataIndex = x * CELL_INDICES;
      const content = internal._data[dataIndex + CELL_CONTENT];
      if (originals.content[x] !== content) {
        originals.mask[x] = 0;
        continue;
      }
      internal._data[dataIndex + CELL_FG] = originals.fg[x];
      originals.mask[x] = 0;
    }
  }

  private restoreBuffer(): void {
    const buffer = this.term.buffer.normal;
    for (let y = 0; y < buffer.length; y += 1) this.restorePhysicalLine(y, buffer);
  }

  private ensureOriginals(line: InternalBufferLine): LineOriginals {
    let originals = this.originals.get(line);
    if (!originals || originals.fg.length < line.length) {
      originals = {
        fg: new Uint32Array(line.length),
        content: new Uint32Array(line.length),
        mask: new Uint8Array(line.length),
        fingerprint: this.fingerprints.get(line) ?? originals?.fingerprint ?? "",
      };
      this.originals.set(line, originals);
      this.fingerprints.delete(line);
    }
    return originals;
  }

  private hasStoredOriginalsInRange(startY: number, endY: number): boolean {
    const buffer = this.term.buffer.active;
    const last = Math.min(buffer.length - 1, Math.max(startY, endY));
    for (let y = Math.max(0, Math.min(startY, endY)); y <= last; y += 1) {
      const internal = getInternalLine(buffer.getLine(y));
      if (internal && this.originals.get(internal)) return true;
    }
    return false;
  }

  private clearStoredOriginals(): void {
    const buffer = this.term.buffer.normal;
    for (let y = 0; y < buffer.length; y += 1) {
      const internal = getInternalLine(buffer.getLine(y));
      if (internal) {
        this.originals.delete(internal);
        this.fingerprints.delete(internal);
      }
    }
  }

  private readLogicalLine(startY: number, endY = startY): LogicalLine | null {
    const buffer = this.term.buffer.active;
    if (!buffer.getLine(startY)) return null;
    const first = startY;
    const last = endY;
    let text = "";
    const cellAtStringOffset: Array<{ y: number; x: number }> = [];
    for (let y = first; y <= last; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const mapped = readPluginTerminalBufferText(line, y === last);
      const base = text.length;
      text += mapped.text;
      for (let offset = 0; offset < mapped.text.length; offset += 1) {
        cellAtStringOffset[base + offset] = { y, x: mapped.cellAtStringOffset[offset] ?? offset };
      }
      cellAtStringOffset[text.length] = {
        y,
        x: mapped.cellAtStringOffset[mapped.text.length] ?? line.length,
      };
    }
    return { startY: first, endY: last, text, cellAtStringOffset };
  }

  private refreshAbsolute(startY: number, endY: number): void {
    const viewportY = this.term.buffer.active.viewportY;
    const startRow = Math.max(0, startY - viewportY);
    const endRow = Math.min(this.term.rows - 1, endY - viewportY);
    if (startRow <= endRow) this.term.refresh(startRow, endRow);
  }
}
