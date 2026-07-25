const ESC = String.fromCharCode(0x1b);
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESC}\\](?:4;\\d{1,3}|1[0-2]);rgb:[0-9a-f]+\\/[0-9a-f]+\\/[0-9a-f]+${ESC}\\\\`,
  'giu',
);
const BRACKETED_PASTE_MARKER_PATTERN = new RegExp(`${ESC}\\[(?:200|201)~`, 'gu');
const TRUSTED_CURSOR_EDIT_SEQUENCE_PATTERN = new RegExp(
  `${ESC}(?:\\[[0-9;]*[CDFH]|O[HF])`,
  'gu',
);
const suppressionEndBoundaries = new WeakSet<object>();

const DOCKER_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--config', '--context', '--host', '--log-level', '--tlscacert', '--tlscert', '--tlskey',
  '-c', '-H', '-l',
]);
const DOCKER_NON_EXECUTING_OPTIONS = new Set(['--help', '--version', '-v']);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '--chdir', '--close-from', '--command-timeout', '--group', '--host', '--other-user', '--prompt', '--role',
  '--type', '--user', '-C', '-g', '-h', '-p', '-R', '-r', '-T', '-t', '-u',
]);
const DOAS_OPTIONS_WITH_VALUE = new Set(['-a', '-C', '-u']);
const ENV_OPTIONS_WITH_VALUE = new Set(['--chdir', '--unset', '-C', '-u']);

const commandBasename = (token: string): string => token.split('/').pop() ?? token;

const getForegroundCommandSegments = (command: string): string[] => {
  const segments: string[] = [];
  let segmentStart = 0;
  let trailingSeparator: 'soft' | 'and' | null = null;
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
      const segment = command.slice(segmentStart, index).trim();
      if (segment) segments.push(segment);
      segmentStart = index + 1;
      trailingSeparator = 'soft';
    } else if (char === '&' && command[index + 1] === '&') {
      const segment = command.slice(segmentStart, index).trim();
      if (segment) segments.push(segment);
      segmentStart = index + 2;
      trailingSeparator = 'and';
      index += 1;
    }
  }
  const finalSegment = command.slice(segmentStart).trim();
  if (finalSegment) segments.push(finalSegment);
  if (!finalSegment && trailingSeparator === 'and') return [];
  return segments;
};

const isSafeDockerLogsSetupCommand = (command: string): boolean => (
  /^(?:builtin\s+|command\s+)?cd(?:\s|$)/u.test(command.trim())
);

const hasShellCommandSeparator = (command: string): boolean => {
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === ';' || char === '|' || char === '\r' || char === '\n') return true;
    if (char === '&' && command[index - 1] !== '>' && command[index + 1] !== '>') return true;
  }
  return false;
};

type DockerLogsCommand = { follow: boolean };

const classifyStandaloneDockerLogsCommand = (command: string): DockerLogsCommand | null => {
  if (hasShellCommandSeparator(command)) return null;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;

  while (index < tokens.length) {
    const wrapper = commandBasename(tokens[index]);
    if (wrapper === 'command') {
      index += 1;
      while (tokens[index] === '-p' || tokens[index] === '--') index += 1;
      if ((tokens[index] ?? '').startsWith('-')) return null;
      continue;
    }
    if (wrapper === 'exec') {
      index += 1;
      while ((tokens[index] ?? '').startsWith('-')) {
        const option = tokens[index];
        if (!['--', '-a', '-c', '-l'].includes(option)) return null;
        index += 1;
        if (option === '-a') index += 1;
      }
      continue;
    }
    if (wrapper === 'sudo' || wrapper === 'doas') {
      index += 1;
      const optionsWithValue = wrapper === 'sudo' ? SUDO_OPTIONS_WITH_VALUE : DOAS_OPTIONS_WITH_VALUE;
      while ((tokens[index] ?? '').startsWith('-')) {
        const option = tokens[index];
        if (['--help', '--version', '-V'].includes(option)) return null;
        index += 1;
        if (!option.includes('=') && optionsWithValue.has(option)) index += 1;
      }
      continue;
    }
    if (wrapper === 'env') {
      index += 1;
      while ((tokens[index] ?? '').startsWith('-')) {
        const option = tokens[index];
        if (['--help', '--version'].includes(option)) return null;
        index += 1;
        if (!option.includes('=') && ENV_OPTIONS_WITH_VALUE.has(option)) index += 1;
      }
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
      continue;
    }
    break;
  }

  if (commandBasename(tokens[index] ?? '') !== 'docker') return null;
  index += 1;
  while ((tokens[index] ?? '').startsWith('-')) {
    const option = tokens[index];
    if (DOCKER_NON_EXECUTING_OPTIONS.has(option)) return null;
    index += 1;
    if (!option.includes('=') && DOCKER_GLOBAL_OPTIONS_WITH_VALUE.has(option)) index += 1;
  }
  // `docker logs` is an alias of `docker container logs`.
  if (tokens[index] === 'container') index += 1;
  if (tokens[index] !== 'logs') return null;
  let follow = false;
  for (const token of tokens.slice(index + 1)) {
    if (token === '--follow=false' || token === '-f=false') {
      follow = false;
    } else if (
      token === '--follow'
      || token === '--follow=true'
      || token === '-f'
      || /^-[^-][^=]*f/u.test(token)
    ) {
      follow = true;
    }
  }
  return {
    follow,
  };
};

const classifyDockerLogsCommand = (command: string): DockerLogsCommand | null => {
  const segments = getForegroundCommandSegments(command);
  const dockerSegment = segments.at(-1);
  if (
    dockerSegment === undefined
    || !segments.slice(0, -1).every(isSafeDockerLogsSetupCommand)
  ) return null;
  return classifyStandaloneDockerLogsCommand(dockerSegment);
};

export function isDockerLogsCommand(command: string): boolean {
  return classifyDockerLogsCommand(command) !== null;
}

export function beginOscColorQuerySuppressionForCommand(
  state: { current: boolean },
  command: string,
): void {
  const dockerLogs = classifyDockerLogsCommand(command);
  if (dockerLogs) {
    state.current = true;
    // Follow mode needs a user-originated interrupt before a prompt can be
    // trusted. A bounded logs command may restore on its next trusted command.
    if (dockerLogs.follow) suppressionEndBoundaries.delete(state);
    else suppressionEndBoundaries.add(state);
    return;
  }
  // A prompt-shaped line can be emitted by the container itself. Keep the
  // active guard sticky until a local interrupt establishes a boundary that
  // cannot have originated in Docker output.
  if (!state.current || suppressionEndBoundaries.has(state)) {
    state.current = false;
    suppressionEndBoundaries.delete(state);
  }
}

export function beginOscColorQuerySuppression(state: { current: boolean }): void {
  state.current = true;
  suppressionEndBoundaries.delete(state);
}

/** Record a user-originated interrupt without exposing trailing output yet. */
export function markOscColorQuerySuppressionEndBoundary(state: { current: boolean }): void {
  if (state.current) suppressionEndBoundaries.add(state);
}

export function hasOscColorQuerySuppressionEndBoundary(state: { current: boolean }): boolean {
  return state.current && suppressionEndBoundaries.has(state);
}

export function restoreOscColorQuerySuppressionEndBoundary(
  state: { current: boolean },
  enabled: boolean,
): void {
  suppressionEndBoundaries.delete(state);
  if (state.current && enabled) suppressionEndBoundaries.add(state);
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
  suppressionEndBoundaries.delete(state);
}

export type HibernatedBroadcastInputState = {
  promptReady: boolean;
  line: string;
  tracking: boolean;
  edited?: boolean;
  unverifiableEdit?: boolean;
};

/** Track the input line while xterm is absent and verify the submitted command. */
export function consumeHibernatedBroadcastInput(
  state: HibernatedBroadcastInputState,
  data: string,
  command?: string,
): boolean {
  const input = data.replace(BRACKETED_PASTE_MARKER_PATTERN, '');
  const submittedInput = `${state.line}${input}`
    .replace(/\r\n?/gu, '\n')
    .replace(/[\r\n]+$/gu, '');
  const normalizedCommand = command?.replace(/\r\n?/gu, '\n').trim();
  if (
    state.promptReady
    && normalizedCommand !== undefined
    && submittedInput.trim() === normalizedCommand
  ) {
    state.promptReady = false;
    state.line = '';
    state.tracking = false;
    state.edited = false;
    delete state.unverifiableEdit;
    return true;
  }
  const wasTracking = state.tracking;
  const untrackedControls = input.replace(TRUSTED_CURSOR_EDIT_SEQUENCE_PATTERN, '');
  if (Array.from(untrackedControls).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32
      && char !== '\r'
      && char !== '\n'
      && char !== '\x03'
      && char !== '\x15'
      && char !== '\b';
  })) {
    state.unverifiableEdit = true;
  }
  if (input.includes(ESC)) state.edited = true;
  if (input) state.tracking = true;
  let trustedSubmission = false;
  for (const char of input) {
    if (char === '\x03') {
      state.promptReady = false;
      state.line = '';
      state.tracking = false;
      state.edited = false;
      delete state.unverifiableEdit;
    } else if (char === '\x15') {
      state.line = '';
    } else if (char === '\b' || char === '\x7f') {
      state.line = state.line.slice(0, -1);
    } else if (char === '\r' || char === '\n') {
      trustedSubmission ||= state.promptReady
        && command !== undefined
        && (
          state.line.trim() === command.trim()
          || (wasTracking && state.edited === true && state.unverifiableEdit !== true)
        );
      state.promptReady = false;
      state.line = '';
      state.tracking = false;
      state.edited = false;
      delete state.unverifiableEdit;
    } else if (char.charCodeAt(0) >= 32) {
      state.line += char;
    } else {
      state.edited = true;
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
