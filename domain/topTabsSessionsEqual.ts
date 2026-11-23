import { terminalPaneSessionsEqual } from './terminalPaneSessionsEqual';
import type { TerminalSession } from './models';

/**
 * TopTabs session list equality: structural pane-critical fields only.
 * Presentation (dynamicTitle / promptHostname / codingCliProviderId) is merged
 * from sessionPresentationStore inside TopTabsInner.
 */
export function topTabsSessionsEqual(
  prev: readonly TerminalSession[] | null | undefined,
  next: readonly TerminalSession[] | null | undefined,
): boolean {
  return terminalPaneSessionsEqual(prev, next);
}
