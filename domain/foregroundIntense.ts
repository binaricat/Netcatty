/**
 * Foreground-intense color support for terminal themes (#3352).
 *
 * xterm.js resolves bold text drawn with the *default* foreground (SGR 1,
 * SGR 39;1) to the theme `foreground` color — there is no `foregroundIntense`
 * theme key, and `drawBoldTextInBrightColors` only affects cells with an
 * explicit ANSI color. Themes that define a distinct `foregroundIntense` get
 * it by rewriting the output stream: whenever SGR state is "bold + default
 * foreground", the transformer appends an explicit `38;2;r;g;b` (truecolor)
 * color so every renderer (WebGL, DOM) paints the intense variant. When bold
 * is later cleared while the injected color is active, `39` is appended to
 * restore the true default foreground.
 *
 * Explicit ANSI colors (e.g. SGR 1 + cyan) are left untouched and keep the
 * existing normal/bright palette logic.
 */

export type ForegroundIntenseRgb = readonly [number, number, number];

export type ForegroundIntenseThemeColors = {
  foreground: string;
  foregroundIntense?: string;
};

/** Parse a `#rgb` / `#rrggbb` theme color to an rgb triple, or null. */
export function parseHexColor(value: string | undefined): ForegroundIntenseRgb | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "");
  let triplet: string | null = null;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    triplet = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  } else if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    triplet = hex;
  }
  if (!triplet) return null;
  return [
    parseInt(triplet.slice(0, 2), 16),
    parseInt(triplet.slice(2, 4), 16),
    parseInt(triplet.slice(4, 6), 16),
  ];
}

/**
 * Resolve the intense rgb triple for a theme. Returns null when the feature
 * is off: no `foregroundIntense`, an invalid color, or a value equal to the
 * normal foreground (nothing to intensify).
 */
export function resolveForegroundIntenseRgb(
  colors: ForegroundIntenseThemeColors,
): ForegroundIntenseRgb | null {
  const intense = parseHexColor(colors.foregroundIntense);
  if (!intense) return null;
  const normal = parseHexColor(colors.foreground);
  if (!normal) return null;
  if (
    intense[0] === normal[0] &&
    intense[1] === normal[1] &&
    intense[2] === normal[2]
  ) {
    return null;
  }
  return intense;
}

export type ForegroundIntenseTransformer = {
  /** Rewrite one output chunk (escape sequences split across chunks are fine). */
  transform(chunk: string): string;
  /**
   * Update the intense color (e.g. after a theme switch). Null disables.
   * Returns a resync escape sequence the caller must write to the terminal
   * (empty string when nothing is outstanding).
   */
  setColor(rgb: ForegroundIntenseRgb | null): string;
  /** Return any buffered partial escape sequence; call on teardown. */
  flush(): string;
  /** Forget tracked SGR state (e.g. after a full screen reset). */
  reset(): void;
};

const ESC = "\x1b";
const BEL = "\x07";
const C1_CSI = String.fromCharCode(0x9b);
const C1_ST = String.fromCharCode(0x9c);
/** A captured escape sequence longer than this is treated as malformed. */
const MAX_SEQUENCE_LENGTH = 8192;

type Phase = "ground" | "esc" | "csi" | "string" | "stringEsc";

const FG_DEFAULT = 0;
const FG_EXPLICIT = 1;
const FG_INJECTED = 2;

/**
 * Create a stream transformer that applies the intense color to bold text
 * drawn with the default foreground. When `rgb` is null the transformer is a
 * zero-cost pass-through (no SGR state is tracked).
 */
export function createForegroundIntenseTransformer(
  rgb: ForegroundIntenseRgb | null,
): ForegroundIntenseTransformer {
  let color = rgb;
  let bold = false;
  let fgKind = FG_DEFAULT;
  // Rendition state saved by DECSC (ESC 7) / SCOSC (CSI s), restored by
  // DECRC (ESC 8) / SCORC (CSI u). xterm.js saves and restores the fg/bg
  // attributes together with the cursor position, so the tracked SGR state
  // must follow.
  let saved: { bold: boolean; fgKind: number } | null = null;
  let phase: Phase = "ground";
  let seq = "";
  let out = "";

  const resetState = (): void => {
    bold = false;
    fgKind = FG_DEFAULT;
  };

  const injectParams = (): string => `;38;2;${color![0]};${color![1]};${color![2]}`;

  /** Apply one SGR sequence (params split on ';') and normalize the state. */
  const applySgr = (rawParams: string): string => {
    const params = rawParams === "" ? ["0"] : rawParams.split(";");
    for (let i = 0; i < params.length; i += 1) {
      const raw = params[i];
      if (raw === "") {
        resetState();
        continue;
      }
      // ITU T.416 colon form: one self-contained parameter, e.g. 38:2:1:2:3.
      if (raw.includes(":")) {
        const lead = parseInt(raw, 10);
        // 48/58 only change background/underline color, not the foreground.
        if (lead === 38) fgKind = FG_EXPLICIT;
        continue;
      }
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) continue;
      if (n === 0) {
        resetState();
      } else if (n === 1) {
        bold = true;
      } else if (n === 22 || n === 221) {
        // 22 is "bold off"; 221 is the Kitty "not bold" extension that the
        // bundled xterm.js also applies to BOLD.
        bold = false;
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        fgKind = FG_EXPLICIT;
      } else if (n === 39) {
        fgKind = FG_DEFAULT;
      } else if (n === 38 || n === 48 || n === 58) {
        // Extended color: skip its sub-parameters so 48;5;196 is not read as
        // a foreground color. Only 38 makes the foreground explicit; 48/58
        // change the background/underline color instead.
        const sub = params[i + 1];
        if (sub === "5") i += 2;
        else if (sub === "2") i += 4;
        else i += 1;
        if (n === 38) fgKind = FG_EXPLICIT;
      }
      // Everything else (dim, underline, background colors, ...) does not
      // change bold/default-foreground state.
    }
    // Normalize: bold + default foreground renders with the intense color.
    if (color && bold && fgKind !== FG_EXPLICIT) {
      if (fgKind !== FG_INJECTED) {
        fgKind = FG_INJECTED;
        return injectParams();
      }
      return "";
    }
    if (!bold && fgKind === FG_INJECTED) {
      fgKind = FG_DEFAULT;
      return ";39";
    }
    return "";
  };

  const transform = (chunk: string): string => {
    if (!chunk) return chunk;
    // Plain chunks (the common case for floods) never change SGR state.
    if (phase === "ground" && !chunk.includes(ESC) && !chunk.includes(C1_CSI)) {
      return chunk;
    }
    // Note: SGR state is tracked even while the feature is disabled (no
    // color) so a later theme change can resynchronize without waiting for
    // another SGR boundary from the application.
    out = "";
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      switch (phase) {
        case "ground": {
          if (ch === ESC) {
            phase = "esc";
            seq = ch;
          } else if (ch === C1_CSI) {
            phase = "csi";
            seq = ch;
          } else {
            out += ch;
          }
          break;
        }
        case "esc": {
          if (ch === "[") {
            phase = "csi";
            seq += ch;
          } else if (
            ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_"
          ) {
            // OSC / DCS / SOS / PM / APC — swallow until BEL or ST.
            phase = "string";
            seq += ch;
          } else if (ch === ESC) {
            seq = ch;
          } else {
            // Two-character escape (charset designators, RIS, IND, ...).
            seq += ch;
            let extra = "";
            if (ch === "c") {
              // RIS resets everything, including the saved cursor rendition.
              resetState();
              saved = null;
            } else if (ch === "7") {
              saveRendition();
            } else if (ch === "8") {
              extra = restoreRendition();
            }
            out += seq + extra;
            seq = "";
            phase = "ground";
          }
          break;
        }
        case "csi": {
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            seq += ch;
            const paramsStart = seq.charCodeAt(0) === 0x9b ? 1 : 2;
            const params = seq.slice(paramsStart, seq.length - 1);
            let extra = "";
            if (ch === "m") {
              // SGR extras are parameters, appended before the final byte.
              extra = applySgr(params);
              out += seq.slice(0, seq.length - 1) + extra + ch;
            } else {
              if (ch === "s" && /^[0-9;]*$/.test(params)) {
                // SCOSC (plain CSI s only; prefixed/intermediate forms such as
                // the Kitty keyboard CSI = u / CSI ? u are different commands).
                saveRendition();
              } else if (ch === "u" && /^[0-9;]*$/.test(params)) {
                extra = restoreRendition();
              }
              // Non-SGR extras are full sequences, appended after the final byte.
              out += seq + extra;
            }
            seq = "";
            phase = "ground";
          } else if (ch === ESC) {
            // Aborted sequence: emit what we captured, restart parsing.
            out += seq;
            seq = ESC;
            phase = "esc";
          } else {
            seq += ch;
            if (seq.length > MAX_SEQUENCE_LENGTH) {
              out += seq;
              seq = "";
              phase = "ground";
            }
          }
          break;
        }
        case "string": {
          seq += ch;
          if (ch === BEL || ch === C1_ST) {
            out += seq;
            seq = "";
            phase = "ground";
          } else if (ch === ESC) {
            phase = "stringEsc";
          } else if (seq.length > MAX_SEQUENCE_LENGTH) {
            out += seq;
            seq = "";
            phase = "ground";
          }
          break;
        }
        case "stringEsc": {
          if (ch === "\\") {
            out += seq + ch; // seq ends with ESC; ch is the ST backslash.
            seq = "";
            phase = "ground";
          } else {
            // Malformed string terminator: flush what we held and continue.
            out += seq;
            seq = "";
            if (ch === ESC) {
              phase = "esc";
              seq = ch;
            } else if (ch === C1_CSI) {
              phase = "csi";
              seq = ch;
            } else {
              out += ch;
              phase = "ground";
            }
          }
          break;
        }
      }
    }
    return out;
  };

  /**
   * Emit the escape sequence that brings xterm's rendition back in sync after
   * a theme change. Handles an injected color that is now stale (wrong rgb or
   * disabled) and a bold + default foreground that should start injecting
   * right away instead of waiting for the next SGR boundary.
   */
  const resync = (): string => {
    if (fgKind === FG_INJECTED) {
      if (color && bold) {
        // Re-inject with the new intense color.
        return `${ESC}[${injectParams().slice(1)}m`;
      }
      // Injection no longer applies: restore the true default foreground.
      fgKind = FG_DEFAULT;
      return `${ESC}[39m`;
    }
    if (color && bold && fgKind === FG_DEFAULT) {
      // Bold text is being emitted with the default foreground; start
      // injecting immediately so already-streamed bold text switches too.
      fgKind = FG_INJECTED;
      return `${ESC}[${injectParams().slice(1)}m`;
    }
    return "";
  };

  /** DECSC / SCOSC: remember the tracked rendition state. */
  const saveRendition = (): void => {
    saved = { bold, fgKind };
  };

  /**
   * DECRC / SCORC: xterm.js restores the saved fg/bg attributes, so bring the
   * tracked state back in step and emit whatever keeps the terminal in sync
   * (e.g. drop a stale injected color or re-inject the current one).
   */
  const restoreRendition = (): string => {
    if (saved) {
      bold = saved.bold;
      fgKind = saved.fgKind;
    } else {
      // xterm.js starts with default saved attributes, so restoring without a
      // prior save resets the rendition.
      resetState();
    }
    return resync();
  };

  return {
    transform,
    setColor(next: ForegroundIntenseRgb | null): string {
      color = next;
      return resync();
    },
    flush(): string {
      const pending = phase === "ground" ? "" : seq;
      seq = "";
      phase = "ground";
      return pending;
    },
    reset: resetState,
  };
}
