import { settingsAnchorDomId } from "../../domain/settingsSearchCatalog";

const HIGHLIGHT_CLASS = "settings-search-highlight";
const HIGHLIGHT_MS = 1600;

export type SettingsFocusTarget = {
  tab: string;
  aiSubTab?: string;
  anchorId: string;
};

/**
 * Scroll the settings content pane to a catalog anchor and briefly highlight it.
 * Retries briefly to cover lazy tab mounts / AI sub-tab switches.
 */
export function focusSettingsAnchor(
  anchorId: string,
  options?: { attempts?: number; delayMs?: number },
): void {
  const attempts = options?.attempts ?? 12;
  const delayMs = options?.delayMs ?? 50;
  let remaining = attempts;

  const tryFocus = () => {
    const domId = settingsAnchorDomId(anchorId);
    const el =
      document.getElementById(domId)
      ?? document.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(anchorId)}"]`);

    if (!el) {
      remaining -= 1;
      if (remaining > 0) {
        window.setTimeout(tryFocus, delayMs);
      }
      return;
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove(HIGHLIGHT_CLASS);
    // Force reflow so repeated navigations re-trigger the animation.
    void el.offsetWidth;
    el.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => {
      el.classList.remove(HIGHLIGHT_CLASS);
    }, HIGHLIGHT_MS);
  };

  requestAnimationFrame(tryFocus);
}
