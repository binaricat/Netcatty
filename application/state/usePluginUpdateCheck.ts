import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkPluginUpdates, type PluginUpdateCheckResult } from '../../infrastructure/services/pluginUpdateCheck';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

/** Manual catalog checks only; no scheduler, install or permission mutation. */
export function usePluginUpdateCheck(plugins: readonly NetcattyInstalledPlugin[]) {
  const [result, setResult] = useState<PluginUpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const generation = useRef(0);
  const identityKey = useMemo(() => JSON.stringify(plugins.map((plugin) => [
    plugin.id, plugin.activeVersion, plugin.archiveSha256, plugin.source?.id,
    plugin.source?.kind, plugin.source?.origin,
  ])), [plugins]);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setError(null);
    const requests = generation;
    return () => { requests.current++; };
  }, [identityKey]);
  useEffect(() => {
    const invalidate = () => {
      generation.current++;
      setResult(null);
      setError(null);
    };
    const unsubscribe = netcattyBridge.get()?.onPluginContributionsChanged?.(invalidate);
    window.addEventListener('netcatty:plugin-packages-changed', invalidate);
    return () => { unsubscribe?.(); window.removeEventListener('netcatty:plugin-packages-changed', invalidate); };
  }, []);
  const check = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const current = generation.current;
    setBusy(true); setError(null); setResult(null);
    try {
      const value = await checkPluginUpdates(netcattyBridge.require());
      if (mounted.current && current === generation.current) setResult(value);
    } catch (cause) {
      if (mounted.current && current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      // This component may still be mounted with a refreshed package list.
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { result, error, busy, check };
}
