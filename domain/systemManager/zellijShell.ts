import { shQuote } from './tmuxShell';

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";

/**
 * Build the popup-terminal command attaching to a zellij session.
 * `create` maps to `zellij attach -c` (create the session when missing).
 * `targetUser` elevates via sudo; sudo's cached credentials (populated by the
 * panel's polling) normally make this non-interactive.
 */
export function buildZellijAttachCommand(
  sessionName: string,
  options?: { create?: boolean; targetUser?: string },
): string {
  const createFlag = options?.create ? ' -c' : '';
  const target = shQuote(sessionName);
  const attach = options?.targetUser
    ? `sudo -u ${shQuote(options.targetUser)} zellij attach${createFlag} ${target}`
    : `zellij attach${createFlag} ${target}`;
  return `${CLEAR_STARTUP_OUTPUT} exec ${attach}`;
}
