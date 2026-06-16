/** POSIX single-quote escaping for remote shell commands built in the renderer. */
export function shQuote(str: string): string {
  return `'${String(str).replace(/'/g, "'\"'\"'")}'`;
}

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";

export function buildTmuxAttachCommand(sessionName: string, windowIndex?: number): string {
  const target = windowIndex !== undefined
    ? `${shQuote(sessionName)}:${windowIndex}`
    : shQuote(sessionName);
  return `${CLEAR_STARTUP_OUTPUT} exec tmux attach -t ${target}`;
}
