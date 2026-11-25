export interface TerminalLigatureAddon {
  dispose(): void;
}

export type CharacterJoinerHandler = (text: string) => [number, number][];

export interface CharacterJoinerTerminal {
  registerCharacterJoiner(handler: CharacterJoinerHandler): number;
}

export interface ActivatableTerminalLigatureAddon<
  TTerminal extends CharacterJoinerTerminal = CharacterJoinerTerminal,
> extends TerminalLigatureAddon {
  activate(terminal: TTerminal): void;
}

/**
 * Longest legitimate programming ligatures (e.g. `<====>`, `<----->`) are well
 * under 12 cells. Unbounded contextual rules in fonts like Fira Code, JetBrains
 * Mono, and Cascadia Code join entire horizontal rules (`+----...----+`,
 * `|====...====|` from `nvidia-smi` or ASCII tables) into a single wide glyph.
 *
 * In `@xterm/addon-webgl`, any joined glyph wider than the normal 512px atlas
 * page triggers `_overflowSizePage = new AtlasPage(doc, deviceMaxTextureSize)`
 * (16384x16384 = 1 GiB 2D canvas + 1 GiB WebGL texture per atlas instance).
 * Bounding ligature ranges keeps joined glyphs inside normal 512px pages.
 */
export const DEFAULT_MAX_LIGATURE_CELL_SPAN = 12;
export const WEBGL_NORMAL_ATLAS_PAGE_PX = 512;
export const WEBGL_ATLAS_GLYPH_MARGIN_PX = 32;

export interface ResolveMaxLigatureCellSpanOptions {
  deviceCellWidth?: number;
  maxCellSpan?: number;
}

export function resolveMaxLigatureCellSpan(
  options?: ResolveMaxLigatureCellSpanOptions,
): number {
  const configuredCap = options?.maxCellSpan ?? DEFAULT_MAX_LIGATURE_CELL_SPAN;
  const maxCellSpan = Number.isFinite(configuredCap)
    ? Math.max(0, Math.floor(configuredCap))
    : DEFAULT_MAX_LIGATURE_CELL_SPAN;
  const deviceCellWidth = options?.deviceCellWidth;
  if (
    typeof deviceCellWidth === "number" &&
    Number.isFinite(deviceCellWidth) &&
    deviceCellWidth > 0
  ) {
    const atlasSafeSpan = Math.floor(
      (WEBGL_NORMAL_ATLAS_PAGE_PX - WEBGL_ATLAS_GLYPH_MARGIN_PX) / deviceCellWidth,
    );
    return Math.min(maxCellSpan, Math.max(0, atlasSafeSpan));
  }
  return maxCellSpan;
}

export function filterLigatureRanges(
  ranges: [number, number][],
  maxCellSpan: number,
): [number, number][] {
  if (ranges.length === 0) return ranges;
  if (!Number.isFinite(maxCellSpan) || maxCellSpan < 2) return [];

  let allSafe = true;
  for (let i = 0; i < ranges.length; i += 1) {
    const [start, end] = ranges[i];
    const span = end - start;
    if (span < 2 || span > maxCellSpan) {
      allSafe = false;
      break;
    }
  }
  if (allSafe) return ranges;

  const filtered: [number, number][] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    const span = range[1] - range[0];
    if (span >= 2 && span <= maxCellSpan) {
      filtered.push(range);
    }
  }
  return filtered;
}

export interface BoundedLigaturesAddonOptions<
  TTerminal extends CharacterJoinerTerminal = CharacterJoinerTerminal,
> {
  getDeviceCellWidth?: (terminal: TTerminal) => number | undefined;
  maxCellSpan?: number;
}

export function createBoundedLigaturesAddon<
  TTerminal extends CharacterJoinerTerminal,
>(
  addon: ActivatableTerminalLigatureAddon<TTerminal>,
  options?: BoundedLigaturesAddonOptions<TTerminal>,
): ActivatableTerminalLigatureAddon<TTerminal> {
  return {
    activate(terminal: TTerminal) {
      const proxiedTerminal = new Proxy(terminal, {
        get(target, prop) {
          if (prop === "registerCharacterJoiner") {
            return (handler: CharacterJoinerHandler) =>
              target.registerCharacterJoiner((text: string) => {
                const maxSpan = resolveMaxLigatureCellSpan({
                  deviceCellWidth: options?.getDeviceCellWidth?.(target),
                  maxCellSpan: options?.maxCellSpan,
                });
                return filterLigatureRanges(handler(text), maxSpan);
              });
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        },
      });
      addon.activate(proxiedTerminal);
    },
    dispose() {
      addon.dispose();
    },
  };
}

export function terminalFontLigaturesEnabled(
  settings: { fontLigatures?: boolean } | null | undefined,
): boolean {
  return settings?.fontLigatures !== false;
}

interface TerminalLigatureControllerOptions<
  TAddon extends TerminalLigatureAddon = TerminalLigatureAddon,
> {
  createAddon: () => TAddon;
  loadAddon: (addon: TAddon) => void;
  isWebglActive: () => boolean;
  recreateWebgl: () => void;
  repaint: () => void;
  warn?: (message: string, error?: unknown) => void;
}

/**
 * Owns the ligatures addon for one terminal.
 *
 * The addon writes `font-feature-settings` onto the terminal element. WebGL
 * copies that onto its glyph atlas only when the atlas canvas is created, so
 * an already-running WebGL renderer has to be rebuilt after the setting
 * changes. Hidden panes that have not created WebGL yet just keep the CSS in
 * place for the deferred load.
 */
export function createTerminalLigatureController<
  TAddon extends TerminalLigatureAddon = TerminalLigatureAddon,
>(
  options: TerminalLigatureControllerOptions<TAddon>,
) {
  let addon: TAddon | null = null;
  let enabled = false;

  const apply = (nextEnabled: boolean) => {
    if (nextEnabled === enabled) return;

    if (nextEnabled) {
      const created = options.createAddon();
      try {
        options.loadAddon(created);
      } catch (error) {
        try {
          created.dispose();
        } catch {
          // Keep the original load error.
        }
        options.warn?.("[XTerm] Ligatures addon failed to load", error);
        return;
      }
      addon = created;
      enabled = true;
    } else {
      try {
        addon?.dispose();
      } catch (error) {
        options.warn?.("[XTerm] Ligatures addon failed to dispose", error);
      }
      addon = null;
      enabled = false;
    }

    if (options.isWebglActive()) {
      options.recreateWebgl();
    }
    options.repaint();
  };

  return {
    apply,
    dispose: () => {
      const current = addon;
      addon = null;
      enabled = false;
      try {
        current?.dispose();
      } catch (error) {
        options.warn?.("[XTerm] Ligatures addon failed to dispose", error);
      }
    },
  };
}
