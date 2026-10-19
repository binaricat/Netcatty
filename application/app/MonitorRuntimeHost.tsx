import { useMonitorRuntime } from '../state/useMonitorRuntime';

/** Keep monitoring state and subscriptions outside the app coordinator. */
export function MonitorRuntimeHost() {
  useMonitorRuntime();
  return null;
}
