import type { BrowserBookmark } from './browserBookmark';

export class HostBrowserIconError extends Error {
  constructor(public readonly reason: 'file-type' | 'file-size' | 'decode') {
    super(reason);
    this.name = 'HostBrowserIconError';
  }
}

export interface HostBrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  iconDataUrl: string | null;
  iconGlyph: string | null;
  iconColor: string | null;
}

export interface HostBrowserState {
  hostId: string;
  label: string;
  route: 'connecting' | 'connected' | 'disconnected';
  error: string | null;
  activeTabId: string | null;
  tabs: HostBrowserTab[];
}

export interface HostBrowserDownload {
  id: string;
  hostId: string;
  filename: string;
  url: string;
  savePath: string;
  status: 'waiting' | 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
  startedAt: number;
  endedAt: number | null;
  missing: boolean;
}

export type HostBrowserBookmark = BrowserBookmark & {
  siteIconDataUrl?: string | null;
  siteIconGlyph?: string | null;
  siteIconColor?: string | null;
};

export type HostBrowserCommand =
  | { type: 'new-tab'; url?: string }
  | { type: 'navigate'; url: string; tabId?: string }
  | { type: 'activate' | 'close-tab' | 'back' | 'forward' | 'reload' | 'stop' | 'reset-icon'; tabId?: string }
  | { type: 'reorder'; tabId: string; beforeTabId: string }
  | { type: 'set-icon'; tabId: string; dataUrl?: string | null; glyph: string; color: string }
  | { type: 'retry' };

export type HostBrowserShortcut = { type: 'focus-address' | 'new-tab' | 'close-tab' | 'reload'; tabId: string };
export type HostBrowserPanelEvent = { browserId: string } & (
  | { type: 'state'; state: HostBrowserState }
  | { type: 'downloads'; downloads: HostBrowserDownload[]; startedId?: string }
  | { type: 'bookmarks' }
  | { type: 'shortcut'; shortcut: HostBrowserShortcut }
);
