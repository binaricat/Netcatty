import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginManager() {
  const [plugins, setPlugins] = useState<NetcattyInstalledPlugin[]>([]);
  const [available, setAvailable] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
  const [credentialStorageAvailable, setCredentialStorageAvailable] = useState<boolean | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutation = useRef(false);
  const refresh = useCallback(async (options?: { clearError?: boolean }) => {
    if (options?.clearError) setError(null);
    const current = ++generation.current;
    try {
      const bridge = netcattyBridge.get();
      const status = await bridge?.getPluginRuntimeStatus?.();
      const list = status?.available ? await bridge?.listPlugins?.() ?? [] : [];
      if (current !== generation.current) return;
      setAvailable(status?.available === true);
      setStatusKnown(true);
      setCredentialStorageAvailable(status?.credentialStorageAvailable);
      setPlugins(list);
    } catch (cause) {
      if (current === generation.current) {
        setStatusKnown(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      throw cause;
    }
  }, []);
  useEffect(() => {
    const update = () => { void refresh().catch((cause) => setError(String(cause))); };
    update();
    const unsubscribe = netcattyBridge.get()?.onPluginContributionsChanged?.(update);
    window.addEventListener('netcatty:plugin-packages-changed', update);
    const refreshGeneration = generation;
    return () => { refreshGeneration.current++; unsubscribe?.(); window.removeEventListener('netcatty:plugin-packages-changed', update); };
  }, [refresh]);
  const run = useCallback(async (action: (bridge: NetcattyBridge) => Promise<unknown>, throwOnError = false) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    let failure: Error | null = null;
    try { await action(netcattyBridge.require()); }
    catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); setError(failure.message); }
    finally {
      try { await refresh(); } catch (cause) { failure ??= cause instanceof Error ? cause : new Error(String(cause)); setError(failure.message); }
      mutation.current = false;
      setBusy(false);
    }
    if (throwOnError && failure) throw failure;
  }, [refresh]);
  return {
    plugins, available, statusKnown, busy, error, credentialStorageAvailable, refresh,
    importPackage: () => run(async (bridge) => {
      if (!bridge.selectFile || !bridge.installPluginPackage) throw new Error('Plugin import unavailable');
      const path = await bridge.selectFile('Import plugin package', undefined, [{ name: 'Netcatty plugin', extensions: ['ncpkg'] }]);
      if (path) await bridge.installPluginPackage(path, { enable: false });
    }),
    setEnabled: (id: string, enabled: boolean) => run(async (bridge) => {
      if (!bridge.setPluginEnabled) throw new Error('Plugin management unavailable');
      return bridge.setPluginEnabled(id, enabled);
    }),
    uninstall: (id: string, clearSource = false) => run(async (bridge) => {
      if (!bridge.uninstallPlugin) throw new Error('Plugin management unavailable');
      const source = clearSource ? await bridge.getPluginSourceBinding?.(id) : null;
      await bridge.uninstallPlugin(id);
      if (clearSource && source) {
        if (!bridge.resetPluginSource) throw new Error('Private source reset unavailable');
        await bridge.resetPluginSource(id, source.id);
      }
    }, true),
  };
}
