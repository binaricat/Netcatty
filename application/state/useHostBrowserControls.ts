import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserBookmark } from '../../domain/browserBookmark';
import type { HostBrowserBookmark, HostBrowserCommand, HostBrowserDownload, HostBrowserState } from '../../domain/hostBrowser';
import { hostBrowserClient, readHostBrowserIcon } from '../../infrastructure/services/hostBrowserService';

export function useHostBrowserControls(browserId: string, ready: boolean) {
  const [state, setState] = useState<HostBrowserState | null>(null);
  const [bookmarks, setBookmarks] = useState<HostBrowserBookmark[]>([]);
  const [downloads, setDownloads] = useState<HostBrowserDownload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focusAddress, setFocusAddress] = useState(0);
  const [downloadStarted, setDownloadStarted] = useState(0);
  const generation = useRef(0);
  const client = useRef<ReturnType<typeof hostBrowserClient> | null>(null);
  const report = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)), []);

  const command = useCallback(async (input: HostBrowserCommand) => {
    const current = client.current;
    const revision = generation.current;
    if (!current) return false;
    setError(null);
    try {
      const next = await current.command(input);
      if (revision !== generation.current) return false;
      setState(next);
      if (input.type === 'new-tab' || (input.type === 'close-tab' && !next.tabs.find((tab) => tab.id === next.activeTabId)?.url)) setFocusAddress((value) => value + 1);
      return true;
    } catch (reason) { if (revision === generation.current) report(reason); return false; }
  }, [report]);

  useEffect(() => {
    const revision = ++generation.current;
    setState(null); setBookmarks([]); setDownloads([]); setError(null); setDownloadStarted(0);
    if (!ready) return;
    let current: ReturnType<typeof hostBrowserClient>;
    try { current = hostBrowserClient(browserId); } catch (reason) { report(reason); return; }
    client.current = current;
    let stateRevision = 0;
    let bookmarkRevision = 0;
    let downloadRevision = 0;
    const active = () => revision === generation.current;
    const refreshBookmarks = async () => {
      const request = ++bookmarkRevision;
      try { const items = await current.bookmarks(); if (active() && request === bookmarkRevision) setBookmarks(items); }
      catch (reason) { if (active()) report(reason); }
    };
    const off = current.subscribe((event) => {
      if (!active()) return;
      if (event.type === 'state') { stateRevision++; setState(event.state); }
      if (event.type === 'bookmarks') void refreshBookmarks();
      if (event.type === 'downloads') {
        downloadRevision++; setDownloads(event.downloads);
        if (event.startedId) setDownloadStarted((value) => value + 1);
      }
      if (event.type === 'shortcut') {
        if (event.shortcut.type === 'focus-address') setFocusAddress((value) => value + 1);
        else void command(event.shortcut.type === 'new-tab' ? { type: 'new-tab' } : { type: event.shortcut.type, tabId: event.shortcut.tabId });
      }
    });
    const requestState = stateRevision;
    void current.state().then((next) => { if (active() && stateRevision === requestState) setState(next); }).catch((reason) => { if (active()) report(reason); });
    void refreshBookmarks();
    const requestDownloads = downloadRevision;
    void current.downloads().then((items) => { if (active() && requestDownloads === downloadRevision) setDownloads(items); }).catch((reason) => { if (active()) report(reason); });
    return () => { generation.current = revision + 1; client.current = null; off(); };
  }, [browserId, ready, command, report]);

  const mutateBookmark = useCallback(async (input: Partial<BrowserBookmark> | string) => {
    const current = client.current;
    const revision = generation.current;
    if (!current) return false;
    try {
      if (typeof input === 'string') await current.removeBookmark(input);
      else await current.saveBookmark(input);
      const items = await current.bookmarks();
      if (revision === generation.current) { setBookmarks(items); setError(null); }
      return true;
    } catch (reason) { if (revision === generation.current) report(reason); return false; }
  }, [report]);

  const downloadCommand = useCallback(async (type: Parameters<ReturnType<typeof hostBrowserClient>['downloadCommand']>[0]['type'], id?: string) => {
    const current = client.current;
    const revision = generation.current;
    if (!current) return;
    try {
      await current.downloadCommand({ type, id });
      const items = await current.downloads();
      if (revision === generation.current) setDownloads(items);
    } catch (reason) { if (revision === generation.current) report(reason); }
  }, [report]);

  const readIcon = useCallback((file: File) => readHostBrowserIcon(file), []);
  return { state, bookmarks, downloads, error, command, mutateBookmark, downloadCommand, focusAddress, downloadStarted,
    requestAddressFocus: () => setFocusAddress((value) => value + 1), readIcon, dismissError: () => setError(null) };
}
