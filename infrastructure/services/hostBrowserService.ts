import type { BrowserBookmark } from '../../domain/browserBookmark';
import type { HostBrowserCommand, HostBrowserPanelEvent } from '../../domain/hostBrowser';
import { HostBrowserIconError } from '../../domain/hostBrowser';
import { netcattyBridge } from './netcattyBridge';

export function hostBrowserClient(browserId: string) {
  const bridge = netcattyBridge.require();
  if (!bridge.getHostBrowserPanelState || !bridge.commandHostBrowserPanel) {
    throw new Error('Restart Netcatty to load the updated browser controls');
  }
  return {
    state: () => bridge.getHostBrowserPanelState!(browserId),
    command: (command: HostBrowserCommand) => bridge.commandHostBrowserPanel!(browserId, command),
    bookmarks: () => bridge.listHostBrowserPanelBookmarks!(browserId),
    saveBookmark: (bookmark: Partial<BrowserBookmark>) => bridge.saveHostBrowserPanelBookmark!(browserId, bookmark),
    removeBookmark: (id: string) => bridge.removeHostBrowserPanelBookmark!(browserId, id),
    downloads: () => bridge.listHostBrowserPanelDownloads!(browserId),
    downloadCommand: (command: Parameters<NonNullable<NetcattyBridge['commandHostBrowserPanelDownload']>>[1]) =>
      bridge.commandHostBrowserPanelDownload!(browserId, command),
    subscribe: (callback: (event: HostBrowserPanelEvent) => void) => bridge.onHostBrowserPanelEvent?.((event) => {
      if (event.browserId === browserId) callback(event);
    }) ?? (() => {}),
  };
}

export async function readHostBrowserIcon(file: File): Promise<string> {
  if (!new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon']).has(file.type)
  ) throw new HostBrowserIconError('file-type');
  if (file.size > 5 * 1024 * 1024) throw new HostBrowserIconError('file-size');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new HostBrowserIconError('decode'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new HostBrowserIconError('decode'));
    element.src = source;
  });
  if (!image.naturalWidth || !image.naturalHeight) throw new HostBrowserIconError('decode');
  if (file.size <= 64 * 1024 && Math.max(image.naturalWidth, image.naturalHeight) <= 128) return source;
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 96 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new HostBrowserIconError('decode');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
