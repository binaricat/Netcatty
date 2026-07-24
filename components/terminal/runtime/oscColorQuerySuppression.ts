import type { IDisposable, IParser } from '@xterm/xterm';

const OSC_COLOR_QUERY_IDENTIFIERS = [10, 11, 12] as const;

const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);
const SIMPLE_WRAPPERS = new Set(['command', 'builtin', 'exec']);
const DOCKER_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--config', '--context', '--host', '--log-level', '--tlscacert', '--tlscert', '--tlskey',
  '-c', '-H', '-l',
]);

const commandBasename = (token: string): string => token.split('/').pop() ?? token;

export function isDockerLogsCommand(command: string): boolean {
  if (/[;&|\r\n]/.test(command)) return false;
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
): IDisposable | undefined {
  if (!enabled) return undefined;

  const shouldSuppress = typeof enabled === 'function' ? enabled : () => true;

  const disposables = OSC_COLOR_QUERY_IDENTIFIERS.map((identifier) => (
    parser.registerOscHandler(identifier, (data) => shouldSuppress() && data.trim() === '?')
  ));

  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
