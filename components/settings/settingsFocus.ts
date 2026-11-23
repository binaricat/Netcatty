import { settingsAnchorDomId } from "../../domain/settingsSearchCatalog";

const HIGHLIGHT_CLASS = "settings-search-highlight";
const HIGHLIGHT_MS = 1600;
/** Keep focused anchors slightly below the top of the settings content pane. */
const SCROLL_TOP_PADDING_PX = 24;
/** Allow 200ms at the default retry delay for lazy tab / sub-tab mounts. */
const FALLBACK_AFTER_ATTEMPTS = 5;

export type SettingsFocusTarget = {
  tab: string;
  aiSubTab?: string;
  syncSubTab?: string;
  anchorId: string;
  fallbackAnchorId?: string;
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

function findVisibleAnchor(anchorId: string): HTMLElement | undefined {
  const candidates = [
    document.getElementById(settingsAnchorDomId(anchorId)),
    ...Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-settings-anchor="${CSS.escape(anchorId)}"]`,
      ),
    ),
  ].filter((node): node is HTMLElement => Boolean(node));
  return candidates.find((node) => isAnchorVisible(node));
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
    // preventScroll: we own scrolling so the settings titlebar / traffic-light
    // chrome never rides along with a viewport-level scrollIntoView.
    target.focus({ preventScroll: true });
  } catch {
    // ignore focus failures in non-interactive hosts
  }
}

function isVerticallyScrollable(el: HTMLElement): boolean {
  const { overflowY } = window.getComputedStyle(el);
  if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") {
    return false;
  }
  return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Prefer the dedicated settings content scroller; never fall back to
 * document/body scrolling (that lifts the whole window under macOS traffic lights).
 */
export function findSettingsScrollContainer(el: HTMLElement): HTMLElement | null {
  // Trust the marked pane even when content is shorter than the viewport —
  // search jumps must still scroll this host, not the window.
  const marked = el.closest<HTMLElement>("[data-settings-scroll-pane]");
  if (marked) return marked;

  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.documentElement && node !== document.body) {
    if (isVerticallyScrollable(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Scroll only within the settings content pane so the window chrome stays put.
 */
export function scrollSettingsAnchorIntoView(
  el: HTMLElement,
  behavior: ScrollBehavior = "smooth",
): void {
  const scroller = findSettingsScrollContainer(el);
  if (!scroller) {
    // Nearest-only, never "center" — avoids yanking the whole settings window.
    el.scrollIntoView({ behavior, block: "nearest", inline: "nearest" });
    return;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const elTopInScroller = elRect.top - scrollerRect.top + scroller.scrollTop;
  const targetTop = Math.max(0, elTopInScroller - SCROLL_TOP_PADDING_PX);
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTo({
    top: Math.min(targetTop, maxScroll),
    behavior,
  });
}

/**
 * Scroll the settings content pane to a catalog anchor and briefly highlight it.
 * Retries to cover lazy tab mounts / nested sub-tab switches.
 * After a short mount window, use a visible parent fallback for gated rows.
 */
export function focusSettingsAnchor(
  anchorId: string,
  options?: { attempts?: number; delayMs?: number; fallbackAnchorId?: string },
): Promise<boolean> {
  const attempts = options?.attempts ?? 40;
  const delayMs = options?.delayMs ?? 50;
  const generation = ++focusGeneration;
  let attempt = 0;

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

      attempt += 1;
      let el = findVisibleAnchor(anchorId);
      if (!el && options?.fallbackAnchorId && attempt >= Math.min(FALLBACK_AFTER_ATTEMPTS, attempts)) {
        el = findVisibleAnchor(options.fallbackAnchorId);
      }
      if (!el) {
        if (attempt < attempts) {
          window.setTimeout(tryFocus, delayMs);
          return;
        }
        finish(false);
        return;
      }

      scrollSettingsAnchorIntoView(el, "smooth");
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
