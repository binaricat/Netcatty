import type { SystemProcessInfo } from './types';

export function getProcessFlags(proc: SystemProcessInfo): {
  isStopped: boolean;
  isZombie: boolean;
  isRunning: boolean;
  isSleeping: boolean;
} {
  const stat = proc.stat || '';
  const isZombie = /Z/i.test(stat);
  const isStopped = /T/i.test(stat);
  const isRunning = /R/i.test(stat);
  const isSleeping = /[SD]/i.test(stat) && !isStopped && !isZombie;
  return { isStopped, isZombie, isRunning, isSleeping };
}

export function getProcessTone(proc: SystemProcessInfo): 'success' | 'warning' | 'muted' {
  const { isStopped, isZombie, isRunning } = getProcessFlags(proc);
  if (isZombie) return 'muted';
  if (isStopped) return 'warning';
  if (isRunning) return 'success';
  return 'muted';
}

export type ProcessStatusLabelKey =
  | 'systemManager.processes.state.running'
  | 'systemManager.processes.state.sleeping'
  | 'systemManager.processes.state.stopped'
  | 'systemManager.processes.state.zombie';

export function getProcessStatusLabelKey(proc: SystemProcessInfo): ProcessStatusLabelKey {
  const { isStopped, isZombie, isRunning } = getProcessFlags(proc);
  if (isZombie) return 'systemManager.processes.state.zombie';
  if (isStopped) return 'systemManager.processes.state.stopped';
  if (isRunning) return 'systemManager.processes.state.running';
  return 'systemManager.processes.state.sleeping';
}
