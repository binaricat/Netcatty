export interface TerminalLigatureAddon {
  dispose(): void;
}

export function terminalFontLigaturesEnabled(
  settings: { fontLigatures?: boolean } | null | undefined,
): boolean {
  return settings?.fontLigatures !== false;
}

interface TerminalLigatureControllerOptions {
  createAddon: () => TerminalLigatureAddon;
  loadAddon: (addon: TerminalLigatureAddon) => void;
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
export function createTerminalLigatureController(
  options: TerminalLigatureControllerOptions,
) {
  let addon: TerminalLigatureAddon | null = null;
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
