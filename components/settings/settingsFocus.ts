import { settingsAnchorDomId } from "../../domain/settingsSearchCatalog";

const HIGHLIGHT_CLASS = "settings-search-highlight";
const HIGHLIGHT_MS = 1600;

export type SettingsFocusTarget = {
  tab: string;
  aiSubTab?: string;
  syncSubTab?: string;
  anchorId: string;
};

let focusGeneration = 0;
let highlightClearTimer: number | null = null;

/** Cancel any in-flight focusSettingsAnchor retries / scroll. */
export function cancelSettingsFocus(): void {
  focusGeneration += 1;
}

function isAnchorVisible(el: HTMLElement): boolean {
  if (el.closest("[hidden]")) return false;
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return el.getClientRects().length > 0;
}

function focusAnchorElement(el: HTMLElement): void {
  const focusable = el.matches("button, a, input, select, textarea, [tabindex]")
    ? el
    : el.querySelector<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
  const target = focusable ?? el;
  if (!target.hasAttribute("tabindex") && target === el) {
    target.tabIndex = -1;
  }
  try {
    target.focus({ preventScroll: true });
  } catch {
    // ignore focus failures in non-interactive hosts
  }
}

/**
 * Scroll the settings content pane to a catalog anchor and briefly highlight it.
 * Retries to cover lazy tab mounts / nested sub-tab switches.
 */
export function focusSettingsAnchor(
  anchorId: string,
  options?: { attempts?: number; delayMs?: number },
): Promise<boolean> {
  const attempts = options?.attempts ?? 40;
  const delayMs = options?.delayMs ?? 50;
  const generation = ++focusGeneration;
  let remaining = attempts;

  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      if (generation !== focusGeneration) return;
      resolve(ok);
    };

    const tryFocus = () => {
      if (generation !== focusGeneration) {
        resolve(false);
        return;
      }

      const domId = settingsAnchorDomId(anchorId);
      const candidates = [
        document.getElementById(domId),
        ...Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-settings-anchor="${CSS.escape(anchorId)}"]`,
          ),
        ),
      ].filter((node): node is HTMLElement => Boolean(node));

      const el = candidates.find((node) => isAnchorVisible(node));
      if (!el) {
        remaining -= 1;
        if (remaining > 0) {
          window.setTimeout(tryFocus, delayMs);
          return;
        }
        finish(false);
        return;
      }

      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove(HIGHLIGHT_CLASS);
      void el.offsetWidth;
      el.classList.add(HIGHLIGHT_CLASS);
      if (highlightClearTimer !== null) {
        window.clearTimeout(highlightClearTimer);
      }
      highlightClearTimer = window.setTimeout(() => {
        el.classList.remove(HIGHLIGHT_CLASS);
        highlightClearTimer = null;
      }, HIGHLIGHT_MS);
      focusAnchorElement(el);
      finish(true);
    };

    requestAnimationFrame(tryFocus);
  });
}
