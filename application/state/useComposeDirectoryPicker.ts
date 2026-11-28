import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DirectoryPickerError, directoryParent, filterDirectories, isDirectoryPath, type DirectoryEntry, type DirectoryPickerErrorCode } from '../../domain/directoryPicker';
import { resolveComposeDirectoryDisplay, type ComposeDirectoryDisplay } from '../../domain/composeDirectoryDisplay';
import { terminalCwdStore } from './terminalCwdStore';
import { getTerminalDirectory, observeTerminalDirectory, subscribeTerminalDirectories } from './terminalDirectoryRegistry';

export function useComposeDirectoryPicker(sessionId: string) {
  const controller = useSyncExternalStore(subscribeTerminalDirectories, () => getTerminalDirectory(sessionId), () => null);
  const pathFlavor = controller?.target.pathFlavor ?? 'posix';
  useSyncExternalStore(terminalCwdStore.subscribe, terminalCwdStore.getVersion, terminalCwdStore.getVersion);
  const [confirmation, setConfirmation] = useState<{ sessionId: string; controller: typeof controller } | null>(null);
  const confirmed = confirmation?.sessionId === sessionId && confirmation.controller === controller;
  const getCurrentCwd = useCallback(() => controller?.trustsOsc7 === false && pathFlavor === 'posix'
    ? controller.getVerifiedCwd() : terminalCwdStore.getCwd(sessionId), [controller, pathFlavor, sessionId]);
  const observedCwd = getCurrentCwd();
  const cwd = controller && isDirectoryPath(observedCwd, pathFlavor)
    && (confirmed || controller.hasConfirmedCwd() || (controller.trustsOsc7 && terminalCwdStore.getSource(sessionId) === 'osc7'))
    ? observedCwd : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [homeResult, setHomeResult] = useState<{ sessionId: string; controller: typeof controller; value: string | null } | null>(null);
  const home = homeResult?.sessionId === sessionId && homeResult.controller === controller ? homeResult.value : null;
  const setHome = useCallback((value: string | null) => setHomeResult({ sessionId, controller, value }), [sessionId, controller]);
  // Controller identity scopes the display to one connected shell generation.
  const displayCache = useRef<{ sessionId: string; controller: typeof controller; value: ComposeDirectoryDisplay | null } | null>(null);
  const previousDisplay = displayCache.current?.sessionId === sessionId && displayCache.current.controller === controller
    ? displayCache.current.value : null;
  const display = resolveComposeDirectoryDisplay(previousDisplay, cwd, home, pathFlavor);
  useEffect(() => { displayCache.current = { sessionId, controller, value: display }; }, [sessionId, controller, display]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const listingBase = useRef<string | null>(null);
  const listingRevision = useRef<number | null>(null);
  const [error, setError] = useState<DirectoryPickerErrorCode | null>(null);
  const generation = useRef(0);
  const lifetime = useRef(new AbortController());
  const read = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const report = useCallback((failure: unknown, fallback: DirectoryPickerErrorCode) => {
    setError(failure instanceof DirectoryPickerError ? failure.code : fallback);
  }, []);

  useEffect(() => {
    const id = ++generation.current;
    const stopObserving = observeTerminalDirectory(sessionId);
    lifetime.current = new AbortController();
    sending.current = false;
    setConfirmation(null); setOpen(false); setPending(false); setLoading(false); setHome(null); setError(null); setEntries([]);
    listingBase.current = null;
    listingRevision.current = null;
    if (controller) void Promise.all([controller.refresh(), controller.home()]).then(([, nextHome]) => {
      if (generation.current === id) { setConfirmation({ sessionId, controller }); setHome(nextHome); }
    }).catch(failure => { if (generation.current === id) report(failure, 'unknown'); });
    return () => {
      generation.current = id + 1;
      lifetime.current.abort(); read.current?.abort(); stopObserving();
    };
  }, [sessionId, controller, report, setHome]);

  const refresh = useCallback(async () => {
    if (!controller) { setError('unavailable'); return; }
    const id = generation.current;
    setError(null);
    try { await controller.refresh(); if (generation.current === id) setConfirmation({ sessionId, controller }); }
    catch (failure) { if (generation.current === id) report(failure, 'unknown'); }
  }, [controller, report, sessionId]);

  const load = useCallback(async () => {
    if (!controller || !cwd) return;
    read.current?.abort();
    const task = new AbortController(); read.current = task;
    const id = generation.current;
    setLoading(true); setEntries([]); setError(null);
    try {
      // Unchanged OSC 7 reports advance the revision while keeping the store's
      // render version stable. Retry within this request's cancellation scope.
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = terminalCwdStore.getSessionRevision(sessionId);
        const result = await controller.list(cwd, task.signal);
        if (task.signal.aborted || id !== generation.current || getCurrentCwd() !== cwd) return;
        if (terminalCwdStore.getSessionRevision(sessionId) !== revision) continue;
        listingBase.current = cwd; listingRevision.current = revision; setEntries(result.entries); setHome(result.home);
        return;
      }
      throw new DirectoryPickerError('readFailed');
    } catch (failure) {
      if (!task.signal.aborted && id === generation.current) report(failure, 'readFailed');
    } finally { if (!task.signal.aborted && id === generation.current) setLoading(false); }
  }, [controller, cwd, getCurrentCwd, report, sessionId, setHome]);

  useEffect(() => {
    if (!cwd) {
      read.current?.abort();
      listingBase.current = null; listingRevision.current = null;
      setEntries([]); setHome(null); setLoading(false);
      return;
    }
    if (open) { setQuery(''); void load(); }
    return () => { read.current?.abort(); };
  }, [open, load, cwd, setHome]);

  const change = useCallback(async (path: string) => {
    if (!controller) { setError('unavailable'); return; }
    if (sending.current) return;
    if (!cwd || getCurrentCwd() !== cwd
      || (path !== directoryParent(cwd, pathFlavor) && (listingBase.current !== cwd
        || listingRevision.current !== terminalCwdStore.getSessionRevision(sessionId)))) { setError('unavailable'); return; }
    sending.current = true; setPending(true); setError(null);
    const id = generation.current;
    try {
      await controller.change(path, lifetime.current.signal, () => {
        if (id === generation.current) setOpen(false);
      }, cwd ?? undefined, terminalCwdStore.getSessionRevision(sessionId));
    } catch (failure) { if (id === generation.current) report(failure, 'changeFailed'); }
    finally {
      if (id === generation.current) { sending.current = false; setPending(false); }
    }
  }, [controller, report, cwd, sessionId, pathFlavor, getCurrentCwd]);

  const filtered = useMemo(() => filterDirectories(entries, query, showHidden), [entries, query, showHidden]);
  const cwdError = controller?.getCwdError() ?? null;
  const waitsForCwd = error === 'unknown' || error === 'integrationUnavailable' || error === 'cmdIntegrationUnavailable'
    || error === 'gitBashIntegrationUnavailable' || error === 'wslIntegrationUnavailable' || error === 'nonFilesystem';
  return { cwd, home, display, pathFlavor, open, setOpen, query, setQuery, showHidden, setShowHidden, entries: filtered,
    parent: cwd ? directoryParent(cwd, pathFlavor) : null, loading, pending,
    error: cwdError ?? (cwd && waitsForCwd ? null : error),
    available: !!controller?.capabilities.listDirectories && !!controller.capabilities.changeDirectory && !!controller.capabilities.confirmChange,
    refresh, reload: load, change };
}
