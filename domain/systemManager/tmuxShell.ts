/** POSIX single-quote escaping for remote shell commands built in the renderer. */
export function shQuote(str: string): string {
  return `'${String(str).replace(/'/g, "'\"'\"'")}'`;
}

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";

export function buildTmuxAttachCommand(sessionName: string, windowIndex?: number, targetUser?: string): string {
  const target = windowIndex !== undefined
    ? `${shQuote(sessionName)}:${windowIndex}`
    : shQuote(sessionName);
  const attach = targetUser
    ? `sudo -u ${shQuote(targetUser)} tmux attach -t ${target}`
    : `tmux attach -t ${target}`;
  return `${CLEAR_STARTUP_OUTPUT} exec ${attach}`;
}
