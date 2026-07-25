const ESC = String.fromCharCode(0x1b);
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESC}\\](?:4;\\d{1,3}|1[0-2]);rgb:[0-9a-f]+\\/[0-9a-f]+\\/[0-9a-f]+${ESC}\\\\`,
  'giu',
);
const BRACKETED_PASTE_MARKER_PATTERN = new RegExp(`${ESC}\\[(?:200|201)~`, 'gu');

const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);
const SIMPLE_WRAPPERS = new Set(['command', 'builtin', 'exec']);
const DOCKER_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--config', '--context', '--host', '--log-level', '--tlscacert', '--tlscert', '--tlskey',
  '-c', '-H', '-l',
]);

const commandBasename = (token: string): string => token.split('/').pop() ?? token;

const getLastStartupCommandSegment = (command: string): string => {
  let segmentStart = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ';' || char === '\r' || char === '\n') {
      segmentStart = index + 1;
    } else if (char === '&' && command[index + 1] === '&') {
      segmentStart = index + 2;
      index += 1;
    }
  }
  return command.slice(segmentStart).trim();
};

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
  beginOscColorQuerySuppressionForCommand(state, getLastStartupCommandSegment(command));
}

export function endOscColorQuerySuppressionForCommand(state: { current: boolean }): void {
  state.current = false;
}

export type HibernatedBroadcastInputState = {
  promptReady: boolean;
  line: string;
};

/** Track the input line while xterm is absent and verify the submitted command. */
export function consumeHibernatedBroadcastInput(
  state: HibernatedBroadcastInputState,
  data: string,
  command?: string,
): boolean {
  const input = data.replace(BRACKETED_PASTE_MARKER_PATTERN, '');
  let trustedSubmission = false;
  for (const char of input) {
    if (char === '\x03') {
      state.promptReady = false;
      state.line = '';
    } else if (char === '\x15') {
      state.line = '';
    } else if (char === '\b' || char === '\x7f') {
      state.line = state.line.slice(0, -1);
    } else if (char === '\r' || char === '\n') {
      trustedSubmission ||= state.promptReady
        && command !== undefined
        && state.line.trim() === command.trim();
      state.promptReady = false;
      state.line = '';
    } else if (char.charCodeAt(0) >= 32) {
      state.line += char;
    }
  }
  return trustedSubmission;
}

type OscColorQueryBroadcastInputHandler = (data: string, command?: string) => void;

const oscColorQuerySuppressionArmers = new Map<string, Set<OscColorQueryBroadcastInputHandler>>();

/** Register a session's OSC color-query suppression armer for broadcast peers. */
export function registerOscColorQuerySuppressionArmer(
  sessionId: string,
  armer: OscColorQueryBroadcastInputHandler,
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

/** Track broadcast input and transition suppression on the target's trusted submission. */
export function handleOscColorQueryBroadcastInputForSession(
  sessionId: string,
  data: string,
  command?: string,
): void {
  for (const armer of oscColorQuerySuppressionArmers.get(sessionId) ?? []) {
    armer(data, command);
  }
}

export function stripOscColorQueryResponses(data: string, enabled: boolean): string {
  return enabled ? data.replace(OSC_COLOR_RESPONSE_PATTERN, '') : data;
}
