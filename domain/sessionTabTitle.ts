import type { Host, TerminalSession } from '../types';
import { normalizeCodingCliTitle } from './codingCliTitleParse';

/** Static connection label: user rename or host label. */
export const getSessionConnectionLabel = (session: Pick<TerminalSession, 'customName' | 'hostLabel'>): string => {
  return session.customName || session.hostLabel || '';
};

/** Whether the host opts out of shell-reported window titles. */
export const isDynamicTabTitleDisabled = (host?: Pick<Host, 'disableDynamicTabTitle'>): boolean => {
  return host?.disableDynamicTabTitle === true;
};

/**
 * Resolve the label shown on session tabs and pane headers.
 * Uses the shell-reported title when dynamic titles are enabled.
 */
export const resolveSessionTabTitle = (
  session: Pick<TerminalSession, 'customName' | 'hostLabel' | 'dynamicTitle'>,
  host?: Pick<Host, 'disableDynamicTabTitle'>,
): string => {
  const connectionLabel = getSessionConnectionLabel(session);
  if (isDynamicTabTitleDisabled(host)) {
    return connectionLabel;
  }
  if (session.customName) {
    return session.customName;
  }
  const dynamicTitle = session.dynamicTitle?.trim();
  if (!dynamicTitle) {
    return connectionLabel;
  }
  return normalizeCodingCliTitle(dynamicTitle) || dynamicTitle;
};
