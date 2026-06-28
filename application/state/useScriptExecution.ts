import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScriptRun, ScriptRunParams } from '@/types/global/netcatty-bridge-script.d.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';

export function useScriptExecution() {
  const [runs, setRuns] = useState<ScriptRun[]>([]);
  const runsRef = useRef(runs);
  runsRef.current = runs;

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.scriptGetRuns) return undefined;
    bridge.scriptGetRuns().then(setRuns).catch(() => {});
    const dispose = bridge.onScriptRunsUpdated?.(({ runs: nextRuns }) => {
      setRuns(nextRuns);
    });
    return dispose;
  }, []);

  const runScript = useCallback(async (params: ScriptRunParams) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.scriptRun) {
      throw new Error('Script bridge unavailable');
    }
    return bridge.scriptRun(params);
  }, []);

  const stopRun = useCallback(async (runId: string) => {
    await netcattyBridge.get()?.scriptStop?.(runId);
  }, []);

  const pauseRun = useCallback(async (runId: string) => {
    await netcattyBridge.get()?.scriptPause?.(runId);
  }, []);

  const resumeRun = useCallback(async (runId: string) => {
    await netcattyBridge.get()?.scriptResume?.(runId);
  }, []);

  const getRunsForSession = useCallback((sessionId: string) => {
    return runsRef.current.filter((run) => run.sessionId === sessionId);
  }, []);

  return {
    runs,
    runScript,
    stopRun,
    pauseRun,
    resumeRun,
    getRunsForSession,
  };
}
