import type { MultiplexerUser } from './types';

/**
 * Order the user dropdown: current connection user first, then users that
 * already own tmux socket directories, then the rest alphabetically.
 */
export function sortMultiplexerUsers(
  users: MultiplexerUser[],
  currentUser: string,
): MultiplexerUser[] {
  return [...users].sort((a, b) => {
    if (a.name === currentUser) return -1;
    if (b.name === currentUser) return 1;
    const aSock = a.hasTmuxSockets ? 1 : 0;
    const bSock = b.hasTmuxSockets ? 1 : 0;
    if (aSock !== bSock) return bSock - aSock;
    return a.name.localeCompare(b.name);
  });
}

/** True when listing/managing sessions for `selectedUser` requires sudo elevation. */
export function multiplexerScopeNeedsSudo(
  selectedUser: string,
  currentUser: string,
): boolean {
  return Boolean(selectedUser) && selectedUser !== currentUser;
}
