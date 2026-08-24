const AI_COMPOSER_FOCUS_SELECTOR =
  '[data-section="ai-chat-input-body"], [data-section="ai-chat-panel"] textarea';

/** Wait after expand before history markdown can start — covers the type-a-few-chars window. */
export const AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS = 4000;
/** After the composer blurs, a short pause is enough to know typing stopped. */
export const AI_MARKDOWN_WARMUP_RESUME_DELAY_MS = 600;
/** Treat recent keystrokes as busy even if focus already moved. */
export const AI_COMPOSER_IDLE_MS = 2000;
let composerComposing = false;
const CHAT_MARKDOWN_HYDRATE_BATCH = 2;

let markdownWarmupPromise: Promise<unknown> | null = null;
let markdownWarmupResolved = false;
let lastComposerActivityAt = 0;
const readyListeners = new Set<() => void>();
const hydrateQueue: Array<() => void> = [];
let hydrateScheduled = false;

function notifyAiMarkdownRendererReady(): void {
  markdownWarmupResolved = true;
  for (const listener of readyListeners) listener();
  readyListeners.clear();
  pumpChatMarkdownHydrate();
}

export function isAiComposerTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return Boolean((target as Element).closest(AI_COMPOSER_FOCUS_SELECTOR));
}

export function markAiComposerActivity(): void {
  lastComposerActivityAt = Date.now();
}

export function setAiComposerComposing(next: boolean): void {
  composerComposing = next;
  if (next) markAiComposerActivity();
}

export function isAiComposerRecentlyActive(now = Date.now()): boolean {
  return lastComposerActivityAt > 0 && now - lastComposerActivityAt < AI_COMPOSER_IDLE_MS;
}

export function shouldDeferAiMarkdownWarmup(input: {
  composerFocused?: boolean;
  isComposing?: boolean;
  recentlyActive?: boolean;
}): boolean {
  return Boolean(input.composerFocused || input.isComposing || input.recentlyActive);
}

export function isAiComposerTyping(): boolean {
  return shouldDeferAiMarkdownWarmup({
    isComposing: composerComposing,
    recentlyActive: isAiComposerRecentlyActive(),
  });
}

export function isAiComposerBusy(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return shouldDeferAiMarkdownWarmup({
    composerFocused: isAiComposerTarget(active),
    isComposing: composerComposing,
    recentlyActive: isAiComposerRecentlyActive(),
  });
}

export function isAiMarkdownRendererReady(): boolean {
  return markdownWarmupResolved;
}

export function subscribeAiMarkdownRendererReady(listener: () => void): () => void {
  if (markdownWarmupResolved) {
    listener();
    return () => {};
  }
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

export function resolveAiMarkdownWarmupDelay(input: {
  hasArmed: boolean;
  initialDelayMs: number;
  resumeDelayMs: number;
}): number {
  return input.hasArmed ? input.resumeDelayMs : input.initialDelayMs;
}

/** Prefetch Streamdown off the first-keystroke path. Safe to call repeatedly. */
export function warmAiMarkdownRenderer(): Promise<unknown> {
  markdownWarmupPromise ??= import('../ai-elements/messageResponse').then((module) => {
    notifyAiMarkdownRendererReady();
    return module;
  }, (error) => {
    markdownWarmupPromise = null;
    throw error;
  });
  return markdownWarmupPromise;
}

function pumpChatMarkdownHydrate(): void {
  if (hydrateScheduled) return;
  hydrateScheduled = true;
  const run = () => {
    hydrateScheduled = false;
    if (hydrateQueue.length === 0) return;
    if (!markdownWarmupResolved) return;
    // Focused but idle is fine: Streamdown+CJK is light. Only pause while
    // the user is actually typing so history does not stay raw forever.
    if (isAiComposerTyping()) {
      hydrateScheduled = true;
      window.setTimeout(() => {
        hydrateScheduled = false;
        pumpChatMarkdownHydrate();
      }, AI_COMPOSER_IDLE_MS);
      return;
    }
    const batch = hydrateQueue.splice(0, CHAT_MARKDOWN_HYDRATE_BATCH);
    for (const task of batch) task();
    if (hydrateQueue.length > 0) {
      pumpChatMarkdownHydrate();
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
    return;
  }
  queueMicrotask(run);
}

/** Upgrade deferred chat rows a few at a time, never while the composer is busy. */
export function enqueueChatMarkdownHydrate(onReady: () => void): () => void {
  let cancelled = false;
  const task = () => {
    if (!cancelled) onReady();
  };
  hydrateQueue.push(task);
  pumpChatMarkdownHydrate();
  return () => {
    cancelled = true;
    const index = hydrateQueue.indexOf(task);
    if (index >= 0) hydrateQueue.splice(index, 1);
  };
}

/**
 * Run `task` only when the composer is idle. Import/IPC cannot be cancelled
 * once started, so this must not fire during expand → first type.
 */
export function scheduleWhenAiComposerIdle(
  task: () => void,
  options?: {
    initialDelayMs?: number;
    resumeDelayMs?: number;
  },
): () => void {
  return scheduleAiMarkdownWarmup({
    load: task,
    isBusy: isAiComposerBusy,
    initialDelayMs: options?.initialDelayMs ?? AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
    resumeDelayMs: options?.resumeDelayMs ?? AI_COMPOSER_IDLE_MS,
  });
}

/**
 * Load markdown only when the browser is idle and the composer is not focused.
 * Import() cannot be cancelled, so this must not start during expand → first type.
 */
export function scheduleAiMarkdownWarmup(options?: {
  isBusy?: () => boolean;
  load?: () => void;
  initialDelayMs?: number;
  resumeDelayMs?: number;
}): () => void {
  const isBusy = options?.isBusy ?? isAiComposerBusy;
  const load = options?.load ?? (() => {
    void warmAiMarkdownRenderer();
  });
  const initialDelayMs = options?.initialDelayMs ?? 0;
  const resumeDelayMs = options?.resumeDelayMs ?? 0;

  let idleId: number | null = null;
  let timeoutId: number | null = null;
  let cancelled = false;
  let hasArmed = false;

  const clearTimers = () => {
    if (idleId != null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(idleId);
    }
    idleId = null;
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const tryLoad = () => {
    idleId = null;
    timeoutId = null;
    if (cancelled) return;
    if (isBusy()) {
      timeoutId = window.setTimeout(armIdle, Math.max(resumeDelayMs, AI_COMPOSER_IDLE_MS));
      return;
    }
    load();
  };

  const armIdle = () => {
    if (cancelled) return;
    if (typeof requestIdleCallback === 'function') {
      idleId = requestIdleCallback(tryLoad);
      return;
    }
    timeoutId = window.setTimeout(tryLoad, 2000);
  };

  const arm = () => {
    if (cancelled) return;
    clearTimers();
    const delay = resolveAiMarkdownWarmupDelay({
      hasArmed,
      initialDelayMs,
      resumeDelayMs,
    });
    hasArmed = true;
    if (delay > 0) {
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        armIdle();
      }, delay);
      return;
    }
    armIdle();
  };

  const onFocusIn = (event: FocusEvent) => {
    if (isAiComposerTarget(event.target)) {
      markAiComposerActivity();
      arm();
    }
  };
  const onFocusOut = (event: FocusEvent) => {
    if (isAiComposerTarget(event.target)) arm();
  };
  const onComposerEvent = (event: Event) => {
    if (!isAiComposerTarget(event.target)) return;
    markAiComposerActivity();
    arm();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('focusout', onFocusOut);
    window.addEventListener('keydown', onComposerEvent, true);
    window.addEventListener('compositionstart', onComposerEvent, true);
    window.addEventListener('compositionupdate', onComposerEvent, true);
  }
  arm();

  return () => {
    cancelled = true;
    clearTimers();
    if (typeof window === 'undefined') return;
    window.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('keydown', onComposerEvent, true);
    window.removeEventListener('compositionstart', onComposerEvent, true);
    window.removeEventListener('compositionupdate', onComposerEvent, true);
  };
}
