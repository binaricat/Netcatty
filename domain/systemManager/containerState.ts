import type { DockerContainerInfo } from './types';

/**
 * A paused container reports Status "Up 5 minutes (Paused)", so a bare
 * /up/i test classifies it as running too. Paused must win, and the
 * machine-readable State field is preferred over the human Status text.
 */
export function getContainerFlags(container: DockerContainerInfo): {
  isRunning: boolean;
  isPaused: boolean;
} {
  const isPaused = container.state === 'paused' || /paused/i.test(container.status);
  const isRunning = !isPaused
    && (container.state === 'running' || /up/i.test(container.status));
  return { isRunning, isPaused };
}

export function getContainerTone(container: DockerContainerInfo): 'success' | 'warning' | 'muted' {
  const { isRunning, isPaused } = getContainerFlags(container);
  if (isPaused) return 'warning';
  if (isRunning) return 'success';
  return 'muted';
}
