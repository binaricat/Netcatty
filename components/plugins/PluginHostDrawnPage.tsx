import { useHostDrawnPluginView } from '../../application/state/useHostDrawnPluginView';
import { PluginSettingsEntry } from './PluginSettingsEntry';
import { PluginRemoteSurface } from './PluginRemoteSurface';

export function PluginHostDrawnPage(props: Parameters<typeof useHostDrawnPluginView>[0] & { loadingLabel: string; pluginId: string }) {
  const view = useHostDrawnPluginView(props);
  if (!view.visible) return null;
  if (view.loading) return <p data-plugin-view-slot={props.slot.split(':')[0]} role="status" className="p-4 text-sm text-muted-foreground">{props.loadingLabel}</p>;
  return <div className="relative isolate h-full min-h-0 w-full flex-1" data-plugin-view-slot={props.slot.split(':')[0]}>
    <PluginRemoteSurface key={`${props.viewId}:${props.version}:${props.slot}`} tree={view.tree} css={view.css} settled={view.settled} loadImage={view.loadImage} onEvent={view.sendEvent} />
    <div className="absolute right-3 top-3 z-10" data-plugin-settings-entry="">
      <PluginSettingsEntry key={`${props.pluginId}:${props.version}`} pluginId={props.pluginId} />
    </div>
  </div>;
}
