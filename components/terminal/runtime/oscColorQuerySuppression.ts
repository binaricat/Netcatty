const ESC = String.fromCharCode(0x1b);
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESC}\\](?:4;\\d{1,3}|1[0-2]);rgb:[0-9a-f]+\\/[0-9a-f]+\\/[0-9a-f]+${ESC}\\\\`,
  'giu',
);

const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);
const SIMPLE_WRAPPERS = new Set(['command', 'builtin', 'exec']);
const DOCKER_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--config', '--context', '--host', '--log-level', '--tlscacert', '--tlscert', '--tlskey',
  '-c', '-H', '-l',
]);

const commandBasename = (token: string): string => token.split('/').pop() ?? token;

const hasShellCommandSeparator = (command: string): boolean => {
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === ';' || char === '|' || char === '\r' || char === '\n') return true;
    if (char === '&' && command[index - 1] !== '>' && command[index + 1] !== '>') return true;
  }
  return false;
};

export function isDockerLogsCommand(command: string): boolean {
  if (hasShellCommandSeparator(command)) return false;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;

  while (index < tokens.length) {
    const wrapper = commandBasename(tokens[index]);
    if (SIMPLE_WRAPPERS.has(wrapper)) {
      index += 1;
      while ((tokens[index] ?? '').startsWith('-')) index += 1;
      continue;
    }
    if (PRIVILEGE_WRAPPERS.has(wrapper)) {
      index += 1;
      while ((tokens[index] ?? '').startsWith('-')) {
        const option = tokens[index];
        index += 1;
        if (!option.includes('=') && ['-C', '-g', '-h', '-p', '-R', '-r', '-t', '-u'].includes(option)) {
          index += 1;
        }
      }
      continue;
    }
    break;
  }

  if (commandBasename(tokens[index] ?? '') !== 'docker') return false;
  index += 1;
  while ((tokens[index] ?? '').startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (!option.includes('=') && DOCKER_GLOBAL_OPTIONS_WITH_VALUE.has(option)) index += 1;
  }
  // `docker logs` is an alias of `docker container logs`.
  if (tokens[index] === 'container') index += 1;
  return tokens[index] === 'logs';
}

export function beginOscColorQuerySuppressionForCommand(
  state: { current: boolean },
  command: string,
): void {
  state.current = isDockerLogsCommand(command);
}

export function beginOscColorQuerySuppression(state: { current: boolean }): void {
  state.current = true;
}

export function beginOscColorQuerySuppressionForStartupCommand(
  state: { current: boolean },
  command: string,
  commandKind?: 'dockerLogs',
): void {
  if (commandKind === 'dockerLogs') {
    beginOscColorQuerySuppression(state);
    return;
  }
  beginOscColorQuerySuppressionForCommand(state, command);
}

export function endOscColorQuerySuppressionForCommand(state: { current: boolean }): void {
  state.current = false;
}

const oscColorQuerySuppressionArmers = new Map<string, Set<(command: string) => void>>();

/** Register a session's OSC color-query suppression armer for broadcast peers. */
export function registerOscColorQuerySuppressionArmer(
  sessionId: string,
  armer: (command: string) => void,
): () => void {
  const armers = oscColorQuerySuppressionArmers.get(sessionId) ?? new Set();
  armers.add(armer);
  oscColorQuerySuppressionArmers.set(sessionId, armers);
  return () => {
    const currentArmers = oscColorQuerySuppressionArmers.get(sessionId);
    currentArmers?.delete(armer);
    if (currentArmers?.size === 0) {
      oscColorQuerySuppressionArmers.delete(sessionId);
    }
  };
}

/** Arm Docker-log OSC suppression on a broadcast target without clearing target-owned state. */
export function armOscColorQuerySuppressionForSession(
  sessionId: string,
  command: string,
): void {
  if (!isDockerLogsCommand(command)) return;
  for (const armer of oscColorQuerySuppressionArmers.get(sessionId) ?? []) {
    armer(command);
  }
}

export function stripOscColorQueryResponses(data: string, enabled: boolean): string {
  return enabled ? data.replace(OSC_COLOR_RESPONSE_PATTERN, '') : data;
}
