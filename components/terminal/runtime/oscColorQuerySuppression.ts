import type { IDisposable, IParser } from '@xterm/xterm';

const OSC_COLOR_QUERY_IDENTIFIERS = [4, 10, 11, 12] as const;

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

const oscColorQuerySuppressionArmers = new Map<string, (command: string) => void>();

/** Register a session's OSC color-query suppression armer for broadcast peers. */
export function registerOscColorQuerySuppressionArmer(
  sessionId: string,
  armer: (command: string) => void,
): () => void {
  oscColorQuerySuppressionArmers.set(sessionId, armer);
  return () => {
    if (oscColorQuerySuppressionArmers.get(sessionId) === armer) {
      oscColorQuerySuppressionArmers.delete(sessionId);
    }
  };
}

/** Arm (or clear) Docker-log OSC suppression on a broadcast target session. */
export function armOscColorQuerySuppressionForSession(
  sessionId: string,
  command: string,
): void {
  oscColorQuerySuppressionArmers.get(sessionId)?.(command);
}

export function installOscColorQuerySuppression(
  parser: Pick<IParser, 'registerOscHandler'>,
  enabled: boolean | (() => boolean),
  forwardColorSetting: (sequence: string) => void,
): IDisposable | undefined {
  if (!enabled) return undefined;

  const shouldSuppress = typeof enabled === 'function' ? enabled : () => true;

  const suppressQueriesAndForwardSettings = (identifier: number, data: string): boolean => {
    const fields = data.split(';').map((field) => field.trim());
    if (identifier === 4) {
      let hasQuery = false;
      const settings: string[] = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        if (fields[index + 1] === '?') {
          hasQuery = true;
        } else {
          settings.push(fields[index], fields[index + 1]);
        }
      }
      if (!hasQuery) return false;
      if (settings.length > 0) {
        forwardColorSetting(`\x1b]4;${settings.join(';')}\x1b\\`);
      }
      return true;
    }

    let hasQuery = false;
    const supportedFieldCount = 13 - identifier;
    for (let index = 0; index < Math.min(fields.length, supportedFieldCount); index += 1) {
      if (fields[index] === '?') {
        hasQuery = true;
      }
    }
    if (!hasQuery) return false;
    for (let index = 0; index < Math.min(fields.length, supportedFieldCount); index += 1) {
      if (fields[index] !== '?') {
        forwardColorSetting(`\x1b]${identifier + index};${fields[index]}\x1b\\`);
      }
    }
    return true;
  };

  const disposables = OSC_COLOR_QUERY_IDENTIFIERS.map((identifier) => (
    parser.registerOscHandler(
      identifier,
      (data) => shouldSuppress() && suppressQueriesAndForwardSettings(identifier, data),
    )
  ));

  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
