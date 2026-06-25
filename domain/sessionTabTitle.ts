import type { TerminalSession } from '../types';
import { normalizeCodingCliTitle } from './codingCliTitleParse';
import type { DynamicTabTitleMode } from './models/terminal';

/** Static connection label: user rename or host label. */
export const getSessionConnectionLabel = (session: Pick<TerminalSession, 'customName' | 'hostLabel'>): string => {
  return session.customName || session.hostLabel || '';
};

/**
 * Resolve the label shown on session tabs and pane headers.
 * Uses the shell-reported title according to the global dynamic title mode.
 */
export const resolveSessionTabTitle = (
  session: Pick<TerminalSession, 'customName' | 'hostLabel' | 'dynamicTitle' | 'codingCliProviderId'>,
  dynamicTabTitleMode: DynamicTabTitleMode = 'agent',
): string => {
  const connectionLabel = getSessionConnectionLabel(session);
  if (dynamicTabTitleMode === 'off') {
    return connectionLabel;
  }
  if (session.customName) {
    return session.customName;
  }
  if (dynamicTabTitleMode === 'agent' && !session.codingCliProviderId) {
    return connectionLabel;
  }
  const dynamicTitle = session.dynamicTitle?.trim();
  if (!dynamicTitle) {
    return connectionLabel;
  }
  return normalizeCodingCliTitle(dynamicTitle) || dynamicTitle;
};
