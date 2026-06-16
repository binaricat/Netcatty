import { TERMINAL_HOST_TREE_ANIMATION_MS } from './terminalHostTreeAnimation';

export const THEME_TRANSITION_ATTR = 'data-theme-transition';
export const THEME_TRANSITION_MS = TERMINAL_HOST_TREE_ANIMATION_MS;
export type ThemeTransitionMode = 'view' | 'css' | 'instant';

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => {
    finished: Promise<void>;
    skipTransition: () => void;
  };
};

type ThemeTransitionOptions = {
  root?: HTMLElement;
  mode?: ThemeTransitionMode;
};

let cancelThemeTransitionReset: (() => void) | null = null;

function resolveOptions(rootOrOptions?: HTMLElement | ThemeTransitionOptions): Required<ThemeTransitionOptions> {
  if (
    rootOrOptions
    && (
      Object.prototype.hasOwnProperty.call(rootOrOptions, 'root')
      || Object.prototype.hasOwnProperty.call(rootOrOptions, 'mode')
    )
  ) {
    const options = rootOrOptions as ThemeTransitionOptions;
    return {
      root: options.root ?? document.documentElement,
      mode: options.mode ?? 'view',
    };
  }

  return {
    root: rootOrOptions as HTMLElement | undefined ?? document.documentElement,
    mode: 'view',
  };
}

function runCssThemeTransition(apply: () => void, root: HTMLElement, cleanup: () => void): void {
  root.setAttribute(THEME_TRANSITION_ATTR, 'true');
  apply();
  const timer = globalThis.setTimeout(cleanup, THEME_TRANSITION_MS + 40);
  cancelThemeTransitionReset = () => {
    globalThis.clearTimeout(timer);
    cleanup();
  };
}

function skipViewTransition(transition: ReturnType<NonNullable<DocumentWithViewTransition['startViewTransition']>>): void {
  try {
    transition.skipTransition();
  } catch {
    // Already finished or skipped by the browser.
  }
}

export function runThemeTransition(
  apply: () => void,
  rootOrOptions?: HTMLElement | ThemeTransitionOptions,
): void {
  const { root, mode } = resolveOptions(rootOrOptions);
  cancelThemeTransitionReset?.();

  const cleanup = () => {
    root.removeAttribute(THEME_TRANSITION_ATTR);
    cancelThemeTransitionReset = null;
  };

  if (mode === 'instant') {
    apply();
    cleanup();
    return;
  }

  if (mode === 'css') {
    runCssThemeTransition(apply, root, cleanup);
    return;
  }

  const doc = root.ownerDocument as DocumentWithViewTransition | null;
  const startViewTransition = doc?.startViewTransition?.bind(doc);

  if (startViewTransition) {
    let transition: ReturnType<NonNullable<DocumentWithViewTransition['startViewTransition']>> | null = null;
    try {
      transition = startViewTransition(() => {
        apply();
      });
    } catch {
      runCssThemeTransition(apply, root, cleanup);
      return;
    }

    cancelThemeTransitionReset = () => {
      if (transition) {
        skipViewTransition(transition);
      }
      cleanup();
    };
    void transition.finished.then(cleanup, cleanup);
    return;
  }

  runCssThemeTransition(apply, root, cleanup);
}
