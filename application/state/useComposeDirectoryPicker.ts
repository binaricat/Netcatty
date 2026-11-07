import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DirectoryPickerError, directoryParent, filterDirectories, isDirectoryPath, type DirectoryEntry, type DirectoryPickerErrorCode } from '../../domain/directoryPicker';
import { terminalCwdStore } from './terminalCwdStore';
import { getTerminalDirectory, observeTerminalDirectory, subscribeTerminalDirectories } from './terminalDirectoryRegistry';

export function useComposeDirectoryPicker(sessionId: string) {
  const controller = useSyncExternalStore(subscribeTerminalDirectories, () => getTerminalDirectory(sessionId), () => null);
  const pathFlavor = controller?.target.pathFlavor ?? 'posix';
  useSyncExternalStore(terminalCwdStore.subscribe, terminalCwdStore.getVersion, terminalCwdStore.getVersion);
  const [confirmed, setConfirmed] = useState(false);
  const observedCwd = terminalCwdStore.getCwd(sessionId);
  const cwd = controller && isDirectoryPath(observedCwd, pathFlavor)
    && (confirmed || controller.hasConfirmedCwd() || (pathFlavor === 'posix' && terminalCwdStore.getSource(sessionId) === 'osc7'))
    ? observedCwd : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [home, setHome] = useState<string | null>(null);
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
    setConfirmed(false); setOpen(false); setPending(false); setLoading(false); setHome(null); setError(null); setEntries([]);
    listingBase.current = null;
    listingRevision.current = null;
    if (controller) void Promise.all([controller.refresh(), controller.home()]).then(([, nextHome]) => {
      if (generation.current === id) { setConfirmed(true); setHome(nextHome); }
    }).catch(failure => { if (generation.current === id) report(failure, 'unknown'); });
    return () => {
      generation.current = id + 1;
      lifetime.current.abort(); read.current?.abort(); stopObserving();
    };
  }, [sessionId, controller, report]);

  const refresh = useCallback(async () => {
    if (!controller) { setError('unavailable'); return; }
    const id = generation.current;
    setError(null);
    try { await controller.refresh(); if (generation.current === id) setConfirmed(true); }
    catch (failure) { if (generation.current === id) report(failure, 'unknown'); }
  }, [controller, report]);

  const load = useCallback(async () => {
    if (!controller || !cwd) return;
    read.current?.abort();
    const task = new AbortController(); read.current = task;
    const id = generation.current;
    const revision = terminalCwdStore.getSessionRevision(sessionId);
    setLoading(true); setEntries([]); setError(null);
    try {
      const result = await controller.list(cwd, task.signal);
      if (!task.signal.aborted && id === generation.current && terminalCwdStore.getSessionRevision(sessionId) === revision) {
        listingBase.current = cwd; listingRevision.current = revision; setEntries(result.entries); setHome(result.home);
      }
    } catch (failure) {
      if (!task.signal.aborted && id === generation.current) report(failure, 'readFailed');
    } finally { if (!task.signal.aborted && id === generation.current) setLoading(false); }
  }, [controller, cwd, report, sessionId]);

  useEffect(() => {
    if (!cwd) {
      read.current?.abort();
      listingBase.current = null; listingRevision.current = null;
      setEntries([]); setHome(null); setLoading(false);
      return;
    }
    if (open) { setQuery(''); void load(); }
    return () => { read.current?.abort(); };
  }, [open, load, cwd]);

  const change = useCallback(async (path: string) => {
    if (!controller) { setError('unavailable'); return; }
    if (sending.current) return;
    if (!cwd || terminalCwdStore.getCwd(sessionId) !== cwd
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
  }, [controller, report, cwd, sessionId, pathFlavor]);

  const filtered = useMemo(() => filterDirectories(entries, query, showHidden), [entries, query, showHidden]);
  const cwdError = controller?.getCwdError() ?? null;
  return { cwd, home, pathFlavor, open, setOpen, query, setQuery, showHidden, setShowHidden, entries: filtered,
    parent: cwd ? directoryParent(cwd, pathFlavor) : null, loading, pending,
    error: cwdError ?? (cwd && (error === 'unknown' || error === 'integrationUnavailable' || error === 'nonFilesystem') ? null : error),
    available: !!controller?.capabilities.listDirectories && !!controller.capabilities.changeDirectory && !!controller.capabilities.confirmChange,
    refresh, reload: load, change };
}
