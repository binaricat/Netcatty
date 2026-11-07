import { useCallback, useEffect, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginSources() {
  const [sources, setSources] = useState<NetcattyPluginSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const values = await netcattyBridge.require().listPluginSources?.();
    if (!values) throw new Error('Source management unavailable');
    setSources(values);
  }, []);
  useEffect(() => { void reload().catch((cause) => setError(String(cause))); }, [reload]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await operation(); await reload(); window.dispatchEvent(new Event('netcatty:plugin-packages-changed')); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { setBusy(false); }
  };
  return { sources, error, busy,
    add: (name: string, address: string) => mutate(async () => netcattyBridge.require().addPluginSource?.({ name, address })),
    update: (source: NetcattyPluginSource, name: string, enabled: boolean) => mutate(async () => netcattyBridge.require().updatePluginSource?.({ id: source.id, name, enabled })),
    remove: (id: string, disablePlugins: boolean) => mutate(async () => netcattyBridge.require().removePluginSource?.(id, disablePlugins)),
  };
}
